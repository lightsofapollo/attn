#!/usr/bin/env bash
# Permanent approval-gate E2E: two native instances exchange diff suggestions
# through a local Wrangler relay, then an event-driven verdict wait wakes only
# after the owner accepts one hunk and rejects the other.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORK="$(mktemp -d /tmp/attn-gate-e2e.XXXXXX)"
if [ -z "${RELAY_PORT:-}" ]; then
    command -v lsof >/dev/null || { echo "test-gate-e2e: lsof is required to select a relay port" >&2; exit 1; }
    for candidate in $(seq 8799 8899); do
        if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
            RELAY_PORT="$candidate"
            break
        fi
    done
fi
[ -n "${RELAY_PORT:-}" ] || { echo "test-gate-e2e: no free relay port in 8799-8899" >&2; exit 1; }
RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
RELAY_PID=""
WAIT_PID=""

export ATTN_BIN="${ATTN_BIN:-$PROJECT_DIR/target/debug/attn}"
export ATTN_DUAL_OWNER="$WORK/owner-home"
export ATTN_DUAL_REVIEWER="$WORK/reviewer-home"
export ATTN_RELAY_URL="$RELAY_URL"

# shellcheck source=scripts/lib/dual-instance.sh
source "$SCRIPT_DIR/lib/dual-instance.sh"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'test-gate-e2e: FAIL: %s\n' "$*" >&2; exit 1; }

kill_pid() {
    local pid="$1"
    [ -z "$pid" ] && return 0
    kill "$pid" 2>/dev/null || true
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
        sleep 0.1
        i=$((i + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    kill_pid "$WAIT_PID"
    stop_dual
    if [ -n "$RELAY_PID" ]; then
        pkill -P "$RELAY_PID" 2>/dev/null || true
        kill_pid "$RELAY_PID"
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

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

wait_relay() { kill -0 "$RELAY_PID" 2>/dev/null && curl -fsS "$RELAY_URL/health"; }
json_eval() {
    # --eval JSON-encodes its JS return value; unwrap the JSON.stringify layer.
    "$1" --eval "$2" 2>/dev/null | jq -r '.'
}
verdict_count_is() {
    local agent="$1" expected="$2" json count
    json="$(attn_reviewer review verdicts --json --as-agent "$agent")" || return 1
    count="$(jq '[.rooms[].suggestions[]] | length' <<<"$json")"
    [ "$count" -eq "$expected" ]
}
owner_has_two_suggestions() {
    [ "$(json_eval attn_owner "String(window.__attn_review_store__?.events.filter(e => e.body.type === 'suggestion_created').length || 0)")" -eq 2 ]
}
invite_ready() {
    INVITE="$(json_eval attn_owner 'window.__attn_review_store__?.currentShare?.inviteUrl || ""')"
    case "$INVITE" in attn://review/*) return 0;; *) return 1;; esac
}
canonical_sha256_base64url() {
    openssl dgst -sha256 -binary "$1" | base64 | tr '+/' '-_' | tr -d '=\r\n'
}

command -v jq >/dev/null || fail "jq is required"
command -v openssl >/dev/null || fail "openssl is required"
[ -x "$ATTN_BIN" ] || { log "Building attn"; (cd "$PROJECT_DIR" && cargo build); }
[ -d "$PROJECT_DIR/relay/node_modules" ] || { log "Installing relay dependencies"; (cd "$PROJECT_DIR/relay" && npm ci); }

log "Creating an isolated Git worktree and an exactly-two-hunk diff"
SEED="$WORK/git-seed"
DOC_WT="$WORK/document-worktree"
mkdir -p "$SEED"
git -C "$SEED" init -q
git -C "$SEED" config user.name "attn gate e2e"
git -C "$SEED" config user.email "gate-e2e@attn.invalid"
{
    printf '# Approval Gate\n\n'
    printf 'alpha original\n'
    for i in $(seq 1 12); do printf 'unchanged spacer %02d\n' "$i"; done
    printf 'omega original\n'
} >"$SEED/gate.md"
git -C "$SEED" add gate.md
git -C "$SEED" commit -qm "base gate document"
git -C "$SEED" worktree add -q -b gate-e2e "$DOC_WT"
DOC="$DOC_WT/gate.md"
REVIEWER_FIXTURE="$WORK/reviewer.md"
printf '# Reviewer Gate\n\nWaiting for shared document.\n' >"$REVIEWER_FIXTURE"
perl -0pi -e 's/alpha original/alpha accepted/' "$DOC"
perl -0pi -e 's/omega original/omega rejected/' "$DOC"
git -C "$DOC_WT" diff -- gate.md >"$WORK/two-hunks.diff"
[ "$(grep -c '^@@ ' "$WORK/two-hunks.diff")" -eq 2 ] || fail "fixture diff did not contain exactly two hunks"
git -C "$DOC_WT" restore -- gate.md

export ATTN_DUAL_FIXTURE="$DOC"
export ATTN_DUAL_REVIEWER_FIXTURE="$REVIEWER_FIXTURE"

log "Starting local Wrangler relay"
mkdir -p "$WORK/relay-state"
(
    cd "$PROJECT_DIR/relay"
    exec npx wrangler dev --local --port "$RELAY_PORT" \
        --persist-to "$WORK/relay-state" \
        --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true \
        --var BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes
) >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
poll 60000 wait_relay || { tail -80 "$WORK/relay.log" >&2; fail "relay never became healthy"; }

log "Starting owner and reviewer with the shared dual-instance harness"
start_dual
wait_for_dual h1 30000 || fail "dual instances did not render"

log "Sharing the owner document and joining from the reviewer daemon"
attn_owner review share "$DOC" >/dev/null
INVITE=""
poll 30000 invite_ready || fail "owner did not expose an invite"
attn_reviewer review join "$INVITE" >/dev/null
poll 30000 sh -c "ATTN_HOME='$ATTN_DUAL_REVIEWER' '$ATTN_BIN' --eval 'String(window.__attn_review_store__?.snapshots.length || 0)' 2>/dev/null | grep -Eq '[1-9]'" \
    || fail "reviewer did not receive the shared snapshot"
[ "$(json_eval attn_owner "String(typeof window.__attn_ipc_token__ === 'string' && window.__attn_ipc_token__.length > 0)")" = "true" ] \
    || fail "owner binary lacks the debug automation token required for privileged Accept/Reject IPC"

log "Aliasing reviewer identity as gate-agent and registering a distinct agent"
mkdir -p "$ATTN_DUAL_REVIEWER/agents/gate-agent"
cp "$ATTN_DUAL_REVIEWER/identity.json" "$ATTN_DUAL_REVIEWER/agents/gate-agent/identity.json"
attn_reviewer review register-agent distinct-agent >/dev/null

log "Submitting the two diff hunks as suggestions"
attn_reviewer review submit-suggestion --from-diff "$WORK/two-hunks.diff" >/dev/null
poll 30000 verdict_count_is gate-agent 2 || fail "gate-agent did not see both suggestions"
poll 30000 owner_has_two_suggestions || fail "owner did not import both suggestions"
verdict_count_is distinct-agent 0 || fail "distinct registered agent saw another identity's suggestions"

GATE_JSON="$(attn_reviewer review verdicts --json --as-agent gate-agent)"
ROOM_ID="$(jq -r '.rooms | keys[0]' <<<"$GATE_JSON")"
[ "$ROOM_ID" != "null" ] || fail "verdict report had no room"
EVENTS_JSON="$(json_eval attn_owner "JSON.stringify(window.__attn_review_store__.events.filter(e => e.body.type === 'suggestion_created').map(e => ({id:e.body.suggestionId,note:e.body.note})))")"
HUNK1_ID="$(jq -r '.[] | select(.note == "from diff hunk 1") | .id' <<<"$EVENTS_JSON")"
HUNK2_ID="$(jq -r '.[] | select(.note == "from diff hunk 2") | .id' <<<"$EVENTS_JSON")"
[ -n "$HUNK1_ID" ] && [ -n "$HUNK2_ID" ] || fail "could not map suggestion ids to diff hunks"

log "Asserting timeout is non-zero and stdout remains parseable pending JSON"
set +e
attn_reviewer review verdicts --json --wait --as-agent gate-agent --timeout 100ms \
    >"$WORK/timeout.json" 2>"$WORK/timeout.err"
TIMEOUT_RC=$?
set -e
[ "$TIMEOUT_RC" -ne 0 ] || fail "pending timeout unexpectedly exited zero"
jq -e '[.rooms[].suggestions[].status] | length == 2 and all(. == "pending")' "$WORK/timeout.json" >/dev/null \
    || fail "timeout stdout was not a two-pending partial report"

log "Starting one long event-driven verdict wait and proving it remains blocked"
(
    set +e
    attn_reviewer review verdicts --json --wait --as-agent gate-agent --timeout 60s >"$WORK/final.json" 2>"$WORK/final.err"
    printf '%s\n' "$?" >"$WORK/final.rc"
) &
WAIT_PID=$!
sleep 0.5
kill -0 "$WAIT_PID" 2>/dev/null || fail "verdict wait exited before any verdict"

log "Owner accepts hunk 1 and rejects hunk 2 through tokenized IPC"
attn_owner --eval "window.ipc.postMessage(JSON.stringify({type:'review_accept_suggestion',roomId:'$ROOM_ID',suggestionId:'$HUNK1_ID',token:window.__attn_ipc_token__}));'sent'" >/dev/null
attn_owner --eval "window.ipc.postMessage(JSON.stringify({type:'review_reject_suggestion',roomId:'$ROOM_ID',suggestionId:'$HUNK2_ID',reason:'gate e2e mixed verdict',token:window.__attn_ipc_token__}));'sent'" >/dev/null
wait "$WAIT_PID"
WAIT_PID=""

[ "$(cat "$WORK/final.rc")" -eq 0 ] || { cat "$WORK/final.err" >&2; fail "verdict wait did not exit zero"; }
EXPECTED_HASH="$(canonical_sha256_base64url "$DOC")"
jq -e --arg one "$HUNK1_ID" --arg two "$HUNK2_ID" --arg hash "$EXPECTED_HASH" \
    '.rooms[].suggestions as $s
     | ($s[$one].status == "accepted")
       and ($s[$one].resulting_hash == $hash)
       and ($s[$two].status == "rejected")' "$WORK/final.json" >/dev/null \
    || fail "final JSON was not mixed accepted/rejected with canonical owner-byte resultingHash"
grep -q '^alpha accepted$' "$DOC" || fail "accepted hunk was not applied on disk"
grep -q '^omega original$' "$DOC" || fail "rejected hunk changed owner bytes"

log "Gate E2E passed"
