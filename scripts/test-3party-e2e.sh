#!/usr/bin/env bash
# Three-party live collaboration E2E (the original goal: "3 different people
# collaborating on the same doc from a single author").
#
# Boots a clean local stack — Miniflare relay + one owner daemon + TWO reviewer
# daemons — then drives the *live UI* end to end:
#
#   1. Owner clicks [Share] → invite URL extracted from the DOM.
#   2. Both reviewers `review join` the room (as agents).
#   3. Presence: owner sees 2 peer chips; each reviewer sees 2 (owner + peer).
#   4. Co-typing: an owner edit reaches BOTH reviewers; a reviewer edit reaches
#      the owner AND the other reviewer (owner-as-authority OT fans out).
#   5. Remote carets: a reviewer's caret renders in the owner's editor.
#
# Every wait is a polled condition (never a blind sleep). Screenshots land in
# $SHOT_DIR for visual evidence. Exit 0 iff all hard assertions pass.
#
# Env overrides:
#   RELAY_PORT     default 8790
#   ATTN_BIN       default target/debug/attn (built on demand)
#   SHOT_DIR       default /tmp/attn-3party-screenshots
#   ATTN_SKIP_3PARTY_E2E=1   clean skip (no UDP/relay infra)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_3PARTY_E2E:-0}" = "1" ]; then
    echo "test-3party-e2e: ATTN_SKIP_3PARTY_E2E=1 — skipping (clean exit)"
    exit 0
fi

: "${RELAY_PORT:=8790}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
: "${SHOT_DIR:=/tmp/attn-3party-screenshots}"
RELAY_URL="http://localhost:${RELAY_PORT}"

OWNER_HOME="/tmp/attn-3p-owner"
RVB_HOME="/tmp/attn-3p-rvB"
RVC_HOME="/tmp/attn-3p-rvC"
WORK="/tmp/attn-3p-work"
SHARED_DOC="$WORK/shared-doc.md"

RELAY_LOG="$WORK/relay.log"
RELAY_PID=""
OWNER_PID=""
RVB_PID=""
RVC_PID=""

PASS=0
FAIL=0

log()  { printf '==> %s\n' "$*"; }
err()  { printf 'test-3party: %s\n' "$*" >&2; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# ---------- per-instance runners ----------
attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rvB()   { ATTN_HOME="$RVB_HOME"   ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rvC()   { ATTN_HOME="$RVC_HOME"   ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }

# ---------- generic polling (condition-wait, not blind sleep) ----------
# poll <timeout_ms> <cmd...> : run cmd until exit 0 or timeout.
poll() {
    local timeout_ms="$1"; shift
    local deadline=$(( $(date +%s) * 1000 + timeout_ms ))
    while [ "$(($(date +%s) * 1000))" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 0.25
    done
    return 1
}

# Block until $HOME's webview answers a selector.
wait_ready() { # <runner-fn> <selector> <timeout_ms>
    local runner="$1" selector="$2" timeout_ms="${3:-20000}"
    poll "$timeout_ms" "$runner" --wait-for "$selector" --timeout 1000
}

# ---------- lifecycle ----------
require_bin() {
    if [ ! -x "$ATTN_BIN" ]; then
        log "Building attn (cargo build)"
        cargo build || { err "build failed"; exit 1; }
    fi
}

start_relay() {
    if [ ! -d "$PROJECT_DIR/relay/node_modules" ]; then
        log "Installing relay deps (relay/npm ci)"
        (cd "$PROJECT_DIR/relay" && npm ci) >/dev/null
    fi
    log "Starting Miniflare relay on :$RELAY_PORT"
    (
        cd "$PROJECT_DIR/relay"
        exec npx wrangler dev --local --port "$RELAY_PORT"
    ) >"$RELAY_LOG" 2>&1 &
    RELAY_PID=$!
    local deadline=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if ! kill -0 "$RELAY_PID" 2>/dev/null; then
            err "relay exited early — see $RELAY_LOG"; tail -20 "$RELAY_LOG" >&2; return 1
        fi
        if curl -fsS "$RELAY_URL/health" >/dev/null 2>&1; then
            log "Relay healthy at $RELAY_URL"; return 0
        fi
        sleep 0.3
    done
    err "relay /health never came up — see $RELAY_LOG"; tail -20 "$RELAY_LOG" >&2; return 1
}

kill_pid() {
    local pid="$1"
    [ -z "$pid" ] && return 0
    kill -0 "$pid" 2>/dev/null || return 0
    kill "$pid" 2>/dev/null || true
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    log "Cleaning up"
    kill_pid "$OWNER_PID"; kill_pid "$RVB_PID"; kill_pid "$RVC_PID"
    if [ -n "$RELAY_PID" ]; then
        pkill -P "$RELAY_PID" 2>/dev/null || true
        kill_pid "$RELAY_PID"
    fi
    pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------- setup ----------
require_bin
rm -rf "$OWNER_HOME" "$RVB_HOME" "$RVC_HOME" "$WORK"
mkdir -p "$OWNER_HOME" "$RVB_HOME" "$RVC_HOME" "$WORK" "$SHOT_DIR"
printf '# 3-Party Live\n\nseed line\n' > "$SHARED_DOC"
printf '# rvB placeholder\n' > "$WORK/rvB.md"
printf '# rvC placeholder\n' > "$WORK/rvC.md"

start_relay || exit 1

log "Booting owner + 2 reviewer daemons"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$SHARED_DOC" \
    >"$WORK/owner.log" 2>&1 & OWNER_PID=$!
ATTN_HOME="$RVB_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/rvB.md" \
    >"$WORK/rvB.log" 2>&1 & RVB_PID=$!
ATTN_HOME="$RVC_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/rvC.md" \
    >"$WORK/rvC.log" 2>&1 & RVC_PID=$!

wait_ready attn_owner 'h1' 25000 || { err "owner never rendered"; exit 1; }
wait_ready attn_rvB   'h1' 25000 || { err "rvB never rendered"; exit 1; }
wait_ready attn_rvC   'h1' 25000 || { err "rvC never rendered"; exit 1; }
log "All three windows rendered"

# NOTE: a windowed reviewer joins as ITS OWN daemon identity via the
# `review_join` IPC (the same path the attn:// deep link drives). The
# `review join --as-agent` CLI is a one-shot headless agent join that exits
# without holding a connection — wrong path for a live window.

# ---------- Phase: Share ----------
# The ReviewBar [Share] button is hidden until a room exists (chicken-and-egg),
# so the real entry point is the Cmd+Shift+S global shortcut — dispatch it.
log "Owner: opening Share dialog (Cmd+Shift+S)"
attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'sent'" >/dev/null 2>&1 || true
wait_ready attn_owner '[data-slot=share-invite-url]' 20000 \
    || { err "share invite field never appeared"; cat "$WORK/owner.log" | tail -30 >&2; exit 1; }

# Poll until the hidden invite field carries a real attn:// URL.
read_invite() { attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value || ''" 2>/dev/null; }
INVITE=""
deadline=$(( $(date +%s) + 15 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    INVITE="$(read_invite | tr -d '"\\' | tr -d '\r\n' | sed 's/^ *//;s/ *$//')"
    case "$INVITE" in
        attn://review/*) break ;;
    esac
    sleep 0.3
done
case "$INVITE" in
    attn://review/*) ok "owner minted invite ($(printf '%s' "$INVITE" | cut -c1-32)…)" ;;
    *) bad "owner never produced an attn:// invite (got: '$INVITE')"; exit 1 ;;
esac

# ---------- Phase: Join ----------
# Drive the daemon's own `review_join` IPC (same as the attn:// deep link).
join_daemon() { # <runner-fn> <invite>
    "$1" --eval "window.ipc && window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$2'}));'sent'" >/dev/null 2>&1
}
log "rvB joining (review_join IPC, daemon identity)"
join_daemon attn_rvB "$INVITE" && ok "rvB review_join dispatched" || bad "rvB review_join eval failed"
log "rvC joining (review_join IPC, daemon identity)"
join_daemon attn_rvC "$INVITE" && ok "rvC review_join dispatched" || bad "rvC review_join eval failed"

# ---------- Phase: Presence ----------
peer_count() { # <runner-fn>
    "$1" --query '[data-slot=peer-chip]' 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("count",0))' 2>/dev/null || echo 0
}
has_n_peers() { [ "$(peer_count "$1")" -ge "$2" ]; }

log "Waiting for presence to converge (each party should see >=2 peers)"
if poll 25000 has_n_peers attn_owner 2; then ok "owner sees $(peer_count attn_owner) peer chips (>=2)"; else bad "owner peers=$(peer_count attn_owner) (<2)"; fi
if poll 25000 has_n_peers attn_rvB 2;   then ok "rvB sees $(peer_count attn_rvB) peer chips (>=2)";   else bad "rvB peers=$(peer_count attn_rvB) (<2)"; fi
if poll 25000 has_n_peers attn_rvC 2;   then ok "rvC sees $(peer_count attn_rvC) peer chips (>=2)";   else bad "rvC peers=$(peer_count attn_rvC) (<2)"; fi

# ---------- Phase: Co-typing ----------
pm_text() { "$1" --eval "window.__attnPmView ? window.__attnPmView.state.doc.textContent : ''" 2>/dev/null | tr -d '"'; }
pm_ready() { [ -n "$("$1" --eval "window.__attnPmView ? 'y' : ''" 2>/dev/null | tr -d '"')" ]; }
pm_insert() { # <runner-fn> <marker>
    "$1" --eval "(function(){var v=window.__attnPmView;if(!v)return 'no-view';v.focus();v.dispatch(v.state.tr.insertText('$2',1));return 'ok';})()" >/dev/null 2>&1
}
text_has() { pm_text "$1" | grep -q "$2"; }

log "Waiting for live editors on all parties"
poll 20000 pm_ready attn_owner && ok "owner editor live" || bad "owner editor never went live"
poll 20000 pm_ready attn_rvB   && ok "rvB editor live"   || bad "rvB editor never went live"
poll 20000 pm_ready attn_rvC   && ok "rvC editor live"   || bad "rvC editor never went live"

log "Owner types OWNERX → expect on both reviewers"
pm_insert attn_owner 'OWNERX'
if poll 20000 text_has attn_rvB 'OWNERX'; then ok "owner edit reached rvB"; else bad "owner edit never reached rvB"; fi
if poll 20000 text_has attn_rvC 'OWNERX'; then ok "owner edit reached rvC"; else bad "owner edit never reached rvC"; fi

log "rvB types RVBX → expect on owner AND rvC"
pm_insert attn_rvB 'RVBX'
if poll 20000 text_has attn_owner 'RVBX'; then ok "rvB edit reached owner"; else bad "rvB edit never reached owner"; fi
if poll 20000 text_has attn_rvC   'RVBX'; then ok "rvB edit reached rvC";   else bad "rvB edit never reached rvC"; fi

log "rvC types RVCX → expect on owner AND rvB"
pm_insert attn_rvC 'RVCX'
if poll 20000 text_has attn_owner 'RVCX'; then ok "rvC edit reached owner"; else bad "rvC edit never reached owner"; fi
if poll 20000 text_has attn_rvB   'RVCX'; then ok "rvC edit reached rvB";   else bad "rvC edit never reached rvB"; fi

# ---------- Phase: Remote carets ----------
caret_count() { "$1" --query '.attn-remote-caret' 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("count",0))' 2>/dev/null || echo 0; }
has_caret() { [ "$(caret_count "$1")" -ge 1 ]; }
log "Checking remote carets render (owner should see >=1 peer caret)"
if poll 15000 has_caret attn_owner; then ok "owner renders $(caret_count attn_owner) remote caret(s)"; else bad "owner shows no remote carets"; fi

# ---------- Phase: Editorial coexistence (comments alongside live co-typing) ----------
# Proves the review surface (comments) shares ONE view with live co-typing:
# rvB selects text in the SAME live editor, opens the comment composer, and
# submits — the owner must receive it while the live session is still up.
COMMENT_MARK="LIVECMT3PARTY"
log "rvB: opening comment composer on a live selection (Cmd+.)"
attn_rvB --eval "(function(){var v=window.__attnPmView;if(!v)return 'no-view';var S=v.state.selection.constructor;v.focus();v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,1,6)));return 'sel';})()" >/dev/null 2>&1
attn_rvB --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'.',code:'Period',metaKey:true,bubbles:true}));'sent'" >/dev/null 2>&1
if wait_ready attn_rvB '.comment-composer textarea' 8000; then
    ok "comment composer opened over the live editor"
    attn_rvB --fill '.comment-composer textarea' "$COMMENT_MARK" >/dev/null 2>&1
    attn_rvB --click 'text=Submit' >/dev/null 2>&1
    owner_saw_comment() { grep -q "$COMMENT_MARK" "$WORK/owner.log"; }
    if poll 20000 owner_saw_comment; then ok "owner received rvB's comment during the live session"; else bad "owner never received the live comment"; fi
else
    bad "comment composer did not open (editorial may be gated by collab)"
fi

# NOTE: a "departed peer's caret clears" E2E phase belongs here, but it is
# currently blocked by a separate defect: an owner snapshot republish
# mid-session rebuilds the reviewer's collab controller and wipes all
# remote-cursor state, so the assertion can't isolate the leave path. The
# leave logic itself (CollabController.removeCursorsForDevice) is covered by
# collab-controller.test.ts. Re-add this phase once that churn defect is fixed.

# ---------- Evidence ----------
log "Capturing screenshots → $SHOT_DIR"
attn_owner --screenshot >/dev/null 2>&1 && cp "$OWNER_HOME"/screenshot*.png "$SHOT_DIR/owner.png" 2>/dev/null || true
attn_rvB   --screenshot >/dev/null 2>&1 || true
attn_rvC   --screenshot >/dev/null 2>&1 || true

# ---------- Summary ----------
echo ""
log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
