#!/usr/bin/env bash
# Snapshot blob-lane E2E — guards the large-file-share regression (2026-06-10):
# a ~100 KB markdown file produced a ~1 MB SnapshotCreated event envelope,
# which the relay rejected with 413 (HARD_MAX_EVENT_BYTES = 256 KiB). The
# poison envelope blocked the outbox — including WebRTC signaling — forever,
# so sharing silently never worked.
#
# The fix routes snapshot bytes through the `kind=snapshot_blob` lane
# (5 MiB cap): inline through the mailbox at ≤ 1 MiB sealed, R2 presign+PUT
# above. This script proves both lanes end-to-end against a real local relay:
#
#   #1  owner shares a folder with a mid-size doc (inline blob lane) and a
#       large doc (R2 spillover lane) — both publish without a 413
#   #2  the owner log shows one storage=Mailbox and one storage=R2 publish
#   #3  the reviewer (windowed daemon join) receives BOTH snapshots with
#       full markdown — blob → relay → reviewer → rehydration → frontend
#   #4  no "413"/"Payload Too Large" anywhere in either daemon log
#
# Every wait is a polled condition (per CLAUDE.md: never sleep on a condition).
# ATTN_SKIP_SNAPSHOT_BLOB_E2E=1 → clean skip (no relay/daemon infra).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_SNAPSHOT_BLOB_E2E:-0}" = "1" ]; then
    echo "test-snapshot-blob-e2e: ATTN_SKIP_SNAPSHOT_BLOB_E2E=1 — skipping (clean exit)"; exit 0
fi

: "${RELAY_PORT:=8801}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="${ATTN_EXTERNAL_RELAY:-http://localhost:${RELAY_PORT}}"
OWNER_HOME="/tmp/attn-blob-owner"; REV_HOME="/tmp/attn-blob-reviewer"
WORK="/tmp/attn-blob-work"; DOCS="$WORK/owner-docs"; REVLOCAL="$WORK/reviewer-local"
RELAY_LOG="$WORK/relay.log"; OWNER_LOG="$WORK/owner.log"; REV_LOG="$WORK/reviewer.log"
RELAY_PID=""; OWNER_PID=""; REV_PID=""; PASS=0; FAIL=0

log() { printf '\n==> %s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
info(){ printf '       %s\n' "$*"; }
attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rev()   { ATTN_HOME="$REV_HOME"   ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
ev_rev()   { attn_rev   --eval "$1" 2>/dev/null | sed 's/^"//; s/"$//'; }
poll() { local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
kill_pid() { local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }
cleanup() { log "Cleaning up"; kill_pid "$OWNER_PID"; kill_pid "$REV_PID"; if [ -n "$RELAY_PID" ]; then pkill -P "$RELAY_PID" 2>/dev/null || true; kill_pid "$RELAY_PID"; fi; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -x "$ATTN_BIN" ] || { log "Building attn"; cargo build || exit 1; }

json_decode() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)))}catch{process.stdout.write("")}})'; }

rm -rf "$OWNER_HOME" "$REV_HOME" "$WORK"
mkdir -p "$OWNER_HOME" "$REV_HOME" "$DOCS" "$REVLOCAL"

# Fixture shape mirrors the original failing file (GPU-CLI-OUTREACH-100.md):
# many short heading/paragraph blocks. The anchor index balloons the sealed
# snapshot ~20x for this block-dense shape, so: mid.md (~28 KB markdown →
# ~0.6 MiB sealed) rides the inline mailbox lane; big.md (~150 KB markdown →
# ~3 MiB sealed) crosses the 1 MiB threshold → R2 spillover lane.
gen_doc() { # gen_doc <path> <title> <blocks>
    local p="$1" t="$2" n="$3" i=1
    { printf '# %s\n\n' "$t"
      while [ "$i" -le "$n" ]; do
        printf '## Target %04d\n\n- handle: @dev_%04d\n- focus: GPU kernels, CLI tooling, outreach batch %d\n\nShort pitch paragraph for target %04d with enough words to look like the real outreach notes doc.\n\n' "$i" "$i" $((i % 7)) "$i"
        i=$((i+1))
      done
    } > "$p"
}
gen_doc "$DOCS/mid.md" "Mid outreach doc (inline blob lane)" 150
gen_doc "$DOCS/big.md" "Big outreach doc (R2 spillover lane)" 800
printf '# Reviewer Local Scratch\n' > "$REVLOCAL/mine.md"
info "mid.md: $(wc -c < "$DOCS/mid.md") bytes, big.md: $(wc -c < "$DOCS/big.md") bytes"

if [ -n "${ATTN_EXTERNAL_RELAY:-}" ]; then
    curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 || { log "external relay unreachable"; exit 1; }
else
    [ -d "$PROJECT_DIR/relay/node_modules" ] || (cd relay && npm ci >/dev/null)
    log "Starting relay on :$RELAY_PORT"
    ( cd "$PROJECT_DIR/relay" && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
    deadline=$(( $(date +%s) + 60 )); while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; kill -0 "$RELAY_PID" 2>/dev/null || { log "relay died"; tail -20 "$RELAY_LOG"; exit 1; }; sleep 0.3; done
fi
log "Relay healthy"

log "Owner daemon on owner-docs/mid.md; reviewer daemon on reviewer-local/mine.md"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$DOCS/mid.md" >"$OWNER_LOG" 2>&1 & OWNER_PID=$!
ATTN_HOME="$REV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$REVLOCAL/mine.md" >"$REV_LOG" 2>&1 & REV_PID=$!
poll 30000 attn_owner --wait-for 'h1' --timeout 1000 || { bad "owner never rendered"; tail -20 "$OWNER_LOG"; exit 1; }
poll 30000 attn_rev   --wait-for 'h1' --timeout 1000 || { bad "reviewer never rendered"; tail -20 "$REV_LOG"; exit 1; }

log "Owner: attn review share owner-docs/ (mid + big)"
attn_owner review share "$DOCS" 2>&1 | sed 's/^/    /'

# #1/#2 — both lanes published, visible in the owner daemon log
# (--no-fork logs to stdout, i.e. $OWNER_LOG, not $ATTN_HOME/attn.log).
mailbox_published() { grep -q "published snapshot.*storage=Mailbox" "$OWNER_LOG"; }
r2_published()      { grep -q "published snapshot.*storage=R2" "$OWNER_LOG"; }
if poll 60000 mailbox_published; then ok "#2 inline mailbox-lane snapshot published (mid.md)"; else bad "#2 no storage=Mailbox publish in owner log"; fi
if poll 60000 r2_published; then ok "#2 R2 spillover-lane snapshot published (big.md)"; else bad "#2 no storage=R2 publish in owner log"; fi

INVITE="$(attn_owner --eval 'window.__attn_review_store__?.currentShare?.inviteUrl || ""' 2>/dev/null | json_decode)"
[ -n "$INVITE" ] && ok "#1 owner minted an invite" || { bad "#1 no invite url on owner"; log "Result: $PASS passed, $FAIL failed"; exit 1; }

log "Reviewer: attn review join <invite> (windowed daemon)"
attn_rev review join "$INVITE" 2>&1 | sed 's/^/    /'

# #3 — the reviewer receives BOTH snapshots with full markdown bodies. The
# wire form never inlines plaintext, so non-empty markdown here proves the
# whole chain: snapshot_blob envelope (and the R2 fetch for big.md) →
# reviewer blob store → rehydration at the IPC boundary → frontend store.
rev_has_both() {
    local n
    n="$(ev_rev 'String((window.__attn_review_store__?.snapshots||[]).filter(s=>(s.markdown||"").length>10000).length)')"
    [ "$n" -ge 2 ] 2>/dev/null
}
if poll 60000 rev_has_both; then
    ok "#3 reviewer holds both snapshots with full markdown"
    info "sizes: $(ev_rev '(window.__attn_review_store__?.snapshots||[]).map(s=>(s.markdown||"").length).join(",")')"
else
    bad "#3 reviewer missing snapshot markdown"
    info "snapshots: $(ev_rev 'JSON.stringify((window.__attn_review_store__?.snapshots||[]).map(s=>({f:s.fileId,len:(s.markdown||"").length})))')"
    tail -20 "$REV_LOG" 2>/dev/null | sed 's/^/    rev: /'
fi

# #4 — the original failure signature must be gone from both daemons.
if grep -q -e "413" -e "Payload Too Large" "$OWNER_LOG" "$REV_LOG" 2>/dev/null; then
    bad "#4 a relay 413 appeared in a daemon log"
    grep -h -e "413" -e "Payload Too Large" "$OWNER_LOG" "$REV_LOG" | head -3 | sed 's/^/    /'
else
    ok "#4 no 413 / Payload Too Large in daemon logs"
fi

echo ""; log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
