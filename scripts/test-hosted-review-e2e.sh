#!/usr/bin/env bash
# Native-owner -> hosted-browser Playwright E2E.
#
# By default this starts an isolated local relay, hosted Vite app, and native
# owner. Set E2E_RELAY_URL and E2E_WEB_ORIGIN together to run the same proof
# against an already-deployed staging environment. The owner shares a canary
# document; Chromium joins through the generated browser invite and verifies
# document rendering, fragment stripping, real PoW registration, no browser
# persistence, and content-blind HTTP/WebSocket wire.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELAY_PORT="${RELAY_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
RELAY_URL="${E2E_RELAY_URL:-http://127.0.0.1:${RELAY_PORT}}"
# Must match relay/wrangler.toml's staging browser-origin allowlist exactly.
# Vite still binds loopback-only below; this is the browser-visible origin.
WEB_ORIGIN="${E2E_WEB_ORIGIN:-http://localhost:${WEB_PORT}}"
ATTN_BIN="${ATTN_BIN:-$PROJECT_DIR/target/debug/attn}"
WORK="$(mktemp -d /tmp/attn-hosted-e2e.XXXXXX)"
ATTN_HOME="$WORK/owner-home"
SHARE_DIR="$WORK/shared"
DOC="$SHARE_DIR/hosted.md"
SIBLING_DOC="$SHARE_DIR/sibling.md"
RELAY_LOG="$WORK/relay.log"
WEB_LOG="$WORK/web.log"
OWNER_LOG="$WORK/owner.log"
RELAY_PID=""
WEB_PID=""
OWNER_PID=""

kill_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  kill_pid "$OWNER_PID"
  kill_pid "$WEB_PID"
  kill_pid "$RELAY_PID"
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1" deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

mkdir -p "$ATTN_HOME" "$SHARE_DIR"
printf '# Hosted review canary\n\n- [ ] Read-only browser task\n\nCiphertext boundary marker: NARWHAL-TEAK-7429.\n\nShared by native, rendered in the hosted reviewer.\n' >"$DOC"
printf '# Folder sibling canary\n\nSwitching files must switch decrypted document content.\n' >"$SIBLING_DOC"

if { [ -n "${E2E_RELAY_URL:-}" ] && [ -z "${E2E_WEB_ORIGIN:-}" ]; } ||
   { [ -z "${E2E_RELAY_URL:-}" ] && [ -n "${E2E_WEB_ORIGIN:-}" ]; }; then
  echo 'E2E_RELAY_URL and E2E_WEB_ORIGIN must be set together' >&2
  exit 1
fi

if [ ! -x "$ATTN_BIN" ]; then
  (cd "$PROJECT_DIR" && cargo build -p attn)
fi

if [ -z "${E2E_RELAY_URL:-}" ]; then
  (
    cd "$PROJECT_DIR/relay"
    exec npx wrangler dev --env staging --local --port "$RELAY_PORT" \
      --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
fi
wait_http "$RELAY_URL/health" || { tail -80 "$RELAY_LOG"; exit 1; }

if [ -z "${E2E_WEB_ORIGIN:-}" ]; then
  (
    cd "$PROJECT_DIR/web"
    VITE_ATTN_RELAY_URL="$RELAY_URL" exec npm run dev:browser -- --host 127.0.0.1 --port "$WEB_PORT"
  ) >"$WEB_LOG" 2>&1 &
  WEB_PID=$!
fi
wait_http "$WEB_ORIGIN" || { tail -80 "$WEB_LOG"; exit 1; }

ATTN_HOME="$ATTN_HOME" \
ATTN_RELAY_URL="$RELAY_URL" \
ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" \
  "$ATTN_BIN" --no-fork "$SHARE_DIR" >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --wait-for h1 --timeout 1000 >/dev/null 2>&1; then
    break
  fi
  kill -0 "$OWNER_PID" 2>/dev/null || { tail -80 "$OWNER_LOG"; exit 1; }
  sleep 0.2
done
ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --wait-for h1 --timeout 1000 >/dev/null
ATTN_HOME="$ATTN_HOME" ATTN_RELAY_URL="$RELAY_URL" \
ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" \
  "$ATTN_BIN" review share "$SHARE_DIR" >/dev/null

INVITE=""
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  raw="$(ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --eval 'window.__attn_review_store__?.currentShare?.browserInviteUrl || ""' 2>/dev/null || true)"
  INVITE="$(node -e 'const raw=process.argv[1]; try { process.stdout.write(JSON.parse(raw)); } catch {}' "$raw")"
  [ -n "$INVITE" ] && break
  sleep 0.2
done
[ -n "$INVITE" ] || { tail -80 "$OWNER_LOG"; tail -80 "$RELAY_LOG"; exit 1; }

SECRET="${INVITE#*#key=}"
ATTN_BROWSER_INVITE_URL="$INVITE" \
ATTN_ROOM_SECRET_CANARY="$SECRET" \
ATTN_EXPECTED_CANARY="NARWHAL-TEAK-7429" \
  npm --prefix "$PROJECT_DIR/web" run test:e2e:hosted

if [ -z "${E2E_RELAY_URL:-}" ] && grep -Fq 'NARWHAL-TEAK-7429' "$RELAY_LOG"; then
  echo 'hosted E2E failed: relay log contained plaintext canary' >&2
  exit 1
fi
if [ -z "${E2E_RELAY_URL:-}" ] && grep -Fq -- "$SECRET" "$RELAY_LOG"; then
  echo 'hosted E2E failed: relay log contained room secret' >&2
  exit 1
fi

echo 'hosted review E2E passed'
