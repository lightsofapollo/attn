# shellcheck shell=bash
# Dual-instance E2E harness for attn (owner + reviewer via ATTN_HOME).
#
# Sourceable shell library — do NOT execute directly. Provides helpers so a
# single host can boot two isolated attn daemons (one per simulated user) and
# drive them independently through the existing automation CLI (--click,
# --wait-for, --query, --eval, --fill, --info, --screenshot).
#
# Each helper prefixes the appropriate `ATTN_HOME=…` env var so the daemons
# never share a socket, fingerprint, log, or (future) review store.
#
# Usage:
#
#   source scripts/lib/dual-instance.sh
#   trap stop_dual EXIT
#   start_dual
#   wait_for_dual 'h1'
#   attn_owner    --click 'text=Suggest'
#   attn_reviewer --fill '.composer textarea' 'fix the typo'
#
# Environment overrides:
#   ATTN_DUAL_OWNER     runtime dir for the owner    (default /tmp/attn-dual-owner)
#   ATTN_DUAL_REVIEWER  runtime dir for the reviewer (default /tmp/attn-dual-reviewer)
#   ATTN_BIN            path to attn binary          (default $REPO/target/debug/attn)
#   ATTN_DUAL_FIXTURE   markdown fixture both daemons open
#                       (default tests/fixtures/review/scenario-comment-survives-edit.md)
#
# Functions exposed (all return non-zero on failure so callers can `set -e`):
#   attn_owner      — run attn against the owner daemon
#   attn_reviewer   — run attn against the reviewer daemon
#   start_dual      — boot owner + reviewer; stash PIDs in env
#   wait_for_dual   — block until both webviews respond to a selector
#   stop_dual       — kill both daemons, remove both ATTN_HOMEs

: "${ATTN_DUAL_OWNER:=/tmp/attn-dual-owner}"
: "${ATTN_DUAL_REVIEWER:=/tmp/attn-dual-reviewer}"

# Resolve repo root relative to this file so callers can source from anywhere.
__attn_dual_lib_dir() {
    local src="${BASH_SOURCE[0]:-${(%):-%x}}"
    cd "$(dirname "$src")/../.." && pwd
}

: "${ATTN_DUAL_REPO:=$(__attn_dual_lib_dir)}"
: "${ATTN_BIN:=$ATTN_DUAL_REPO/target/debug/attn}"
: "${ATTN_DUAL_FIXTURE:=$ATTN_DUAL_REPO/tests/fixtures/review/scenario-comment-survives-edit.md}"
# The reviewer can open a DIFFERENT fixture than the owner so the two windows
# are visually distinguishable until the reviewer joins (then it switches to the
# owner's shared doc). Defaults to the owner's fixture for backward compat.
: "${ATTN_DUAL_REVIEWER_FIXTURE:=$ATTN_DUAL_FIXTURE}"

# Stashed PIDs. Empty until start_dual sets them; cleared by stop_dual.
ATTN_DUAL_OWNER_PID=""
ATTN_DUAL_REVIEWER_PID=""

# ---------- internals ----------

__attn_dual_require_bin() {
    if [ ! -x "$ATTN_BIN" ]; then
        echo "dual-instance: attn binary missing at $ATTN_BIN" >&2
        echo "dual-instance: build it with 'cargo build' or set ATTN_BIN" >&2
        return 1
    fi
}

# Kill a PID gracefully (SIGTERM, wait, then SIGKILL if still alive).
__attn_dual_kill_pid() {
    local pid="$1"
    [ -z "$pid" ] && return 0
    kill -0 "$pid" 2>/dev/null || return 0
    kill "$pid" 2>/dev/null || true
    # Wait up to ~3s for graceful exit before escalating.
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do
        sleep 0.1
        i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
}

# Poll until $1's socket has a responsive webview, or $2 ms have elapsed.
__attn_dual_wait_one() {
    local home="$1" selector="$2" timeout_ms="${3:-10000}"
    local socket="$home/attn.sock"
    local deadline=$(( $(date +%s) * 1000 + timeout_ms ))

    while [ ! -S "$socket" ]; do
        if [ $(( $(date +%s) * 1000 )) -ge $deadline ]; then
            echo "dual-instance: socket never appeared at $socket" >&2
            return 1
        fi
        sleep 0.1
    done

    # --wait-for is the canonical readiness probe (matches test-review-e2e.sh).
    while [ $(( $(date +%s) * 1000 )) -lt $deadline ]; do
        if ATTN_HOME="$home" "$ATTN_BIN" --wait-for "$selector" --timeout 1000 \
                >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.2
    done
    echo "dual-instance: $home never rendered selector '$selector'" >&2
    return 1
}

# ---------- public API ----------

attn_owner() {
    ATTN_HOME="$ATTN_DUAL_OWNER" "$ATTN_BIN" "$@"
}

attn_reviewer() {
    ATTN_HOME="$ATTN_DUAL_REVIEWER" "$ATTN_BIN" "$@"
}

start_dual() {
    __attn_dual_require_bin || return 1

    if [ ! -f "$ATTN_DUAL_FIXTURE" ]; then
        echo "dual-instance: fixture missing at $ATTN_DUAL_FIXTURE" >&2
        return 1
    fi
    if [ ! -f "$ATTN_DUAL_REVIEWER_FIXTURE" ]; then
        echo "dual-instance: reviewer fixture missing at $ATTN_DUAL_REVIEWER_FIXTURE" >&2
        return 1
    fi

    # Wipe any leftover state from a previous (possibly crashed) run.
    rm -rf "$ATTN_DUAL_OWNER" "$ATTN_DUAL_REVIEWER"
    mkdir -p "$ATTN_DUAL_OWNER" "$ATTN_DUAL_REVIEWER"

    # Forward ATTN_RELAY_URL (if set) so the daemons attach the real relay
    # instead of the scaffold stub — Share/Join/collab flows need it. Empty is
    # treated as "unset" by the daemon, so this is safe when no relay is wanted.
    ATTN_HOME="$ATTN_DUAL_OWNER" ATTN_RELAY_URL="${ATTN_RELAY_URL:-}" "$ATTN_BIN" --no-fork "$ATTN_DUAL_FIXTURE" \
        >"$ATTN_DUAL_OWNER/daemon.stdout.log" 2>"$ATTN_DUAL_OWNER/daemon.stderr.log" &
    ATTN_DUAL_OWNER_PID=$!

    ATTN_HOME="$ATTN_DUAL_REVIEWER" ATTN_RELAY_URL="${ATTN_RELAY_URL:-}" "$ATTN_BIN" --no-fork "$ATTN_DUAL_REVIEWER_FIXTURE" \
        >"$ATTN_DUAL_REVIEWER/daemon.stdout.log" 2>"$ATTN_DUAL_REVIEWER/daemon.stderr.log" &
    ATTN_DUAL_REVIEWER_PID=$!
}

wait_for_dual() {
    local selector="${1:-h1}"
    local timeout_ms="${2:-10000}"
    __attn_dual_wait_one "$ATTN_DUAL_OWNER"    "$selector" "$timeout_ms" || return 1
    __attn_dual_wait_one "$ATTN_DUAL_REVIEWER" "$selector" "$timeout_ms" || return 1
}

stop_dual() {
    __attn_dual_kill_pid "${ATTN_DUAL_OWNER_PID:-}"
    __attn_dual_kill_pid "${ATTN_DUAL_REVIEWER_PID:-}"
    ATTN_DUAL_OWNER_PID=""
    ATTN_DUAL_REVIEWER_PID=""
    rm -rf "$ATTN_DUAL_OWNER" "$ATTN_DUAL_REVIEWER"
}
