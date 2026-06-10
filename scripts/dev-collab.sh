#!/usr/bin/env bash
# One-command local collab harness (attn-nnj.11.7).
#
# Boots the full local collaboration stack in a single terminal:
#
#   1. Miniflare relay (wrangler dev --local --port 8787)
#   2. Owner attn daemon — ATTN_HOME=/tmp/attn-collab-owner, opens a fixture
#   3. Reviewer attn daemon — ATTN_HOME=/tmp/attn-collab-reviewer, joins on cue
#
# Interactive flow:
#
#   $ task dev:collab
#   ==> Relay listening on http://localhost:8787 (health OK)
#   ==> Owner window opened (fixture: tests/fixtures/basic.md)
#   Click [Share] in the owner window and copy the invite URL.
#   Paste invite > attn://review/abc...#key=...
#   ==> Reviewer joining...
#   ==> Reviewer window opened
#
#   (Both daemons connected. Play with comments/suggestions across the
#    two windows. Ctrl+C cleans everything up.)
#
# Env overrides:
#   ATTN_RELAY_URL   default http://localhost:8787
#   FIXTURE_PATH     default tests/fixtures/basic.md
#   ATTN_BIN         default $REPO/target/debug/attn (built on demand)
#
# Cleanup: SIGINT (Ctrl+C) or exit triggers stop_dual + stop_relay so the
# relay process and both daemons exit cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${ATTN_RELAY_URL:=http://localhost:8787}"
: "${FIXTURE_PATH:=tests/fixtures/basic.md}"
# Reviewer opens a visually distinct fixture so the two identical windows can be
# told apart: share from the owner window (this fixture); the reviewer window
# switches to it on join.
: "${REVIEWER_FIXTURE_PATH:=tests/fixtures/typography.md}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"

# Pin the per-instance ATTN_HOMEs the task issue asks for, then forward
# them to scripts/lib/dual-instance.sh via its override knobs.
export ATTN_DUAL_OWNER="/tmp/attn-collab-owner"
export ATTN_DUAL_REVIEWER="/tmp/attn-collab-reviewer"
export ATTN_DUAL_FIXTURE="$PROJECT_DIR/$FIXTURE_PATH"
export ATTN_DUAL_REVIEWER_FIXTURE="$PROJECT_DIR/$REVIEWER_FIXTURE_PATH"
export ATTN_BIN
# Export the relay URL so the daemons booted by start_dual inherit it; without
# this they fall back to the scaffold stub and Share never reaches the relay.
export ATTN_RELAY_URL

# Relay process state.
RELAY_PID=""
RELAY_LOG="/tmp/attn-collab-relay.log"

# ---------- helpers ----------

log() {
    printf '==> %s\n' "$*"
}

err() {
    printf 'dev-collab: %s\n' "$*" >&2
}

require_bin() {
    if [ ! -x "$ATTN_BIN" ]; then
        log "attn binary missing at $ATTN_BIN — building (cargo build)"
        cargo build
    fi
    if [ ! -x "$ATTN_BIN" ]; then
        err "build did not produce $ATTN_BIN"
        exit 1
    fi
}

require_fixture() {
    if [ ! -f "$ATTN_DUAL_FIXTURE" ]; then
        err "fixture missing: $ATTN_DUAL_FIXTURE"
        err "pass FIXTURE_PATH=<file relative to repo> to override"
        exit 1
    fi
}

# Start Miniflare via the relay package. Installs deps on first run.
# Waits for /health to return 200 before returning.
start_relay() {
    if [ ! -d "$PROJECT_DIR/relay/node_modules" ]; then
        log "Installing relay deps (relay/npm ci)"
        (cd "$PROJECT_DIR/relay" && npm ci) >/dev/null
    fi

    log "Starting Miniflare relay (wrangler dev --local --port 8787)"
    (
        cd "$PROJECT_DIR/relay"
        exec npm run dev
    ) >"$RELAY_LOG" 2>&1 &
    RELAY_PID=$!

    # Poll /health up to 60s. wrangler can take a few seconds to bind on
    # cold start; 60s is generous but bounded so CI never hangs.
    local deadline=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if ! kill -0 "$RELAY_PID" 2>/dev/null; then
            err "relay process exited early — see $RELAY_LOG"
            tail -30 "$RELAY_LOG" >&2 || true
            return 1
        fi
        if curl -fsS "$ATTN_RELAY_URL/health" >/dev/null 2>&1; then
            log "Relay listening on $ATTN_RELAY_URL (health OK)"
            return 0
        fi
        sleep 0.3
    done
    err "relay /health never returned 200 within 60s — see $RELAY_LOG"
    tail -30 "$RELAY_LOG" >&2 || true
    return 1
}

stop_relay() {
    if [ -n "${RELAY_PID:-}" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
        kill "$RELAY_PID" 2>/dev/null || true
        # wrangler spawns child workers — sweep our process group so the
        # workerd subprocess doesn't keep the port bound after we exit.
        pkill -P "$RELAY_PID" 2>/dev/null || true
        local i=0
        while kill -0 "$RELAY_PID" 2>/dev/null && [ $i -lt 30 ]; do
            sleep 0.1
            i=$((i + 1))
        done
        if kill -0 "$RELAY_PID" 2>/dev/null; then
            kill -9 "$RELAY_PID" 2>/dev/null || true
        fi
        wait "$RELAY_PID" 2>/dev/null || true
    fi
    RELAY_PID=""
}

# Prompt the user for the invite URL printed by the owner's Share dialog,
# then drive `attn review join` against the reviewer DAEMON.
join_reviewer() {
    local invite=""
    if [ "${ATTN_COLLAB_NONINTERACTIVE:-0}" = "1" ]; then
        log "ATTN_COLLAB_NONINTERACTIVE=1 — skipping interactive join prompt"
        return 0
    fi

    log "Click [Share] in the OWNER window — the one showing '$FIXTURE_PATH'."
    log "(The reviewer window shows '$REVIEWER_FIXTURE_PATH' until it joins.) Copy the invite, then paste it here."
    log "(Empty line cancels and leaves the daemons running.)"
    printf 'Paste invite > '
    IFS= read -r invite || true
    if [ -z "$invite" ]; then
        log "No invite supplied — daemons remain up. Ctrl+C to stop."
        return 0
    fi

    log "Reviewer joining (windowed daemon)..."
    # Route the join to the already-running reviewer DAEMON via its ATTN_HOME
    # socket — deliberately NOT `--as-agent`, which forks a separate *headless*
    # agent process (no window, no UI) and leaves the reviewer window idle.
    # The daemon-routed join makes the reviewer's own window switch to the
    # shared document, which is the experience a human reviewer expects.
    if ATTN_HOME="$ATTN_DUAL_REVIEWER" ATTN_RELAY_URL="$ATTN_RELAY_URL" \
        "$ATTN_BIN" review join "$invite"; then
        log "Reviewer joined — both windows are now collaborating."
    else
        err "reviewer join failed — see daemon logs under $ATTN_DUAL_REVIEWER/"
    fi
}

# Guard against double-fire: SIGINT + EXIT would otherwise both invoke
# cleanup and the user sees three "Cleaning up..." lines.
__cleanup_ran=0
cleanup() {
    if [ "$__cleanup_ran" = "1" ]; then
        return 0
    fi
    __cleanup_ran=1
    log "Cleaning up..."
    stop_dual || true
    stop_relay || true
}

# ---------- main ----------

require_bin
require_fixture

# shellcheck source=scripts/lib/dual-instance.sh
source "$SCRIPT_DIR/lib/dual-instance.sh"

trap cleanup EXIT INT TERM

start_relay

# Warn if the two windows would be indistinguishable (e.g. FIXTURE_PATH was
# overridden to the reviewer's default) — the whole point is to tell them apart
# for the Share step.
if [ "$REVIEWER_FIXTURE_PATH" = "$FIXTURE_PATH" ]; then
    log "WARNING: owner and reviewer fixtures are identical ($FIXTURE_PATH) — the two windows will look the same. Set REVIEWER_FIXTURE_PATH to a different file to tell them apart."
fi

log "Booting owner + reviewer daemons (ATTN_HOME isolation)"
start_dual
wait_for_dual 'h1' 20000
log "Owner window opened — shows '$FIXTURE_PATH'; SHARE FROM THIS WINDOW. ATTN_HOME=$ATTN_DUAL_OWNER"
log "Reviewer window opened — shows '$REVIEWER_FIXTURE_PATH' until it joins, then switches to the owner's doc. ATTN_HOME=$ATTN_DUAL_REVIEWER"

join_reviewer

log "Daemons running. Ctrl+C to stop."
# Block on the relay process so Ctrl+C delivers SIGINT through to us and
# the trap fires. Waiting on the daemons would also work but the relay
# is the longest-lived process and the one we want to know about if it
# dies unexpectedly.
wait "$RELAY_PID" 2>/dev/null || true
