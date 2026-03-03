#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ATTN="target/debug/attn"
FIXTURES="tests/fixtures"
SCREENSHOT_DIR="$PROJECT_DIR/site/static/screenshots"
SOCKET="$(dirname "$ATTN")/attn.sock"

# --- Helpers ---

cleanup() {
    if [ -n "${ATTN_PID:-}" ] && kill -0 "$ATTN_PID" 2>/dev/null; then
        kill "$ATTN_PID" 2>/dev/null || true
        wait "$ATTN_PID" 2>/dev/null || true
    fi
    rm -f "$SOCKET"
}
trap cleanup EXIT

screenshot() {
    local name="$1"
    local path
    path=$("$ATTN" --screenshot 2>/dev/null)
    if [ -n "$path" ] && [ -f "$path" ]; then
        local dest="$SCREENSHOT_DIR/${name}.png"
        mv "$path" "$dest"
        echo "  saved: $dest"
    else
        echo "  FAILED: $name"
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
    shift
    kill_daemon
    "$ATTN" --no-fork "$@" "$path" &
    ATTN_PID=$!
    wait_for_ready
}

capture_sequence() {
    local suffix="$1"

    # Set window size
    "$ATTN" --eval "window.resizeTo(960, 720)" 2>/dev/null || true

    # --- Hero ---
    echo "==> Capturing hero-${suffix}..."
    "$ATTN" --click 'text=marketing.md'
    "$ATTN" --wait-for 'h1' --timeout 5000 >/dev/null 2>&1
    sleep 0.5
    screenshot "hero-${suffix}"

    # --- Editor ---
    echo "==> Capturing editor-${suffix}..."
    "$ATTN" --eval "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'e', metaKey: true, bubbles: true}))" >/dev/null 2>&1
    "$ATTN" --wait-for '.ProseMirror' --timeout 5000 >/dev/null 2>&1
    sleep 0.5
    screenshot "editor-${suffix}"

    # Close editor
    "$ATTN" --eval "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'e', metaKey: true, bubbles: true}))" >/dev/null 2>&1
    sleep 0.3

    # --- Checkboxes ---
    echo "==> Capturing checkboxes-${suffix}..."
    "$ATTN" --click 'text=basic.md'
    "$ATTN" --wait-for 'input[type="checkbox"]' --timeout 5000 >/dev/null 2>&1
    sleep 0.5
    screenshot "checkboxes-${suffix}"

    # --- Search / Command Palette ---
    echo "==> Capturing search-${suffix}..."
    "$ATTN" --eval "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', metaKey: true, bubbles: true}))" >/dev/null 2>&1
    "$ATTN" --wait-for '[data-command-input], [cmdk-input], input[placeholder]' --timeout 5000 >/dev/null 2>&1
    sleep 0.5
    screenshot "search-${suffix}"

    # Close palette
    "$ATTN" --eval "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))" >/dev/null 2>&1
    sleep 0.3

    # --- Code Block ---
    echo "==> Capturing code-${suffix}..."
    "$ATTN" --click 'text=marketing.md'
    "$ATTN" --wait-for 'pre code' --timeout 5000 >/dev/null 2>&1
    sleep 0.5
    screenshot "code-${suffix}"
}

# --- Build ---

echo "==> Building attn..."
"$SCRIPT_DIR/build.sh" debug

if [ ! -f "$ATTN" ]; then
    echo "FATAL: binary not found at $ATTN"
    exit 1
fi

mkdir -p "$SCREENSHOT_DIR"

# --- Light Mode ---

echo ""
echo "=== Light Mode ==="
start_daemon "$FIXTURES"
capture_sequence "light"

# --- Dark Mode ---

echo ""
echo "=== Dark Mode ==="
start_daemon "$FIXTURES" --dark
capture_sequence "dark"

# --- Done ---

echo ""
echo "=== Screenshots Complete ==="
echo "  Output: $SCREENSHOT_DIR/"
ls -1 "$SCREENSHOT_DIR/" 2>/dev/null | sed 's/^/    /'
