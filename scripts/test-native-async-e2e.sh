#!/usr/bin/env bash
# macOS debug E2E for the complete away-owner loop. The app itself remains
# event-driven; bounded polling here is only test observation/timeouting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORK="$(mktemp -d /tmp/attn-native-async-e2e.XXXXXX)"
RELAY_PID=""

export ATTN_BIN="${ATTN_BIN:-$PROJECT_DIR/target/debug/attn}"
export ATTN_DUAL_OWNER="$WORK/owner-home"
export ATTN_DUAL_REVIEWER="$WORK/reviewer-home"
export ATTN_DUAL_FIXTURE="$WORK/owner.md"
export ATTN_DUAL_REVIEWER_FIXTURE="$WORK/reviewer.md"
export ATTN_DUAL_OWNER_RESIDENT=1
export ATTN_DUAL_OWNER_NOTIFICATION_LOG="$WORK/native-notifications.jsonl"

# shellcheck source=scripts/lib/dual-instance.sh
source "$SCRIPT_DIR/lib/dual-instance.sh"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'test-native-async-e2e: FAIL: %s\n' "$*" >&2; exit 1; }
poll() {
    local timeout_ms="$1"
    shift
    local deadline=$(( $(date +%s) * 1000 + timeout_ms ))
    while [ $(( $(date +%s) * 1000 )) -lt "$deadline" ]; do
        "$@" >/dev/null 2>&1 && return 0
        sleep 0.2
    done
    return 1
}
kill_relay() {
    [ -z "$RELAY_PID" ] && return 0
    pkill -P "$RELAY_PID" 2>/dev/null || true
    __attn_dual_kill_pid "$RELAY_PID"
}
cleanup() {
    if [ "${ATTN_KEEP_E2E_WORK:-0}" = "1" ]; then
        __attn_dual_kill_pid "${ATTN_DUAL_OWNER_PID:-}"
        __attn_dual_kill_pid "${ATTN_DUAL_REVIEWER_PID:-}"
    else
        stop_dual
    fi
    kill_relay
    if [ "${ATTN_KEEP_E2E_WORK:-0}" = "1" ]; then
        printf 'test-native-async-e2e: preserved artifacts at %s\n' "$WORK" >&2
    else
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT INT TERM

command -v jq >/dev/null || fail "jq is required"
command -v lsof >/dev/null || fail "lsof is required"
[ "$(uname -s)" = "Darwin" ] || fail "native notification E2E requires macOS"
[ -x "$ATTN_BIN" ] || { log "Building debug binary"; (cd "$PROJECT_DIR" && cargo build); }
[ -d "$PROJECT_DIR/relay/node_modules" ] || { log "Installing relay dependencies"; (cd "$PROJECT_DIR/relay" && npm ci); }

RELAY_PORT=""
for candidate in $(seq 8890 8990); do
    if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
        RELAY_PORT="$candidate"
        break
    fi
done
[ -n "$RELAY_PORT" ] || fail "no free relay port"
export ATTN_RELAY_URL="http://127.0.0.1:$RELAY_PORT"

printf '# Away owner\n\nDocument for asynchronous comments.\n' >"$WORK/shared.md"
printf '# Resident placeholder\n' >"$ATTN_DUAL_FIXTURE"
printf '# Reviewer local\n' >"$ATTN_DUAL_REVIEWER_FIXTURE"
: >"$ATTN_DUAL_OWNER_NOTIFICATION_LOG"

log "Starting local relay and a hidden resident owner"
mkdir -p "$WORK/relay-state"
(
    cd "$PROJECT_DIR/relay"
    exec npx wrangler dev --local --port "$RELAY_PORT" \
        --persist-to "$WORK/relay-state" \
        --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true \
        --var BLOB_CAP_SIGNING_KEY:local-native-async-e2e-key-32bytes
) >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
poll 60000 curl -fsS "$ATTN_RELAY_URL/health" || fail "relay never became healthy"
start_dual
wait_for_dual body 30000 || fail "dual instances did not render"
[ "$(attn_owner --eval 'document.visibilityState' | jq -r .)" = "hidden" ] \
    || fail "resident owner window was visible before the comment"

invite_for() {
    attn_owner --eval 'window.__attn_review_store__?.currentShare?.inviteUrl || ""' 2>/dev/null | jq -r .
}
invite_is_for() {
    local expected="$1" invite
    invite="$(invite_for)"
    [ "${invite#attn://review/$expected}" != "$invite" ]
}
reviewer_ready() {
    [ "$(attn_reviewer --eval 'String(Boolean(window.__attnPmView))' 2>/dev/null | jq -r .)" = "true" ]
}
reviewer_room_is() {
    local expected="$1"
    [ "$(attn_reviewer --eval 'window.__attn_review_store__?.currentRoomId || ""' 2>/dev/null | jq -r .)" = "$expected" ]
}
reviewer_room_hydrated() {
    local expected="$1"
    [ "$(attn_reviewer --eval "String(window.__attn_review_store__?.currentRoomId === '$expected' && window.__attn_review_store__?.events?.some(e => e.meta.roomId === '$expected' && e.body.type === 'snapshot_created'))" 2>/dev/null | jq -r .)" = "true" ]
}
submit_comment() {
    local room="$1" marker="$2"
    # Use the real tokenized reviewer IPC and the imported snapshot's exact
    # identifiers. This avoids editor-selection timing while still exercising
    # bootstrap signing, outbox/relay, owner verification, and import.
    attn_reviewer --eval "(function(){var s=window.__attn_review_store__;var e=s.events.find(e=>e.meta.roomId==='$room'&&e.body.type==='snapshot_created');if(!e)return 'no-snapshot';var b=e.body;window.ipc.postMessage(JSON.stringify({type:'review_create_comment',roomId:'$room',anchor:{v:2,fileId:b.fileId,snapshotId:b.snapshotId,baseHash:b.baseHash,position:{byteRange:[0,1],lineRange:[1,1]}},body:'$marker',token:window.__attn_ipc_token__}));return 'sent'})()" >/dev/null
}
notification_count_is() {
    [ "$(wc -l <"$ATTN_DUAL_OWNER_NOTIFICATION_LOG" | tr -d ' ')" -eq "$1" ]
}
owner_unread_is() {
    local room="$1" expected="$2"
    [ "$(attn_owner --eval "String(window.__attn_review_store__?.unreadByRoom?.['$room'] || 0)" 2>/dev/null | jq -r .)" -eq "$expected" ]
}
owner_imported() {
    grep -rqa "$1" "$ATTN_DUAL_OWNER/reviews" 2>/dev/null
}
restart_owner() {
    __attn_dual_kill_pid "$ATTN_DUAL_OWNER_PID"
    ATTN_DUAL_OWNER_PID=""
    rm -f "$ATTN_DUAL_OWNER/attn.sock"
    ATTN_HOME="$ATTN_DUAL_OWNER" ATTN_RELAY_URL="$ATTN_RELAY_URL" \
        ATTN_NOTIFICATION_TEST_LOG="$ATTN_DUAL_OWNER_NOTIFICATION_LOG" \
        "$ATTN_BIN" daemon --resident --no-fork \
        >"$ATTN_DUAL_OWNER/daemon.restart.stdout.log" 2>"$ATTN_DUAL_OWNER/daemon.restart.stderr.log" &
    ATTN_DUAL_OWNER_PID=$!
    __attn_dual_wait_one "$ATTN_DUAL_OWNER" body 30000
}

log "Creating a room and submitting a real reviewer comment burst"
attn_owner review share "$WORK/shared.md" >/dev/null
ROOM_ONE="$(find "$ATTN_DUAL_OWNER/reviews/rooms" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | head -n1)"
poll 30000 invite_is_for "$ROOM_ONE" || fail "room one invite was not exposed"
INVITE_ONE="$(invite_for)"
attn_reviewer review join "$INVITE_ONE" >/dev/null
poll 30000 reviewer_ready || fail "reviewer did not hydrate room one"
poll 30000 reviewer_room_is "$ROOM_ONE" || fail "reviewer did not select room one"
poll 30000 reviewer_room_hydrated "$ROOM_ONE" || fail "reviewer did not hydrate room one snapshot"
MARK_ONE="ASYNC-ROOM-ONE-$$"
submit_comment "$ROOM_ONE" "$MARK_ONE" || fail "could not submit room one comment"
poll 20000 owner_imported "$MARK_ONE" || fail "owner did not import room one comment"
MARK_TWO="ASYNC-ROOM-ONE-BURST-$$"
submit_comment "$ROOM_ONE" "$MARK_TWO" || fail "could not submit burst comment"
poll 20000 owner_imported "$MARK_TWO" || fail "owner did not import burst comment"

poll 30000 notification_count_is 1 || { cat "$ATTN_DUAL_OWNER_NOTIFICATION_LOG" >&2; cat "$ATTN_DUAL_OWNER/daemon.stderr.log" >&2; fail "expected one debounced native post for the burst"; }
jq -se --arg room "$ROOM_ONE" \
    'length == 1 and .[0].room_id == $room and (.[0].body | startswith("2 new comments")) and (.[0].body | contains("ASYNC-") | not)' \
    "$ATTN_DUAL_OWNER_NOTIFICATION_LOG" >/dev/null || fail "notification JSONL did not collapse safely"
poll 5000 owner_unread_is "$ROOM_ONE" 2 || fail "burst unread badge was not hydrated"

log "Injecting the exact native click route and clearing only the focused room"
DEEP_LINK_ONE="$(jq -r --arg room "$ROOM_ONE" 'select(.room_id == $room).deep_link' "$ATTN_DUAL_OWNER_NOTIFICATION_LOG")"
attn_owner --notification-click "$DEEP_LINK_ONE"
poll 10000 sh -c "[ \"\$(ATTN_HOME='$ATTN_DUAL_OWNER' '$ATTN_BIN' --eval 'window.__attn_review_store__?.currentRoomId || \"\"' 2>/dev/null | jq -r .)\" = '$ROOM_ONE' ]" \
    || fail "notification click did not select room one"
# Window-server visibility/focus callbacks are not granted reliably to an
# unsigned automation process. The click above exercises the native
# reveal/select branch; inject the focus callback the OS normally emits so
# Svelte's real view-state IPC and native clear path remain deterministic.
# Actual foreground appearance remains the one manual macOS spot-check.
attn_owner --eval "Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));'focused'" >/dev/null
poll 10000 owner_unread_is "$ROOM_ONE" 0 || fail "focused visible room did not clear unread"

log "Persisting a room mute and creating unread activity without an OS post"
attn_owner --eval "window.ipc.postMessage(JSON.stringify({type:'review_notification_mute',roomId:'$ROOM_ONE',muted:true,token:window.__attn_ipc_token__}));'sent'" >/dev/null
poll 5000 sh -c "jq -e '.muted == true' '$ATTN_DUAL_OWNER/reviews/rooms/$ROOM_ONE/notifications.json'" \
    || fail "room mute did not persist"
restart_owner || fail "resident owner did not return to hidden mode"
[ "$(attn_owner --eval 'document.visibilityState' | jq -r .)" = "hidden" ] \
    || fail "restarted resident owner window was visible"
: >"$ATTN_DUAL_OWNER_NOTIFICATION_LOG"
MARK_MUTED="ASYNC-MUTED-$$"
submit_comment "$ROOM_ONE" "$MARK_MUTED" || fail "could not submit muted comment"
poll 20000 owner_imported "$MARK_MUTED" || fail "owner did not import muted comment"
poll 5000 owner_unread_is "$ROOM_ONE" 1 || fail "muted import did not increment unread"
sleep 6
notification_count_is 0 || fail "muted room posted an OS notification"

log "Restarting resident owner and proving unread restore without replay"
: >"$ATTN_DUAL_OWNER_NOTIFICATION_LOG"
restart_owner || fail "resident owner did not restart"
poll 10000 owner_unread_is "$ROOM_ONE" 1 || fail "restart did not restore unread"
[ "$(attn_owner --eval "String(Boolean(window.__attn_review_store__?.notificationMutedByRoom?.['$ROOM_ONE']))" | jq -r .)" = "true" ] \
    || fail "restart did not restore persisted mute"
sleep 6
[ ! -s "$ATTN_DUAL_OWNER_NOTIFICATION_LOG" ] || fail "restart replayed historical OS notifications"

attn_owner --notification-click "attn://review/$ROOM_ONE"
attn_owner --eval "Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));'focused'" >/dev/null
poll 10000 owner_unread_is "$ROOM_ONE" 0 || fail "restart click did not focus and clear the room"

log "Native async resident E2E passed (signed UserNotifications appearance remains a manual macOS spot-check)"
