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
echo "--- Review store scaffold ---"
# The review store singleton is exposed for E2E seeding (App.svelte wires
# `window.__attn_review_store__` on mount). Hard assertion — the adaptive
# rail suite below depends on it.
result=$("$ATTN" --eval "typeof window.__attn_review_store__")
assert_eq "window.__attn_review_store__ exposed" "$result" '"object"'

screenshot "02-shape-asserted"

# ===================================================================
# TEST SUITE: End-to-end apply flow (attn-nnj.8.6)
# ===================================================================
#
# The Rust-side E2E pipeline (snapshot + UserEdit drift -> resolve_suggestion
# REMAP -> apply_ready_verdict -> LocalRevision -> outbox envelope) is locked
# down by `cargo test review::apply::tests::e2e_*` (also runnable via
# `scripts/test-apply-e2e.sh`). The suite below exercises the *same* path
# through the running daemon's IPC bridge so a regression in the wiring
# surfaces before users see it.
#
# Every assertion here is PEND today — `ReviewManager::AcceptSuggestion` is
# a stub at the time this suite lands (see src/review/manager.rs ~957). The
# assertions flip to hard PASS/FAIL as attn-nnj.8.5 (manager wiring) +
# 8.7 (frontend bridge) land. Set `ATTN_REVIEW_E2E_REQUIRE_APPLY=1` to force
# hard FAIL on the apply assertions.

echo ""
echo "=== Review E2E: end-to-end apply flow (attn-nnj.8.6, PEND until 8.5+) ==="

# Soft-assert helper for apply-path assertions. Same shape as
# expect_eq_soft above but reads a distinct env var so CI can require the
# apply path independently of the rest of the suite.
expect_apply_eq_soft() {
    local label="$1" actual="$2" expected="$3" tracking="$4"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    elif [ "${ATTN_REVIEW_E2E_REQUIRE_APPLY:-0}" = "1" ]; then
        echo "  FAIL: $label (apply path required; tracking $tracking)"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        FAIL=$((FAIL + 1))
    else
        echo "  PEND: $label (waiting on $tracking)"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        PEND=$((PEND + 1))
    fi
}

# Probe the IPC bridge for the apply-path entry points the frontend will
# call once 8.7 ships them.
for cb in acceptSuggestion rejectSuggestion; do
    result=$("$ATTN" --eval "typeof window.__attn__?.${cb}")
    expect_apply_eq_soft "window.__attn__.${cb} is function" "$result" '"function"' "attn-nnj.8.5/8.7"
done

# Probe the daemon's on-disk surfaces directly. Once 8.5+ wires
# AcceptSuggestion end-to-end, accepting a suggestion through the bridge
# above must produce: (a) one new LocalRevision with source=accepted_suggestion
# in the room's revisions/<fileId>.jsonl, and (b) one new SuggestionAccepted
# envelope in the room's outbox.jsonl. Today both directories are absent
# because no room has been opened — the assertions are scaffolding that
# describes the shape 8.5 will fill in.
reviews_dir="$ATTN_HOME/reviews"
if [ -d "$reviews_dir" ]; then
    revision_count=$(find "$reviews_dir" -type d -name 'revisions' \
        -exec find {} -name '*.jsonl' \; 2>/dev/null \
        | xargs -I{} grep -l '"accepted_suggestion"' {} 2>/dev/null \
        | wc -l | tr -d ' ')
    expect_apply_eq_soft "accepted-suggestion revision present on disk" \
        "$revision_count" "1" "attn-nnj.8.5/8.6"

    outbox_count=$(find "$reviews_dir" -name 'outbox.jsonl' \
        -exec wc -l {} \; 2>/dev/null \
        | awk '{s+=$1} END {print s+0}')
    expect_apply_eq_soft "owner outbox has at least one envelope" \
        "$outbox_count" "1" "attn-nnj.8.5/8.6"
else
    expect_apply_eq_soft "reviews/ store directory present" "absent" "present" "attn-nnj.8.5"
fi

# Cross-link: the in-process Rust E2E suite is the source of truth for
# what the daemon-layer flow MUST produce once wired. Print a hint so a
# developer who lands 8.5/8.7 knows where the contract lives.
echo "  NOTE: contract for the above lives in src/review/apply.rs ::e2e_* tests"
echo "        (run scripts/test-apply-e2e.sh to verify the contract directly)"

screenshot "03-apply-flow-pending"

# ===================================================================
# TEST SUITE: Collapsible rail + identity chips (attn-d7y / attn-42y)
# ===================================================================
#
# Seeds the review store directly through `window.__attn_review_store__`
# (no relay needed): one comment thread + its CommentResolved event. In a
# review room the rail is always present: collapsed to a 48px gutter
# (✓ chips for resolved, author-avatar chips for unresolved) unless
# expanded by the user/auto-open. Clicking a ✓ chip expands the rail with
# the full read-only card (no action buttons); clicking the card shrinks
# it back to a labeled chip. The ReviewBar dock carries the rail toggle.

echo ""
echo "=== Review E2E: collapsible rail + identity chips (attn-d7y/attn-42y) ==="

# Poll an --eval expression until it returns the expected value (the aside
# width animates over 200ms, so one-shot reads race the transition).
poll_eval() {
    local expr="$1" expected="$2" attempts=30
    local result=""
    while [ $attempts -gt 0 ]; do
        result=$("$ATTN" --eval "$expr" 2>/dev/null || echo "")
        if [ "$result" = "$expected" ]; then
            echo "$result"
            return 0
        fi
        sleep 0.1
        attempts=$((attempts - 1))
    done
    echo "$result"
}

"$ATTN" --wait-for '.ProseMirror' --timeout 10000 >/dev/null 2>&1 || true

seed_js=$(cat <<'EOF'
(() => {
  const s = window.__attn_review_store__;
  if (!s) return 'no-store';
  const anchor = {
    v: 2, fileId: 'file-x', snapshotId: 'snap-x', baseHash: 'h-x',
    position: { byteRange: [0, 10], lineRange: [1, 1] },
  };
  const meta = (id) => ({
    v: 2, eventId: id, roomId: 'room-x', authorId: 'p-reviewer',
    deviceId: 'd-x', createdAt: Date.now(), parentEventIds: [],
    snapshotId: 'snap-x',
  });
  const auth = { signature: 'sig', signingKeyId: 'kid' };
  s.applyEvent({ meta: meta('e-1'), body: { type: 'comment_created', threadId: 't-1', anchor, body: 'Consider tightening this wording.' }, auth });
  s.applyEvent({ meta: meta('e-2'), body: { type: 'comment_resolved', threadId: 't-1', resolvedBy: 'p-owner' }, auth });
  s.selectRoom('room-x');
  s.setCurrentFile('file-x');
  return 'ok';
})()
EOF
)
result=$("$ATTN" --eval "$seed_js")
assert_eq "Seeded resolved-only review thread" "$result" '"ok"'

echo ""
echo "--- Collapsed gutter (resolved-only margin, default) ---"
result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-mode') ?? 'missing'" '"collapsed"')
assert_eq "Rail data-mode is collapsed (no unresolved threads)" "$result" '"collapsed"'

result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.offsetWidth" '48')
assert_eq "Rail width is exactly the 48px gutter" "$result" "48"

result=$("$ATTN" --query '[data-testid="review-margin-resolved-chip"]' | jq -r '.count' 2>/dev/null || echo "0")
assert_eq "One resolved chip rendered" "$result" "1"

result=$("$ATTN" --eval "document.querySelector('[data-testid=\\\"review-margin-resolved-chip\\\"]')?.getAttribute('data-variant') ?? 'missing'")
assert_eq "Chip is icon variant in the gutter" "$result" '"icon"'

result=$("$ATTN" --eval "parseInt(document.querySelector('[data-testid=\\\"review-margin-resolved-chip\\\"]')?.style.top ?? '-1', 10) >= 8")
assert_eq "Gutter chip respects the inner clearance (top ≥ 8)" "$result" "true"

result=$("$ATTN" --eval "(() => { const t = document.querySelector('[data-slot=\\\"rail-toggle\\\"]'); const rail = document.querySelector('[data-slot=\\\"right-rail\\\"]'); if (!t || !rail) return 'missing'; const tr = t.getBoundingClientRect(); const rr = rail.getBoundingClientRect(); return Math.abs((tr.left + tr.width / 2) - (rr.left + rr.width / 2)) <= 2 ? 'centered' : 'off-center'; })()")
assert_eq "Toggle is horizontally centered in the collapsed gutter" "$result" '"centered"'

screenshot "04-resolved-collapsed-gutter"

echo ""
echo "--- Expand ✓ chip → rail expands with read-only card ---"
"$ATTN" --click '[data-testid="review-margin-resolved-chip"]' >/dev/null 2>&1 || true

result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-mode') ?? 'missing'" '"expanded"')
assert_eq "Rail expands on chip click" "$result" '"expanded"'

result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.offsetWidth" '320')
assert_eq "Rail width is exactly 320px when expanded" "$result" "320"

result=$(poll_eval "document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"resolved\\\"]') !== null" 'true')
assert_eq "Resolved card rendered" "$result" "true"

result=$("$ATTN" --eval "(() => { const c = document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"resolved\\\"]'); if (!c) return 'no-card'; return [c.querySelectorAll('[data-action]').length === 0, c.querySelector('.rmc-avatar') !== null].join(','); })()")
assert_eq "Card is read-only (no action buttons) with an author avatar" "$result" '"true,true"'

result=$("$ATTN" --eval "document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"resolved\\\"]')?.textContent.includes('Consider tightening this wording.')")
assert_eq "Card shows the resolved comment body" "$result" "true"

screenshot "05-resolved-expanded-card"

echo ""
echo "--- Click card → shrinks back to labeled chip (rail stays expanded) ---"
"$ATTN" --click '[data-testid="review-margin-card"][data-state="resolved"]' >/dev/null 2>&1 || true

result=$(poll_eval "document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"resolved\\\"]') === null" 'true')
assert_eq "Resolved card gone after card click" "$result" "true"

result=$(poll_eval "document.querySelector('[data-testid=\\\"review-margin-resolved-chip\\\"]')?.getAttribute('data-variant') ?? 'missing'" '"label"')
assert_eq "Labeled chip back in the expanded rail" "$result" '"label"'

result=$("$ATTN" --eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-mode')")
assert_eq "Rail stays expanded after card collapse" "$result" '"expanded"'

echo ""
echo "--- Mixed margin (active + resolved) → cards + labeled chip ---"
mixed_js=$(cat <<'EOF'
(() => {
  const s = window.__attn_review_store__;
  if (!s) return 'no-store';
  const anchor = {
    v: 2, fileId: 'file-x', snapshotId: 'snap-x', baseHash: 'h-x',
    position: { byteRange: [20, 30], lineRange: [3, 3] },
  };
  s.applyEvent({
    meta: { v: 2, eventId: 'e-3', roomId: 'room-x', authorId: 'p-reviewer', deviceId: 'd-x', createdAt: Date.now(), parentEventIds: [], snapshotId: 'snap-x' },
    body: { type: 'comment_created', threadId: 't-2', anchor, body: 'An open question.' },
    auth: { signature: 'sig', signingKeyId: 'kid' },
  });
  return 'ok';
})()
EOF
)
result=$("$ATTN" --eval "$mixed_js")
assert_eq "Seeded an additional unresolved thread" "$result" '"ok"'

result=$(poll_eval "document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"open\\\"]') !== null" 'true')
assert_eq "Active card rendered alongside the chip" "$result" "true"

result=$("$ATTN" --eval "(() => { const c = document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"open\\\"]'); if (!c) return 'no-card'; const cs = getComputedStyle(c); return [c.querySelector('.rmc-avatar') !== null, cs.borderLeftColor.length > 0].join(','); })()")
assert_eq "Active card carries author avatar + colored border" "$result" '"true,true"'

screenshot "06-mixed-expanded-rail"

echo ""
echo "--- Rail-header toggle → collapsed gutter with avatar chips ---"
result=$("$ATTN" --query '[data-slot="rail-toggle"]' | jq -r '.status' 2>/dev/null || echo "not_found")
assert_eq "Rail toggle present in the rail header" "$result" "found"

"$ATTN" --click '[data-slot="rail-toggle"]' >/dev/null 2>&1 || true

result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-mode') ?? 'missing'" '"collapsed"')
assert_eq "Toggle collapses the rail" "$result" '"collapsed"'

result=$("$ATTN" --query '[data-testid="review-margin-avatar-chip"]' | jq -r '.count' 2>/dev/null || echo "0")
assert_eq "Unresolved thread shows an author avatar chip in the gutter" "$result" "1"

result=$("$ATTN" --query '[data-testid="review-margin-resolved-chip"][data-variant="icon"]' | jq -r '.count' 2>/dev/null || echo "0")
assert_eq "Resolved thread shows a ✓ chip in the gutter" "$result" "1"

screenshot "07-collapsed-gutter-chips"

echo ""
echo "--- Avatar chip click → rail expands onto the thread ---"
"$ATTN" --click '[data-testid="review-margin-avatar-chip"]' >/dev/null 2>&1 || true

result=$(poll_eval "document.querySelector('[data-slot=\\\"right-rail\\\"]')?.getAttribute('data-mode') ?? 'missing'" '"expanded"')
assert_eq "Avatar chip expands the rail" "$result" '"expanded"'

result=$(poll_eval "document.querySelector('[data-testid=\\\"review-margin-card\\\"][data-state=\\\"open\\\"]') !== null" 'true')
assert_eq "Thread card visible after avatar expand" "$result" "true"

screenshot "08-avatar-expanded"

echo ""
echo "--- Cards track their anchors while the document scrolls (attn-23m) ---"
# Scroll the EDITOR viewport and assert the card's on-screen top moves by
# the same amount (opposite sign). Tolerance ±4px for rounding/collision.
scroll_js=$(cat <<'EOF'
(() => {
  const card = document.querySelector('[data-testid="review-margin-card"][data-state="open"]');
  const vp = document.querySelector('.attn-content-viewport [data-slot="scroll-area-viewport"]');
  if (!card || !vp) return 'missing';
  const before = card.getBoundingClientRect().top;
  vp.scrollTop = 150;
  const scrolled = vp.scrollTop;
  window.__attn_scroll_probe__ = { before, scrolled };
  return scrolled > 0 ? 'scrolled' : 'no-scroll';
})()
EOF
)
result=$("$ATTN" --eval "$scroll_js")
assert_eq "Editor viewport scrolled" "$result" '"scrolled"'

verify_js=$(cat <<'EOF'
(() => {
  const probe = window.__attn_scroll_probe__;
  const card = document.querySelector('[data-testid="review-margin-card"][data-state="open"]');
  if (!probe || !card) return 'missing';
  const after = card.getBoundingClientRect().top;
  const drift = Math.abs((probe.before - after) - probe.scrolled);
  return drift <= 4 ? 'tracked' : `drifted by ${Math.round(drift)}px (before ${Math.round(probe.before)}, after ${Math.round(after)}, scrolled ${probe.scrolled})`;
})()
EOF
)
result=$(poll_eval "$verify_js" '"tracked"')
assert_eq "Card moved 1:1 with the document scroll" "$result" '"tracked"'

# Scroll back and confirm it returns to its original position.
"$ATTN" --eval "document.querySelector('.attn-content-viewport [data-slot=\\\"scroll-area-viewport\\\"]').scrollTop = 0" >/dev/null
restore_js=$(cat <<'EOF'
(() => {
  const probe = window.__attn_scroll_probe__;
  const card = document.querySelector('[data-testid="review-margin-card"][data-state="open"]');
  if (!probe || !card) return 'missing';
  const drift = Math.abs(card.getBoundingClientRect().top - probe.before);
  return drift <= 4 ? 'restored' : `off by ${Math.round(drift)}px`;
})()
EOF
)
result=$(poll_eval "$restore_js" '"restored"')
assert_eq "Card returns to its anchor when scrolled back" "$result" '"restored"'

screenshot "09-scroll-tracking"

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
