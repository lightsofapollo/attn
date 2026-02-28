#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ATTN="target/debug/attn"
FIXTURES="tests/fixtures"
SCREENSHOT_DIR="/tmp/attn-e2e-screenshots"
SOCKET="$(dirname "$ATTN")/attn.sock"
PASS=0
FAIL=0

# --- Helpers ---

cleanup() {
    # Kill any attn daemon we started
    if [ -n "${ATTN_PID:-}" ] && kill -0 "$ATTN_PID" 2>/dev/null; then
        kill "$ATTN_PID" 2>/dev/null || true
        wait "$ATTN_PID" 2>/dev/null || true
    fi
    rm -f "$SOCKET"
}
trap cleanup EXIT

assert_contains() {
    local label="$1" actual="$2" expected="$3"
    if echo "$actual" | grep -qF "$expected"; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    expected to contain: $expected"
        echo "    actual: $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_eq() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    expected: $expected"
        echo "    actual: $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_truthy() {
    local label="$1" value="$2"
    if [ -n "$value" ] && [ "$value" != "null" ] && [ "$value" != "undefined" ] && [ "$value" != "false" ] && [ "$value" != "0" ] && [ "$value" != '""' ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label"
        echo "    got: $value"
        FAIL=$((FAIL + 1))
    fi
}

screenshot() {
    local name="$1"
    local path
    path=$("$ATTN" --screenshot 2>/dev/null)
    if [ -n "$path" ] && [ -f "$path" ]; then
        local dest="$SCREENSHOT_DIR/${name}.png"
        mv "$path" "$dest"
        echo "  screenshot: $dest"
    else
        echo "  screenshot: FAILED for $name"
    fi
}

wait_for_ready() {
    local max_attempts=100
    local attempt=0

    # Wait for socket to appear
    while [ ! -S "$SOCKET" ] && [ $attempt -lt $max_attempts ]; do
        sleep 0.1
        attempt=$((attempt + 1))
    done

    if [ ! -S "$SOCKET" ]; then
        echo "FATAL: socket never appeared at $SOCKET"
        exit 1
    fi

    # Wait for the sidebar (Svelte app mounted) using structured wait
    "$ATTN" --wait-for '[data-sidebar]' --timeout 10000 >/dev/null 2>&1 || {
        # Fallback: wait for __attn__ IPC bridge
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
    # Wait for socket to be cleaned up
    local attempt=0
    while [ -S "$SOCKET" ] && [ $attempt -lt 20 ]; do
        sleep 0.1
        attempt=$((attempt + 1))
    done
}

start_daemon() {
    local path="$1"
    kill_daemon
    "$ATTN" --no-fork "$path" &
    ATTN_PID=$!
    wait_for_ready
}

# --- Build ---

echo "==> Building attn..."
"$SCRIPT_DIR/build.sh" debug

if [ ! -f "$ATTN" ]; then
    echo "FATAL: binary not found at $ATTN"
    exit 1
fi

# Prepare screenshot directory
rm -rf "$SCREENSHOT_DIR"
mkdir -p "$SCREENSHOT_DIR"

# ===================================================================
# TEST SUITE 1: Single file mode
# ===================================================================

echo ""
echo "=== Test Suite 1: Single File Mode (basic.md) ==="
start_daemon "$FIXTURES/basic.md"

echo ""
echo "--- App Bootstrap ---"
result=$("$ATTN" --eval "typeof window.__attn__")
assert_eq "IPC bridge registered" "$result" '"object"'

result=$("$ATTN" --query '#app' 2>/dev/null | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "App mounted" "$result" "found"

screenshot "01-single-file-initial"

echo ""
echo "--- Content Rendering ---"
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "h1 rendered" "$result" "Project Status"

count=$("$ATTN" --query 'input[type="checkbox"]' | jq -r '.count' 2>/dev/null || echo "0")
assert_eq "4 checkboxes rendered" "$count" "4"

result=$("$ATTN" --query 'pre code' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Code block rendered" "$result" "found"

result=$("$ATTN" --query 'table' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Table rendered" "$result" "found"

result=$("$ATTN" --query 'blockquote' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Blockquote rendered" "$result" "found"

echo ""
echo "--- Theme ---"
result=$("$ATTN" --eval "document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-theme') || document.body.classList.contains('dark')")
assert_truthy "Theme applied" "$result"

screenshot "02-single-file-content"

# ===================================================================
# TEST SUITE 2: Directory mode
# ===================================================================

echo ""
echo "=== Test Suite 2: Directory Mode (fixtures/) ==="
start_daemon "$FIXTURES"

echo ""
echo "--- Sidebar ---"
result=$("$ATTN" --query '[data-sidebar="sidebar"]' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Sidebar present" "$result" "found"

screenshot "03-directory-initial"

# Check file count — sidebar uses data-sidebar="menu-button" for file entries
count=$("$ATTN" --query '[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]' | jq -r '.count' 2>/dev/null || echo "0")
assert_truthy "Sidebar shows files" "$count"

echo ""
echo "--- Auto-select First File ---"
# Wait for content to render after auto-selection
"$ATTN" --wait-for 'h1' --timeout 5000 >/dev/null 2>&1 || true
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text // "empty"' 2>/dev/null || echo "empty")
assert_truthy "Auto-selected first file has content" "$result"

screenshot "04-directory-with-content"

echo ""
echo "--- Navigate Between Files ---"
# Click basic.md in the sidebar
"$ATTN" --click 'text=basic.md'

# Wait for navigation to complete — h1 should contain "Project Status"
"$ATTN" --wait-for 'h1' --timeout 5000 >/dev/null 2>&1
# Give rendering a moment to settle after navigation
sleep 0.3
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "Navigate to basic.md" "$result" "Project Status"
screenshot "05-navigate-basic"

# Expand the nested folder if collapsed, then click child.md
"$ATTN" --eval "
    const trigger = document.querySelector('[data-sidebar=\"menu-button\"][data-state=\"closed\"]');
    if (trigger?.textContent?.trim() === 'nested') trigger.click();
" >/dev/null 2>&1
sleep 0.3

"$ATTN" --click '[data-sidebar="menu-sub-button"]' 2>/dev/null || true

# Wait for navigation to complete
"$ATTN" --wait-for 'h1' --timeout 5000 >/dev/null 2>&1
sleep 0.3
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "Navigate to nested child.md" "$result" "Nested Document"

# Verify breadcrumb shows nested path
result=$("$ATTN" --query '[class*="breadcrumb"], nav[aria-label]' | jq -r '.elements[0].text // ""' 2>/dev/null || echo "")
assert_contains "Breadcrumb shows nested path" "$result" "child.md"
screenshot "06-nested-file"

# ===================================================================
# Summary
# ===================================================================

echo ""
echo "=== E2E Test Summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  Screenshots: $SCREENSHOT_DIR/"
ls -1 "$SCREENSHOT_DIR/" 2>/dev/null | sed 's/^/    /'

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
