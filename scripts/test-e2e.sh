#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ATTN="target/debug/attn"
FIXTURES="tests/fixtures"
SCREENSHOT_DIR="/tmp/attn-e2e-screenshots"

# Compute socket path matching Rust daemon's FNV-1a hash of the executable path
compute_socket_path() {
    local exe_path
    exe_path="$(cd "$PROJECT_DIR" && realpath "$ATTN")"
    local hash
    hash=$(python3 -c "
path = b'$exe_path'
h = 0xcbf29ce484222325
for b in path:
    h ^= b
    h = (h * 0x100000001b3) & 0xffffffffffffffff
print(f'{h:016x}')
")
    echo "/tmp/attn-${hash}/attn.sock"
}
SOCKET="$(compute_socket_path)"
PASS=0
FAIL=0

# --- Helpers ---

cleanup() {
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

# Poll `--eval` until it returns something truthy, or give up after ~4s.
# Defined up here rather than beside its first use so every suite can reach it.
poll_eval() {
    local js="$1"
    local tries=0
    local out=""
    while [ "$tries" -lt 40 ]; do
        out=$("$ATTN" --eval "$js" 2>/dev/null || echo "")
        case "$out" in
            ''|null|'""'|false|0) ;;
            *) echo "$out"; return 0 ;;
        esac
        sleep 0.1
        tries=$((tries + 1))
    done
    echo "$out"
}

# Wait for the document heading to actually BECOME `$1`.
#
# `--wait-for h1` cannot do this: an h1 from the previously-open document
# already satisfies it, so it returns instantly and whatever fixed sleep
# follows is racing the navigation. Losing that race made "Navigate to
# basic.md" read the previous file's heading (attn-537h).
wait_for_heading() {
    local expected="$1"
    poll_eval "(document.querySelector('h1')?.textContent || '').includes('$expected') ? 'yes' : null" >/dev/null
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

# Wait for the heading to become basic.md's, not merely for AN h1 to exist.
wait_for_heading "Project Status"
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "Navigate to basic.md" "$result" "Project Status"
screenshot "05-navigate-basic"

# Expand the `nested` folder if collapsed. All sidebar items currently
# render via `SidebarMenuButton` (data-sidebar="menu-button"), so we
# match the directory row by its data-path attribute and trigger it.
"$ATTN" --eval "
    const dir = Array.from(document.querySelectorAll('[data-sidebar=\"menu-button\"][data-path]'))
      .find((el) => /\/nested\$/.test(el.getAttribute('data-path') || ''));
    if (dir && dir.getAttribute('data-state') !== 'open') dir.click();
" >/dev/null 2>&1
sleep 0.3

# Click the nested file by name. The sidebar renders one button per file,
# and the row text contains the filename — `text=` matches text content.
"$ATTN" --click 'text=child.md'

wait_for_heading "Nested Document"
result=$("$ATTN" --query 'h1' | jq -r '.elements[0].text' 2>/dev/null || echo "")
assert_contains "Navigate to nested child.md" "$result" "Nested Document"

# The nested file is the one the app considers open.
#
# This replaces an assertion on a breadcrumb. The native app has no breadcrumb
# and has not had one for some time: `web/src/lib/PathBreadcrumb.svelte` is
# imported by nothing, and a live window reports zero matches for
# `[class*=breadcrumb]`, `nav[aria-label]` and `[data-slot*=breadcrumb]`. The
# old selector could only ever find nothing, so the case was asserting the
# absence of a control rather than any behaviour (attn-537h).
#
# What it was reaching for — "the app is showing the nested file" — is real and
# observable: the sidebar marks the open row `data-active="true"` and carries
# its full path in `data-path`.
# `--eval` hands back a JSON-encoded string, which escapes the separators —
# the path arrives as `...\/nested\/child.md`, so a bare `nested/child.md`
# never appears in it. Strip the escaping rather than assert on the escaped
# spelling, so the message still shows a readable path when this fails.
result=$(poll_eval "(() => {
    const row = document.querySelector('[data-path][data-active=\"true\"]');
    return row ? row.getAttribute('data-path') : null;
})()" | tr -d '\\')
assert_contains "Nested file is the active sidebar row" "$result" "nested/child.md"
screenshot "06-nested-file"

# ===================================================================
# TEST SUITE 3: Relative image resolution (attn-cgev)
# ===================================================================

echo ""
echo "=== Test Suite 3: Relative Images (images.md) ==="

# Poll a synchronous eval until it stops returning `null`/empty. `--eval` hands
# back whatever the expression evaluates to, JSON-encoded, and does NOT await a
# Promise — so waiting has to happen out here, not in the page.
start_daemon "$FIXTURES/images.md"

# Single-file mode, so directory ordering in tests/fixtures/ is irrelevant here.
"$ATTN" --wait-for '.attn-doc .md-image img' --timeout 5000 >/dev/null 2>&1

result=$("$ATTN" --query '.attn-doc .md-image img' | jq -r '.count' 2>/dev/null || echo "0")
assert_truthy "Image nodes rendered" "$result"

# The whole bug: a relative src used to reach the DOM verbatim and 404 against
# the app origin. It must now address the file through the attn:// handler.
result=$("$ATTN" --query '.attn-doc .md-image img' | jq -r '.elements[0].attributes.src' 2>/dev/null || echo "")
assert_contains "Relative src resolved through attn://" "$result" "attn://localhost/"
assert_contains "Resolved against the markdown file's own directory" "$result" "tests/fixtures/diagram.png"

# The authored src is what gets serialized back to disk, so it must survive.
# Read through --query rather than --eval: the webview JSON-escapes '/' in a
# returned string, which turns every path assertion into a slash-counting exercise.
result=$("$ATTN" --query '.attn-doc .md-image' | jq -r '.elements[0].attributes["data-src"]' 2>/dev/null || echo "")
assert_eq "Authored src preserved on the node" "$result" "./diagram.png"

# naturalWidth is not a DOM attribute, and decode is asynchronous.
result=$(poll_eval "Array.from(document.querySelectorAll('.attn-doc .md-image img')).filter((img) => img.complete && img.naturalWidth > 0).length")
assert_truthy "Local image bytes actually decoded (naturalWidth > 0)" "$result"

# Every local src in the fixture except the deliberate miss should decode: two
# PNGs (sibling, bare, subdirectory) plus the SVG, which carries explicit
# width/height so WebKit reports an intrinsic size for it.
result=$(poll_eval "(() => { const n = Array.from(document.querySelectorAll('.attn-doc .md-image img')).filter((img) => img.complete && img.naturalWidth > 0).length; return n >= 4 ? n : null; })()")
assert_eq "All four local assets decoded" "$result" "4"

# A missing file gets the document's own placeholder, not the platform glyph.
# Anchored on the deliberate miss by its authored src, NOT on "the first broken
# image": the remote https src in this fixture also fails (there is no network
# in the E2E environment), and which of the two reports `error` first is a race
# between a local 404 and a DNS timeout.
GONE='.attn-doc .md-image[data-src="./gone.png"]'
result=$(poll_eval "document.querySelector('$GONE[data-broken]')?.textContent")
assert_contains "Missing image shows the alt text" "$result" "A diagram that moved"
assert_contains "Missing image names the file" "$result" "gone.png"
assert_contains "Missing image is labelled, not left blank" "$result" "Image didn’t load"

# The card is announced as one thing, not three loose runs: the eyebrow, alt and
# filename are aria-hidden and the wrapper carries a single composed label.
result=$(poll_eval "document.querySelector('$GONE .md-image-fallback')?.getAttribute('aria-label')")
assert_contains "Missing image is announced as a single image role" "$result" "A diagram that moved"

# The selection ring and the drag handle both land on the NodeView's own
# element, so the wrapper has to hug the picture rather than span the measure.
result=$(poll_eval "(() => { const w = document.querySelector('.attn-doc .md-image[data-loaded]'); if (!w) return null; const img = w.querySelector('img'); return Math.abs(w.getBoundingClientRect().width - img.getBoundingClientRect().width) < 1 ? 'hugs' : 'spans'; })()")
# `--eval` hands back a JSON-encoded string, hence the contains form.
assert_contains "Image wrapper hugs the image, not the measure" "$result" "hugs"

# A remote src has no business being rewritten.
result=$("$ATTN" --query '.attn-doc .md-image[data-src^="https:"] img' | jq -r '.elements[0].attributes.src' 2>/dev/null || echo "")
assert_eq "Absolute URL passes through untouched" "$result" "https://example.com/pixel.png"

screenshot "07-relative-images"

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
