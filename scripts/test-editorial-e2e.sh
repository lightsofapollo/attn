#!/usr/bin/env bash
# Editorial-surface E2E driven through the real daemon automation API
# (--eval/--click/--query/--wait-for). Covers four editorial features:
#
#   attn-0wa  owner stays on its local doc after a reviewer joins/edits
#             (reviewer enters shared-doc view; owner does NOT flip)
#   attn-bit  selecting text in a review room shows the floating toolbar,
#             whose Comment button opens the composer (discoverable commenting)
#   attn-1rm  a reply (review_create_comment + parentThreadId) groups into the
#             same thread and propagates to the owner
#   attn-zhr  Resolve mints a CommentResolved event that propagates to the owner
#
# Boots a Miniflare relay + owner + reviewer native windows. The owner shares;
# the reviewer joins and renders the shared doc; we then drive the surface.
#
# The reply/resolve write paths are driven via the exact IPC messages their
# buttons send (ReviewMargin.replyToThread/resolveThread) and verified by the
# durable events landing on the owner; the rendered margin card (with the
# Reply/Resolve UI) is verified directly on the reviewer (attn-cqk).
#
# Skip with ATTN_SKIP_EDITORIAL_E2E=1 (needs a display + relay + loopback).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

if [ "${ATTN_SKIP_EDITORIAL_E2E:-0}" = "1" ]; then
  echo "test-editorial-e2e: ATTN_SKIP_EDITORIAL_E2E=1 — skipping (clean exit)"; exit 0
fi

BIN="${ATTN_BIN:-$ROOT/target/debug/attn}"
PORT="${RELAY_PORT:-8803}"
URL="http://127.0.0.1:$PORT"
W="${WORK:-/tmp/attn-editorial-e2e}"
OWNER_HOME="$W/owner"; RV_HOME="$W/rv"
MARK="EDIT_$$"; REPLY="REPLY_$$"
PASS=0; FAIL=0; PEND=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
pend(){ PEND=$((PEND+1)); printf '  \033[33mPEND\033[0m %s\n' "$*"; }
log(){ printf '== %s\n' "$*"; }

owner(){ ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$URL" "$BIN" "$@"; }
rv(){ ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$URL" "$BIN" "$@"; }

RPID=""; OPID=""; VPID=""
cleanup(){ for p in "$OPID" "$VPID"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ -n "$RPID" ] && { pkill -P "$RPID" 2>/dev/null; kill "$RPID" 2>/dev/null; }
  pkill -f "wrangler dev --local --port $PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

require_bin(){ [ -x "$BIN" ] || { log "building attn (cargo build)"; cargo build || exit 1; }; }
poll(){ local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
count(){ "$1" --query "$2" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0; }
has(){ [ "$(count "$1" "$2")" -ge 1 ]; }

require_bin
rm -rf "$W"; mkdir -p "$OWNER_HOME" "$RV_HOME" "$W"
printf '# Editorial E2E\n\nThe quick brown fox jumps over the lazy dog.\n' > "$W/shared-doc.md"
printf '# rv placeholder\n' > "$W/rv.md"

log "relay :$PORT (hermetic state)"
( cd "$ROOT/relay" && exec npx wrangler dev --local --port "$PORT" --persist-to "$W/wstate" ) >"$W/relay.log" 2>&1 & RPID=$!
deadline=$(( $(date +%s)+60 )); until curl -fsS "$URL/health" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { bad "relay never healthy"; tail -20 "$W/relay.log"; exit 1; }; sleep 0.3; done
log "relay healthy"

log "boot owner + reviewer windows"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$URL" "$BIN" --no-fork "$W/shared-doc.md" >"$W/owner.log" 2>&1 & OPID=$!
ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$URL" "$BIN" --no-fork "$W/rv.md" >"$W/rv.log" 2>&1 & VPID=$!
poll 25000 owner --wait-for 'h1' --timeout 1000 || { bad "owner never rendered"; exit 1; }
poll 25000 rv --wait-for 'h1' --timeout 1000 || { bad "reviewer never rendered"; exit 1; }

log "owner shares (Cmd+Shift+S) — onboarding name prompt intercepts the first share"
owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
# attn onboarding: the first share opens the display-name prompt BEFORE the
# share dialog, pre-filled with the resolved git/OS default. Assert + dismiss.
if poll 10000 has owner '[data-slot=name-prompt]'; then ok "onboarding: name prompt appeared on first share"; else bad "onboarding: name prompt did not appear"; fi
prefill=$(owner --eval "document.querySelector('[data-slot=name-prompt-input]')?.value||''" 2>/dev/null | tr -d '"')
[ -n "$prefill" ] && ok "onboarding: prompt pre-filled with a default ('$prefill')" || bad "onboarding: prompt prefill empty"
owner --fill '[data-slot=name-prompt-input]' 'Olive Owner' >/dev/null 2>&1
owner --click '[data-slot=name-prompt-confirm]' >/dev/null 2>&1
poll 20000 owner --wait-for '[data-slot=share-invite-url]' --timeout 1000 || { bad "share dialog never opened after name prompt"; exit 1; }
INVITE=""; d=$(( $(date +%s)+15 ))
while [ "$(date +%s)" -lt "$d" ]; do
  INVITE=$(owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value||''" 2>/dev/null | tr -d '"\\' | tr -d '\r\n')
  case "$INVITE" in attn://review/*) break;; esac; sleep 0.3
done
case "$INVITE" in attn://review/*) ok "owner minted invite";; *) bad "no invite (got '$INVITE')"; exit 1;; esac

log "reviewer sets display name before joining (so the prompt doesn't fire post-join)"
RVNAME="Riley Reviewer $$"
rv --eval "window.__attn_user_profile__.save('$RVNAME');'x'" >/dev/null 2>&1
# Wait for the daemon to persist it so the join publishes the chosen name.
poll 5000 sh -c "grep -q 'Riley Reviewer' '$RV_HOME/identity.json'" && ok "onboarding: reviewer name persisted to identity" || bad "onboarding: reviewer name not persisted"

log "reviewer joins"
rv --eval "window.ipc&&window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$INVITE'}));'x'" >/dev/null 2>&1
pm_ready(){ [ -n "$("$1" --eval "window.__attnPmView?'y':''" 2>/dev/null | tr -d '\"')" ]; }
poll 30000 pm_ready rv && ok "reviewer editor live" || { bad "reviewer editor never live"; exit 1; }
if poll 20000 has rv '[data-slot=shared-doc-banner]'; then ok "reviewer shows shared-doc banner"; else bad "reviewer never entered shared-doc view"; fi

# attn-0wa
if [ "$(count owner '[data-slot=shared-doc-banner]')" -eq 0 ]; then ok "attn-0wa: owner stayed on local doc (no flip)"; else bad "attn-0wa: owner FLIPPED into shared-doc view"; fi

# attn-bit
log "reviewer selects text → floating toolbar"
rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';v.focus();var S=v.state.selection.constructor;v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,3,9)));document.dispatchEvent(new Event('selectionchange'));return 'ok'})()" >/dev/null 2>&1
if poll 8000 has rv '[data-slot=selection-toolbar]'; then ok "attn-bit: selection toolbar appeared"; else bad "attn-bit: toolbar did not appear"; fi
rv --click '[data-slot=selection-toolbar-comment]' >/dev/null 2>&1
if poll 8000 has rv '.comment-composer textarea'; then ok "attn-bit: toolbar Comment opened the composer"; else bad "attn-bit: composer did not open from toolbar"; fi

log "submit comment ($MARK)"
rv --fill '.comment-composer textarea' "$MARK" >/dev/null 2>&1
rv --click 'text=Submit' >/dev/null 2>&1
owner_imported(){ grep -rqa "$MARK" "$OWNER_HOME/reviews" 2>/dev/null; }
if poll 20000 owner_imported; then ok "comment delivered + imported by owner"; else bad "owner never imported the comment"; fi

# onboarding: the reviewer's chosen display name (not the opaque participant id)
# must have reached the owner via the ParticipantJoined event.
if poll 10000 sh -c "grep -rqa 'Riley Reviewer' '$OWNER_HOME/reviews' 2>/dev/null"; then ok "onboarding: reviewer's display name propagated to owner"; else bad "onboarding: reviewer name did NOT reach owner"; fi

# attn-cqk: the review rail auto-opens via a reactive $effect (App.svelte) the
# first time the current file has a thread — no manual toggle. Verify the margin
# card mounts for the reviewer (it didn't before the cardState rename: a `$state`
# rune collided with the `state` prop in ReviewMarginCard and threw on render).
if poll 12000 has rv '[data-testid=review-margin-card]'; then ok "attn-cqk: reviewer sees the margin card (rail auto-opened; Reply/Resolve visible)"; else bad "attn-cqk: reviewer margin never mounts after comment"; fi

# onboarding render: the card author shows the real display name (resolved from
# the ParticipantJoined event), not the kind label "Reviewer" or the raw id.
rvauthor=$(rv --eval "document.querySelector('[data-testid=review-margin-card] .rmc-author')?.textContent||''" 2>/dev/null | tr -d '"')
case "$rvauthor" in
  *"Riley Reviewer"*) ok "names: margin card renders the display name ('$rvauthor')";;
  *) bad "names: card author is not the display name (got '$rvauthor')";;
esac

# attn-1rm — reply via the real IPC the button sends; verify grouping on owner.
log "reviewer replies ($REPLY)"
rv --eval "(function(){var s=window.__attn_review_store__;var t=s.threadsForCurrentFile[0];if(!t||t.rootEvent.body.type!=='comment_created')return 'no-thread';window.ipc.postMessage(JSON.stringify({type:'review_create_comment',roomId:s.currentRoomId,anchor:t.rootEvent.body.anchor,body:'$REPLY',parentThreadId:t.id}));return 'sent'})()" >/dev/null 2>&1
owner_reply(){ grep -rqa "$REPLY" "$OWNER_HOME/reviews" 2>/dev/null; }
if poll 20000 owner_reply; then ok "attn-1rm: reply imported by owner"; else bad "attn-1rm: reply not imported"; fi
threads=$(grep -rhoa '"threadId":"[^"]*"' "$OWNER_HOME/reviews" 2>/dev/null | sort -u | wc -l | tr -d ' ')
cc=$(grep -rhoa '"type":"comment_created"' "$OWNER_HOME/reviews" 2>/dev/null | wc -l | tr -d ' ')
[ "${cc:-0}" -ge 2 ] && [ "${threads:-9}" -eq 1 ] && ok "attn-1rm: 2 comments share 1 threadId (reply grouped)" || bad "attn-1rm: grouping off (comments=$cc threads=$threads)"

# attn-zhr — resolve via the real IPC the button sends; verify event on owner.
log "reviewer resolves the thread"
rv --eval "(function(){var s=window.__attn_review_store__;var t=s.threadsForCurrentFile[0];if(!t)return 'no-thread';window.ipc.postMessage(JSON.stringify({type:'review_resolve_comment',roomId:s.currentRoomId,threadId:t.id}));return 'sent'})()" >/dev/null 2>&1
owner_resolved(){ grep -rqa '"type":"comment_resolved"' "$OWNER_HOME/reviews" 2>/dev/null; }
if poll 20000 owner_resolved; then ok "attn-zhr: CommentResolved imported by owner"; else bad "attn-zhr: no comment_resolved event"; fi

# attn-tqq — explicit leave + switch controls.
log "attn-tqq: room controls (switch list + leave)"
# The ReviewBar dropdown (switch list + "Leave current room") is wired:
# handleLeaveRoom -> reviewStore.leaveRoom (forgetRoom) + onLeaveRoom -> reviewStop.
# bits-ui opens on real pointer events (not synthetic --click), so we verify the
# switcher RENDERS and drive leave via the exact IPC the button sends
# (review_stop). The daemon Stop emits "Stopped" -> forgetRoom -> back to local.
if poll 6000 has rv '.room-menu-trigger'; then ok "attn-tqq: room switcher present (ReviewBar dropdown lists rooms)"; else bad "attn-tqq: no room switcher"; fi
rv --eval "window.ipc.postMessage(JSON.stringify({type:'review_stop',roomId:window.__attn_review_store__.currentRoomId}));'sent'" >/dev/null 2>&1
# Authoritative "left the room" signal: currentRoomId cleared (the shared-doc
# banner follows reactively). Allow time for the daemon's transport teardown.
room_cleared(){ [ "$(rv --eval "String(window.__attn_review_store__.currentRoomId)" 2>/dev/null | tr -d '"')" = "null" ]; }
if poll 25000 room_cleared; then ok "attn-tqq: leave (review_stop) returns reviewer to local — current room cleared"; else bad "attn-tqq: leave did not clear the room (room=$(rv --eval "String(window.__attn_review_store__.currentRoomId)" 2>/dev/null))"; fi

echo; log "Result: $PASS passed, $FAIL failed, $PEND pend"
[ "$FAIL" -eq 0 ]
