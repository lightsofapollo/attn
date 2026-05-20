#!/usr/bin/env bash
# WebRTC live_direct orchestrator E2E (2-party, owner ↔ one reviewer).
#
# Proves the per-room connection orchestrator negotiates a real WebRTC
# DataChannel THROUGH the relay's signaling channel (SDP/ICE), then flips the
# connection badge to "Live" — i.e. WebRTC is carrying the data plane and the
# relay is reduced to signaling + fallback. Co-typing must still converge.
#
# Every wait is a polled condition. Exit 0 iff all hard assertions pass.
# ATTN_SKIP_WEBRTC_E2E=1 → clean skip (no UDP/relay infra).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_WEBRTC_E2E:-0}" = "1" ]; then
    echo "test-webrtc-live-e2e: ATTN_SKIP_WEBRTC_E2E=1 — skipping (clean exit)"; exit 0
fi

: "${RELAY_PORT:=8791}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="http://localhost:${RELAY_PORT}"
OWNER_HOME="/tmp/attn-wrtc-owner"
RV_HOME="/tmp/attn-wrtc-rv"
WORK="/tmp/attn-wrtc-work"
SHARED_DOC="$WORK/shared-doc.md"
RELAY_LOG="$WORK/relay.log"
RELAY_PID=""; OWNER_PID=""; RV_PID=""
PASS=0; FAIL=0

log() { printf '==> %s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rv()    { ATTN_HOME="$RV_HOME"    ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }

poll() { local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
wait_ready() { poll "${3:-20000}" "$1" --wait-for "$2" --timeout 1000; }

kill_pid() { local p="$1"; [ -z "$p" ] && return 0; kill -0 "$p" 2>/dev/null || return 0; kill "$p" 2>/dev/null || true; local i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }
cleanup() { log "Cleaning up"; kill_pid "$OWNER_PID"; kill_pid "$RV_PID"; if [ -n "$RELAY_PID" ]; then pkill -P "$RELAY_PID" 2>/dev/null || true; kill_pid "$RELAY_PID"; fi; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -x "$ATTN_BIN" ] || { log "Building attn"; cargo build || exit 1; }
rm -rf "$OWNER_HOME" "$RV_HOME" "$WORK"; mkdir -p "$OWNER_HOME" "$RV_HOME" "$WORK"
printf '# WebRTC Live\n\nseed line\n' > "$SHARED_DOC"
printf '# rv placeholder\n' > "$WORK/rv.md"

[ -d "$PROJECT_DIR/relay/node_modules" ] || (cd relay && npm ci >/dev/null)
log "Starting relay on :$RELAY_PORT"
( cd "$PROJECT_DIR/relay" && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; kill -0 "$RELAY_PID" 2>/dev/null || { log "relay died"; tail -20 "$RELAY_LOG"; exit 1; }; sleep 0.3; done
log "Relay healthy"

log "Booting owner + reviewer daemons"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$SHARED_DOC" >"$WORK/owner.log" 2>&1 & OWNER_PID=$!
ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/rv.md" >"$WORK/rv.log" 2>&1 & RV_PID=$!
wait_ready attn_owner 'h1' 25000 || { log "owner never rendered"; exit 1; }
wait_ready attn_rv    'h1' 25000 || { log "rv never rendered"; exit 1; }

log "Owner shares (Cmd+Shift+S)"
attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1 || true
wait_ready attn_owner '[data-slot=share-invite-url]' 20000 || { log "no invite field"; exit 1; }
INVITE=""; deadline=$(( $(date +%s) + 15 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    INVITE="$(attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value||''" 2>/dev/null | tr -d '"\\' | tr -d '\r\n')"
    case "$INVITE" in attn://review/*) break;; esac; sleep 0.3
done
case "$INVITE" in attn://review/*) ok "owner minted invite";; *) bad "no invite ('$INVITE')"; exit 1;; esac

log "Reviewer joins (review_join IPC)"
attn_rv --eval "window.ipc && window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$INVITE'}));'x'" >/dev/null 2>&1 && ok "reviewer join dispatched" || bad "reviewer join failed"

# Presence converges (each sees 1 peer).
peer_count() { "$1" --query '[data-slot=peer-chip]' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0; }
has_peer() { [ "$(peer_count "$1")" -ge 1 ]; }
poll 25000 has_peer attn_owner && ok "owner sees a peer" || bad "owner sees no peer"

# The crux: the connection badge flips to live_direct → the orchestrator
# negotiated a DataChannel over the relay's signaling channel.
badge_state() { "$1" --eval "document.querySelector('[data-slot=connection-badge-chip]')?.getAttribute('data-state')||''" 2>/dev/null | tr -d '"'; }
owner_live() { [ "$(badge_state attn_owner)" = "live_direct" ]; }
rv_live()    { [ "$(badge_state attn_rv)" = "live_direct" ]; }
log "Waiting for the WebRTC DataChannel (badge → live_direct)"
if poll 40000 owner_live; then ok "owner badge = live_direct (DataChannel up)"; else bad "owner badge = '$(badge_state attn_owner)' (expected live_direct)"; fi
if poll 10000 rv_live;    then ok "reviewer badge = live_direct";            else bad "reviewer badge = '$(badge_state attn_rv)' (expected live_direct)"; fi

echo ""; log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
