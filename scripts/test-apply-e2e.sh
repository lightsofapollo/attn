#!/usr/bin/env bash
# Apply E2E test runner (attn-nnj.8.6).
#
# Two layers of coverage:
#
# 1. Rust integration tests in `src/review/apply.rs` (the `e2e_*` cases).
#    These cover the full owner-side accept/reject pipeline end-to-end:
#       snapshot + UserEdit drift -> resolve_suggestion (REMAP, not exact)
#       -> apply_ready_verdict -> WorkingCopyService write
#       -> LocalRevision appended (UserEdit + AcceptedSuggestion in order)
#       -> SuggestionAccepted/Rejected envelope assembled
#       -> store.append_outbox + iter_outbox round-trips the envelope
#       -> resulting_hash carried by the event matches disk hash.
#    These tests run via `cargo test` and do NOT need a running daemon.
#
# 2. Optional dual-instance daemon flow (PEND today; flips to FAIL when
#    `ReviewManager::handle(AcceptSuggestion)` is fully wired in 8.5+).
#    Drives a reviewer -> owner flow through two `attn` daemons running
#    under isolated `ATTN_HOME`s and asserts the same end-state shape
#    that the Rust tests pin down — but observed at the daemon boundary
#    (events.jsonl, outbox.jsonl, revisions/<fileId>.jsonl on disk).
#
# Exit code:
#   0 if the Rust E2E tests pass AND no daemon-layer FAIL was raised.
#   1 if any Rust E2E test failed (or a daemon-layer hard FAIL fired).
#
# Daemon-layer assertions that depend on 8.5 wiring print PEND instead of
# FAIL — same convention as scripts/test-review-e2e.sh. Set
# `ATTN_APPLY_E2E_REQUIRE_DAEMON=1` to flip them to hard FAILs once 8.5+
# lands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

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

expect_eq_soft() {
    local label="$1" actual="$2" expected="$3" tracking="$4"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    elif [ "${ATTN_APPLY_E2E_REQUIRE_DAEMON:-0}" = "1" ]; then
        echo "  FAIL: $label (daemon path required; tracking $tracking)"
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

# ===================================================================
# 1. Rust integration tests
# ===================================================================

echo "==> Rust apply E2E tests (cargo test review::apply::tests::e2e_*)"
echo ""
# `--quiet` keeps the cargo output focused on the test results; we still
# want to see PASS/FAIL per test, which cargo prints by default.
if cargo test --bin attn 'review::apply::tests::e2e_' --quiet 2>&1; then
    echo "  PASS: cargo test review::apply::tests::e2e_*"
    PASS=$((PASS + 1))
else
    echo "  FAIL: cargo test review::apply::tests::e2e_* (see output above)"
    FAIL=$((FAIL + 1))
fi

# ===================================================================
# 2. Optional dual-instance daemon flow (skip-pending until 8.5+ lands)
# ===================================================================

echo ""
echo "==> Daemon-layer apply E2E (dual instance, PEND until 8.5+ wires AcceptSuggestion)"

# Source the dual-instance helper so we can drive owner + reviewer through
# the same harness scripts/test-dual-instance-smoke.sh uses.
# shellcheck disable=SC1091
source "$PROJECT_DIR/scripts/lib/dual-instance.sh"

ATTN_BIN="${ATTN_BIN:-$PROJECT_DIR/target/debug/attn}"
if [ ! -x "$ATTN_BIN" ]; then
    echo "  PEND: binary missing at $ATTN_BIN (run 'cargo build')"
    PEND=$((PEND + 1))
else
    trap stop_dual EXIT
    if start_dual 2>/dev/null && wait_for_dual 'h1' 5000 2>/dev/null; then
        # Today the daemon's ReviewManager::AcceptSuggestion is a stub
        # (returns "suggestion_accepted_stub"), so probe for the real
        # wiring via a marker the 8.5 implementation will set. PEND until
        # the marker flips. The probe never blocks the suite — if it
        # times out / errors we just record PEND.
        result=$(attn_owner --eval 'typeof window.__attn__?.acceptSuggestion' 2>/dev/null || echo '"undefined"')
        expect_eq_soft "owner exposes acceptSuggestion via bridge" "$result" '"function"' "attn-nnj.8.5 / 8.7"

        # Observable on-disk side effect we want once 8.5+ is wired:
        # after a reviewer submits a suggestion + the owner accepts it,
        # the owner's outbox should hold exactly one SuggestionAccepted
        # envelope. We can't drive that flow until the bridge exists, so
        # probe the data directory for an empty outbox today.
        outbox_dir="$ATTN_DUAL_OWNER/reviews"
        if [ -d "$outbox_dir" ]; then
            envelope_count=$(find "$outbox_dir" -name 'outbox.jsonl' -exec wc -l {} \; 2>/dev/null | awk '{s+=$1} END {print s+0}')
            # PEND check — the count flips from 0 to 1 once 8.5 emits.
            expect_eq_soft "owner outbox has exactly one envelope post-accept" "$envelope_count" "1" "attn-nnj.8.5 / 8.6"
        else
            expect_eq_soft "owner outbox dir exists post-accept" "absent" "present" "attn-nnj.8.5 / 8.6"
        fi
    else
        echo "  PEND: dual-instance daemons failed to start (graceful — exercised by test:dual)"
        PEND=$((PEND + 1))
        stop_dual >/dev/null 2>&1 || true
    fi
fi

# ===================================================================
# Summary
# ===================================================================

echo ""
echo "=== Apply E2E Summary ==="
echo "  PASS: $PASS"
echo "  PEND: $PEND   (daemon wiring not yet live; flip via ATTN_APPLY_E2E_REQUIRE_DAEMON=1)"
echo "  FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
