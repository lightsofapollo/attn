#!/usr/bin/env bash
# Capture REAL collaboration screenshots for the marketing site.
#
# Boots a 3-party live session (owner + two reviewers) against a local relay,
# stages a clean doc with both remote carets (amber owner + blue reviewer) and
# an inline suggestion, then screenshots a reviewer's window — so the shot shows
# two distinct labeled carets + the review card + the Live badge, exactly as a
# real session looks. Writes site/static/screenshots/collab-{light,dark}.png.
#
# Requires a debug build (--screenshot is debug+macOS only).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${RELAY_PORT:=8793}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="http://localhost:${RELAY_PORT}"
OWNER_HOME="/tmp/attn-cap-owner"; RVB_HOME="/tmp/attn-cap-rvB"; RVC_HOME="/tmp/attn-cap-rvC"
WORK="/tmp/attn-cap-work"; SHARED_DOC="$WORK/launch-plan.md"; RELAY_LOG="$WORK/relay.log"
OUT="$PROJECT_DIR/site/static/screenshots"
RELAY_PID=""; OWNER_PID=""; RVB_PID=""; RVC_PID=""

log(){ printf '==> %s\n' "$*"; }
attn_owner(){ ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rvB(){ ATTN_HOME="$RVB_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rvC(){ ATTN_HOME="$RVC_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
poll(){ local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
wait_ready(){ poll "${3:-25000}" "$1" --wait-for "$2" --timeout 1000; }
kill_pid(){ local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null||true; local i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 30 ];do sleep 0.1;i=$((i+1));done; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null||true; }
cleanup(){ log "cleanup"; kill_pid "$OWNER_PID"; kill_pid "$RVB_PID"; kill_pid "$RVC_PID"; [ -n "$RELAY_PID" ] && { pkill -P "$RELAY_PID" 2>/dev/null||true; kill_pid "$RELAY_PID"; }; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null||true; }
trap cleanup EXIT INT TERM

rm -rf "$OWNER_HOME" "$RVB_HOME" "$RVC_HOME" "$WORK"; mkdir -p "$OWNER_HOME" "$RVB_HOME" "$RVC_HOME" "$WORK" "$OUT"
cat > "$SHARED_DOC" <<'MD'
# Q3 Launch Plan

Ship the native viewer first, then open the review flow to a few teams.
Reviewers join from a link — no install required, end-to-end encrypted.

## Timeline

- Week 1 — internal dogfooding
- Week 2 — closed beta with design partners
- Week 3 — public launch on attn.sh
MD
# Reviewers open an EMPTY dir (no local markdown) so on join they render the
# owner's shared SNAPSHOT (isReviewerViewingSnapshot), not a local file.
mkdir -p "$WORK/empty-rvB" "$WORK/empty-rvC"

[ -d relay/node_modules ] || (cd relay && npm ci >/dev/null)
log "relay :$RELAY_PORT"
( cd relay && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
d=$(( $(date +%s)+60 )); while [ "$(date +%s)" -lt "$d" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; sleep 0.3; done

log "boot owner + 2 reviewers"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$SHARED_DOC" >"$WORK/owner.log" 2>&1 & OWNER_PID=$!
ATTN_HOME="$RVB_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/empty-rvB" >"$WORK/rvB.log" 2>&1 & RVB_PID=$!
ATTN_HOME="$RVC_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/empty-rvC" >"$WORK/rvC.log" 2>&1 & RVC_PID=$!
wait_ready attn_owner 'h1' || { log "owner not ready"; exit 1; }
wait_ready attn_rvB 'body' || { log "rvB not ready"; exit 1; }
wait_ready attn_rvC 'body' || { log "rvC not ready"; exit 1; }

log "share + join"
attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
wait_ready attn_owner '[data-slot=share-invite-url]' 20000 || { log "no invite"; exit 1; }
INVITE=""; d=$(( $(date +%s)+15 )); while [ "$(date +%s)" -lt "$d" ]; do INVITE="$(attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value||''" 2>/dev/null | tr -d '"\\' | tr -d '\r\n')"; case "$INVITE" in attn://review/*) break;; esac; sleep 0.3; done
attn_rvB --eval "window.ipc&&window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$INVITE'}));'x'" >/dev/null 2>&1
attn_rvC --eval "window.ipc&&window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$INVITE'}));'x'" >/dev/null 2>&1

# Wait for rvB to render the shared doc + see both peers.
peer_n(){ "$1" --query '[data-slot=peer-chip]' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null||echo 0; }
d=$(( $(date +%s)+30 )); while [ "$(date +%s)" -lt "$d" ]; do [ "$(peer_n attn_rvB)" -ge 2 ] && break; sleep 0.5; done
log "rvB sees $(peer_n attn_rvB) peers"
# Wait for rvB to render the owner's shared snapshot (the Q3 Launch Plan doc).
rvB_has_doc(){ [ -n "$(attn_rvB --eval "window.__attnPmView && window.__attnPmView.state.doc.textContent.includes('Launch Plan') ? 'y':''" 2>/dev/null | tr -d '"')" ]; }
d=$(( $(date +%s)+25 )); while [ "$(date +%s)" -lt "$d" ]; do rvB_has_doc && break; sleep 0.5; done
log "rvB shows shared doc: $(rvB_has_doc && echo yes || echo NO)"

# Stage carets: owner caret in para 1, rvC caret in the timeline — both broadcast
# to rvB's screen. setSelection on the live view triggers a cursor broadcast.
set_caret(){ "$1" --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var S=v.state.selection.constructor;var p=Math.min($2,v.state.doc.content.size-1);v.focus();v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,Math.max(1,p))));return 'ok';})()" >/dev/null 2>&1; }
set_caret attn_owner 45
set_caret attn_rvC 200
sleep 2

log "screenshot rvB (light)"
LIGHT=$(attn_rvB --screenshot 2>/dev/null | grep -oE '/tmp/attn-screenshot-[0-9]+\.png' | tail -1)
[ -n "$LIGHT" ] && cp "$LIGHT" "$OUT/collab-light.png" && log "wrote $OUT/collab-light.png" || log "FAILED light screenshot"

# Toggle dark theme on rvB, re-stage carets, screenshot dark.
attn_rvB --eval "document.documentElement.classList.add('dark'); localStorage.setItem('attn-theme','dark'); 'x'" >/dev/null 2>&1
sleep 1
set_caret attn_owner 45
set_caret attn_rvC 200
sleep 2
log "screenshot rvB (dark)"
DARK=$(attn_rvB --screenshot 2>/dev/null | grep -oE '/tmp/attn-screenshot-[0-9]+\.png' | tail -1)
[ -n "$DARK" ] && cp "$DARK" "$OUT/collab-dark.png" && log "wrote $OUT/collab-dark.png" || log "FAILED dark screenshot"

log "done"
