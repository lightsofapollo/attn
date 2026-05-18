#!/usr/bin/env bash
# E2E test scaffolding for the review surfaces.
#
# Boots a daemon under an isolated ATTN_HOME, loads a scripted review fixture,
# and asserts the *shape* of the review IPC surface (bridge methods, layout
# slots, store scaffold). Behavioural assertions land as Phase 2/Phase 5
# features ship; today this script verifies that the seams exist and that the
# scaffolding does not regress.
#
# Exit code 0 when shape assertions pass (today's baseline). Soft-future
# assertions (review callbacks, review store) print "PEND" but do not fail —
# they flip to hard FAIL as the implementing issues (12.3, 12.10, etc.) land.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ATTN="target/debug/attn"
FIXTURES="tests/fixtures/review"
SCENARIO_MD="$FIXTURES/scenario-comment-survives-edit.md"
SCENARIO_JSON="$FIXTURES/scenario-comment-survives-edit.json"
SCREENSHOT_DIR="/tmp/attn-review-e2e-screenshots"

# Isolated runtime: ATTN_HOME directly replaces the daemon's runtime dir, so
# both socket and (future) review state live under this path. Lets the test
# run without touching the user's normal daemon state.
export ATTN_HOME="/tmp/attn-review-e2e"
SOCKET="$ATTN_HOME/attn.sock"

PASS=0
FAIL=0
PEND=0

# --- Helpers ---

cleanup() {
    if [ -n "${ATTN_PID:-}" ] && kill -0 "$ATTN_PID" 2>/dev/null; then
        kill "$ATTN_PID" 2>/dev/null || true
        wait "$ATTN_PID" 2>/dev/null || true
    fi
    rm -rf "$ATTN_HOME"
}
trap cleanup EXIT

assert_eq() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local label="$1" actual="$2" expected="$3"
    if echo "$actual" | grep -qF "$expected"; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    expected to contain: $expected"
        echo "    actual:              $actual"
        FAIL=$((FAIL + 1))
    fi
}

# Soft assertion for shape that hasn't landed yet. Prints PEND, does not
# increment FAIL. Flip to assert_eq once the implementing issue is merged.
expect_eq_soft() {
    local label="$1" actual="$2" expected="$3" tracking="$4"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  PEND: $label (waiting on $tracking)"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        PEND=$((PEND + 1))
    fi
}

screenshot() {
    local name="$1"
    local path
    path=$("$ATTN" --screenshot 2>/dev/null || echo "")
    if [ -n "$path" ] && [ -f "$path" ]; then
        local dest="$SCREENSHOT_DIR/${name}.png"
        mv "$path" "$dest"
        echo "  screenshot: $dest"
    else
        echo "  screenshot: skipped for $name"
    fi
}

wait_for_ready() {
    local max_attempts=100
    local attempt=0
    while [ ! -S "$SOCKET" ] && [ $attempt -lt $max_attempts ]; do
        sleep 0.1
        attempt=$((attempt + 1))
    done
    if [ ! -S "$SOCKET" ]; then
        echo "FATAL: socket never appeared at $SOCKET"
        exit 1
    fi

    "$ATTN" --wait-for '[data-sidebar]' --timeout 10000 >/dev/null 2>&1 || {
        attempt=0
        while [ $attempt -lt $max_attempts ]; do
            local result
            result=$("$ATTN" --eval "typeof window.__attn__" 2>/dev/null || echo "error")
            if [ "$result" = '"object"' ] || [ "$result" = 'object' ]; then
                sleep 0.3
                return 0
            fi
            sleep 0.2
            attempt=$((attempt + 1))
        done
        echo "WARNING: app may not be fully ready"
    }
}

kill_daemon() {
    if [ -n "${ATTN_PID:-}" ] && kill -0 "$ATTN_PID" 2>/dev/null; then
        kill "$ATTN_PID" 2>/dev/null || true
        wait "$ATTN_PID" 2>/dev/null || true
        ATTN_PID=""
    fi
    rm -f "$SOCKET"
    local attempt=0
    while [ -S "$SOCKET" ] && [ $attempt -lt 20 ]; do
        sleep 0.1
        attempt=$((attempt + 1))
    done
}

start_daemon() {
    local path="$1"
    kill_daemon
    # ATTN_HOME is exported above; the spawned daemon inherits it and resolves
    # its runtime dir (socket + future review state) under that path.
    "$ATTN" --no-fork "$path" &
    ATTN_PID=$!
    wait_for_ready
}

# --- Preflight ---

echo "==> Review E2E preflight"
if [ ! -f "$SCENARIO_MD" ]; then
    echo "FATAL: scenario markdown missing: $SCENARIO_MD"
    exit 1
fi
if [ ! -f "$SCENARIO_JSON" ]; then
    echo "FATAL: scenario IPC script missing: $SCENARIO_JSON"
    exit 1
fi

# Validate scenario JSON is parseable and has the expected envelope.
scenario_version=$(jq -r '.version' "$SCENARIO_JSON" 2>/dev/null || echo "")
assert_eq "Scenario JSON version=1" "$scenario_version" "1"
scenario_events_kind=$(jq -r '.events | type' "$SCENARIO_JSON" 2>/dev/null || echo "")
assert_eq "Scenario JSON .events is array" "$scenario_events_kind" "array"

# Ensure a clean runtime dir.
rm -rf "$ATTN_HOME"
mkdir -p "$ATTN_HOME"
rm -rf "$SCREENSHOT_DIR"
mkdir -p "$SCREENSHOT_DIR"

# --- Build ---

echo ""
echo "==> Building attn (debug)..."
"$SCRIPT_DIR/build.sh" debug

if [ ! -f "$ATTN" ]; then
    echo "FATAL: binary not found at $ATTN"
    exit 1
fi

# ===================================================================
# TEST SUITE: Review surface shape
# ===================================================================

echo ""
echo "=== Review E2E: shape assertions ==="
start_daemon "$SCENARIO_MD"

echo ""
echo "--- App Bootstrap ---"
result=$("$ATTN" --eval "typeof window.__attn__")
assert_eq "IPC bridge registered" "$result" '"object"'

result=$("$ATTN" --query '#app' 2>/dev/null | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "App mounted" "$result" "found"

echo ""
echo "--- Fixture content rendered ---"
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "Scenario h1 rendered" "$result" "Comment Survives Edit Scenario"

result=$("$ATTN" --query 'pre code' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Scenario code block rendered" "$result" "found"

screenshot "01-scenario-loaded"

echo ""
echo "--- Right-rail layout slot (from 12.1) ---"
result=$("$ATTN" --query '[data-slot="right-rail"]' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Right-rail slot present" "$result" "found"

# Default state: collapsed (no review session). Assert the data-state attribute
# is exposed so review-mode toggling can be observed by future tests.
result=$("$ATTN" --eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-state') ?? 'missing'")
assert_contains "Right-rail data-state attribute present" "$result" "closed"

echo ""
echo "--- Review callbacks on __attn__ (from 12.3, pending) ---"
# Each of the four review callbacks should be a function on window.__attn__.
# Today (pre-12.3) these are absent — recorded as PEND, not FAIL, so this
# scaffold lands ahead of the bridge work without blocking the merge.
for cb in reviewStatus reviewEvent reviewSnapshot reviewAnchorResolution; do
    result=$("$ATTN" --eval "typeof window.__attn__?.${cb}")
    expect_eq_soft "window.__attn__.${cb} is function" "$result" '"function"' "attn-nnj.12.3"
done

echo ""
echo "--- Review store scaffold (from 12.10, pending) ---"
# The review store module should be importable and expose a default shape.
# Today the module does not exist — record as PEND.
result=$("$ATTN" --eval "typeof window.__attn_review_store__")
expect_eq_soft "window.__attn_review_store__ exposed" "$result" '"object"' "attn-nnj.12.10"

screenshot "02-shape-asserted"

# ===================================================================
# Summary
# ===================================================================

echo ""
echo "=== Review E2E Summary ==="
echo "  PASS: $PASS"
echo "  PEND: $PEND   (shape not yet implemented; tracked via linked issues)"
echo "  FAIL: $FAIL"
echo "  Screenshots: $SCREENSHOT_DIR/"
ls -1 "$SCREENSHOT_DIR/" 2>/dev/null | sed 's/^/    /'

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
