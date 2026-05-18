#!/usr/bin/env bash
# Smoke test for scripts/lib/dual-instance.sh.
#
# Boots two isolated attn daemons (owner + reviewer) via ATTN_HOME, then
# asserts the harness "shape": both daemons addressable, --info / --query /
# --eval work against each, and the two runtime dirs stay isolated.
#
# Independent of relay / Miniflare — purely local. The dual-instance harness
# must work even before the WebRTC transport lands.
#
# Mirrors the PASS/PEND/FAIL counter pattern from scripts/test-review-e2e.sh.
# Exit code 0 when no FAILs, 1 otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Build the binary on demand — keeps the smoke test runnable from a clean tree.
if [ ! -x target/debug/attn ]; then
    echo "==> target/debug/attn missing — building..."
    cargo build 2>/dev/null || cargo build
fi

# shellcheck source=scripts/lib/dual-instance.sh
source "$SCRIPT_DIR/lib/dual-instance.sh"

PASS=0
FAIL=0
PEND=0

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

# Soft assertion for shape that may not have landed yet (kept for parity with
# 11.4 — currently unused but available if future smoke checks need it).
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

assert_nonzero_count() {
    local label="$1" json="$2"
    local count
    count=$(echo "$json" | jq -r '.count' 2>/dev/null || echo "0")
    if [ -n "$count" ] && [ "$count" != "null" ] && [ "$count" -gt 0 ] 2>/dev/null; then
        echo "  PASS: $label (count=$count)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    expected count > 0"
        echo "    actual json: $json"
        FAIL=$((FAIL + 1))
    fi
}

cleanup() {
    stop_dual || true
}
trap cleanup EXIT

echo "==> Dual-instance E2E smoke test"
echo "    owner    home: $ATTN_DUAL_OWNER"
echo "    reviewer home: $ATTN_DUAL_REVIEWER"
echo "    binary       : $ATTN_BIN"
echo "    fixture      : $ATTN_DUAL_FIXTURE"
echo ""

echo "--- Boot ---"
start_dual
wait_for_dual 'h1'
echo "  PASS: both daemons booted and rendered h1"
PASS=$((PASS + 1))

echo ""
echo "--- Daemons isolated to their ATTN_HOME ---"
# Each daemon's socket should live under its own ATTN_HOME — that's the whole
# point of the harness. Probe the filesystem directly rather than parsing
# --info (which reports only the binary path / pid / window id).
if [ -S "$ATTN_DUAL_OWNER/attn.sock" ]; then
    echo "  PASS: owner socket present at $ATTN_DUAL_OWNER/attn.sock"
    PASS=$((PASS + 1))
else
    echo "  FAIL: owner socket missing at $ATTN_DUAL_OWNER/attn.sock"
    FAIL=$((FAIL + 1))
fi
if [ -S "$ATTN_DUAL_REVIEWER/attn.sock" ]; then
    echo "  PASS: reviewer socket present at $ATTN_DUAL_REVIEWER/attn.sock"
    PASS=$((PASS + 1))
else
    echo "  FAIL: reviewer socket missing at $ATTN_DUAL_REVIEWER/attn.sock"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "--- --info reaches each daemon independently ---"
owner_info=$(attn_owner --info 2>&1 || echo "ERROR")
assert_contains "owner --info reports a pid" "$owner_info" "pid:"
reviewer_info=$(attn_reviewer --info 2>&1 || echo "ERROR")
assert_contains "reviewer --info reports a pid" "$reviewer_info" "pid:"

# Owner and reviewer must be *different* processes. Parse the pid: lines and
# compare — catches the regression where both helpers accidentally hit the
# same socket.
owner_pid=$(echo "$owner_info"    | awk -F': ' '/^pid:/ {print $2; exit}')
reviewer_pid=$(echo "$reviewer_info" | awk -F': ' '/^pid:/ {print $2; exit}')
if [ -n "$owner_pid" ] && [ -n "$reviewer_pid" ] && [ "$owner_pid" != "$reviewer_pid" ]; then
    echo "  PASS: owner pid ($owner_pid) != reviewer pid ($reviewer_pid)"
    PASS=$((PASS + 1))
else
    echo "  FAIL: pids overlap or empty (owner=$owner_pid reviewer=$reviewer_pid)"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "--- --query 'h1' returns non-zero count on each ---"
owner_h1=$(attn_owner --query 'h1' 2>/dev/null || echo "{}")
assert_nonzero_count "owner --query 'h1' count > 0" "$owner_h1"
reviewer_h1=$(attn_reviewer --query 'h1' 2>/dev/null || echo "{}")
assert_nonzero_count "reviewer --query 'h1' count > 0" "$reviewer_h1"

echo ""
echo "--- --eval window.__attn__ truthy on each ---"
owner_bridge=$(attn_owner --eval "typeof window.__attn__" 2>/dev/null || echo '"undefined"')
assert_eq "owner window.__attn__ is object" "$owner_bridge" '"object"'
reviewer_bridge=$(attn_reviewer --eval "typeof window.__attn__" 2>/dev/null || echo '"undefined"')
assert_eq "reviewer window.__attn__ is object" "$reviewer_bridge" '"object"'

echo ""
echo "=== Dual-instance smoke summary ==="
echo "  PASS: $PASS"
echo "  PEND: $PEND"
echo "  FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
