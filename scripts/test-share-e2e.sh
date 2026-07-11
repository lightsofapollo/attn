#!/usr/bin/env bash
# Durable share v3 lifecycle gate. The Miniflare test drives the real Worker,
# ShareDO, RoomDO, R2 and WebSocket boundaries with isolated short-lived state;
# the adjacent focused suites bind that wire lifecycle to the native owner and
# browser visitor implementations. No fixed sleep is used.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_SHARE_E2E:-0}" = "1" ]; then
  echo "test-share-e2e: ATTN_SKIP_SHARE_E2E=1 — skipping (clean exit)"
  exit 0
fi

run() {
  printf '\n==> %s\n' "$1"
  shift
  "$@"
}

poll_file() {
  local label="$1" path="$2" deadline=$((SECONDS + 45))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ -f "$path" ] && return 0
    sleep 0.05
  done
  echo "timed out waiting for $label ($path)" >&2
  return 1
}

# Cross-language production boundary: a real wrangler relay stays alive while
# a native owner process, a production browser session, and a restarted native
# owner take turns against the same RoomDO/ShareDO/R2 state.
: "${RELAY_PORT:=8817}"
REAL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/attn-share-v3-e2e.XXXXXX")"
REAL_STATE="$REAL_ROOT/state.json"
REAL_DOC="$REAL_ROOT/owner.md"
RELAY_LOG="$REAL_ROOT/relay.log"
BROWSER_LOG="$REAL_ROOT/browser.log"
BROWSER_READY="$REAL_ROOT/browser-ready"
BROWSER_UPGRADED="$REAL_ROOT/browser-upgraded"
REVOKED="$REAL_ROOT/revoked"
RELAY_PID=""
BROWSER_PID=""
cleanup() {
  if [ -n "$BROWSER_PID" ]; then kill "$BROWSER_PID" 2>/dev/null || true; wait "$BROWSER_PID" 2>/dev/null || true; fi
  if [ -n "$RELAY_PID" ]; then kill "$RELAY_PID" 2>/dev/null || true; wait "$RELAY_PID" 2>/dev/null || true; fi
  rm -rf "$REAL_ROOT"
}
trap cleanup EXIT INT TERM

printf '# Durable native snapshot\n\nCross-boundary retained content.\n' > "$REAL_DOC"
(cd relay && exec npx wrangler dev --local --port "$RELAY_PORT" \
  --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true \
  --var QUOTA_IP_HASH_KEY:share-e2e-quota-key-material-32 \
  --var BLOB_CAP_SIGNING_KEY:share-e2e-blob-key-material-32) >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!
RELAY_URL="http://127.0.0.1:$RELAY_PORT"
deadline=$((SECONDS + 60))
until curl -fsS "$RELAY_URL/health" >/dev/null 2>&1; do
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then tail -80 "$RELAY_LOG" >&2; exit 1; fi
  if [ "$SECONDS" -ge "$deadline" ]; then tail -80 "$RELAY_LOG" >&2; exit 1; fi
  sleep 0.1
done

cargo_phase() {
  env ATTN_SHARE_E2E_PHASE="$1" ATTN_SHARE_E2E_ROOT="$REAL_ROOT/native" \
    ATTN_SHARE_E2E_STATE="$REAL_STATE" ATTN_SHARE_E2E_DOCUMENT="$REAL_DOC" \
    ATTN_RELAY_URL="$RELAY_URL" \
    cargo test --test durable_share_native_e2e durable_share_native_real_stack_phase -- --ignored --exact --nocapture
}

run "Production native owner creates actual RoomDO + ShareDO + retained snapshot" cargo_phase create
run "Production browser parses stable link, decrypts native snapshot, and joins live" \
  env ATTN_SHARE_BROWSER_PHASE=live ATTN_SHARE_E2E_STATE="$REAL_STATE" ATTN_RELAY_URL="$RELAY_URL" \
  npm --prefix web exec -- tsx web/scripts/test-durable-share-real-stack.ts
run "Native owner authentication destroys the actual ephemeral RoomDO only" cargo_phase destroy_room

env ATTN_SHARE_BROWSER_PHASE=offline_watch ATTN_SHARE_E2E_STATE="$REAL_STATE" ATTN_RELAY_URL="$RELAY_URL" \
  ATTN_SHARE_E2E_BROWSER_READY="$BROWSER_READY" ATTN_SHARE_E2E_BROWSER_UPGRADED="$BROWSER_UPGRADED" \
  ATTN_SHARE_E2E_REVOKED="$REVOKED" \
  npm --prefix web exec -- tsx web/scripts/test-durable-share-real-stack.ts >"$BROWSER_LOG" 2>&1 &
BROWSER_PID=$!
poll_file "production browser mailbox ACK" "$BROWSER_READY" || { cat "$BROWSER_LOG" >&2; exit 1; }
run "Restarted production owner recreates same epoch, imports ReviewStore events, republishes, then ACKs" cargo_phase restart
poll_file "existing browser watch live upgrade" "$BROWSER_UPGRADED" || { cat "$BROWSER_LOG" >&2; exit 1; }
run "Production owner revokes stable share immediately" cargo_phase revoke
touch "$REVOKED"
if ! wait "$BROWSER_PID"; then cat "$BROWSER_LOG" >&2; exit 1; fi
BROWSER_PID=""
cat "$BROWSER_LOG"

run "Supplemental deterministic relay lifecycle fault matrix" \
  npm --prefix relay test -- --run test/integration/share-lifecycle-e2e.test.ts

run "Browser durable resolve, snapshot, mailbox, watch, and no-reload upgrade" \
  npm --prefix web exec -- tsx web/src/lib/review/browser-share-production.test.ts
run "Browser durable rollback, outbox, and live transition state machine" \
  npm --prefix web exec -- tsx web/src/lib/review/browser-share-session.test.ts
run "Browser/native stable-link and sealed-bundle compatibility" \
  npm --prefix web exec -- tsx web/src/lib/review/browser-share.test.ts

run "Native owner create, restart, drain/ACK, renewal, rotation, and revoke" \
  cargo test review::share_lifecycle::tests --lib -- --nocapture

run "Relay protocol conformance corpus" \
  npm --prefix relay test -- --run test/conformance/replay.test.ts

printf '\nRESULT: durable share v3 lifecycle passed\n'
