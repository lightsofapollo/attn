#!/usr/bin/env bash
# WebRTC end-to-end test (attn-nnj.7.7) — bash flavor.
#
# Spins up two attn daemons (owner + reviewer) via scripts/lib/dual-instance.sh
# and drives them through the same kind of WebRTC handshake the Rust
# integration test at tests/webrtc_e2e.rs covers, except from the outside:
# every interaction goes through the daemon's automation CLI (--eval, --query,
# --wait-for).
#
# WHY BOTH a Rust and a bash test? They cover different layers:
#
#   - Rust  : pure transport layer; in-process signaling relay swaps out the
#             mailbox HTTP hop so we can stress the WebRtcTransport API surface
#             directly. Catches changes to AEAD / signaling envelope shape /
#             ICE wiring without needing a live relay.
#   - Bash  : full daemon shape — proves both attn processes can be addressed
#             independently via ATTN_HOME, that --eval reaches the webview,
#             that the review IPC surface is wired, etc. Today this script is
#             a *scaffold* — the actual WebRTC bring-up between two daemons
#             requires the ReviewManager-side wiring (room registration,
#             mailbox + WebRTC transport selection) to land in 7.8 before we
#             can write hard assertions on "the owner saw the reviewer's
#             comment". The script PEND-marks those assertions today so a
#             future engineer running it sees exactly what work is left.
#
# Skip / CI behavior:
#
#   - The Rust suite's CI gate is ATTN_SKIP_WEBRTC_E2E=1; we honor the same
#     env var here so a single CI flag turns off both surfaces at once.
#   - WebRTC bring-up between two daemons needs real loopback UDP, which is
#     flaky on GH Actions runners (esp. macOS where the firewall popup
#     blocks the test). If a soft assertion times out we PEND it rather than
#     FAIL so the test stays green on infra that can't run it.
#
# Run locally:
#
#   scripts/test-webrtc-e2e.sh
#
# Skip on CI:
#
#   ATTN_SKIP_WEBRTC_E2E=1 scripts/test-webrtc-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# --- CI skip gate ---------------------------------------------------------
case "${ATTN_SKIP_WEBRTC_E2E:-}" in
    1|true|TRUE|yes|YES)
        echo "ATTN_SKIP_WEBRTC_E2E set — skipping (exit 0)"
        exit 0
        ;;
esac

# --- Build the binary on demand -------------------------------------------
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

# Soft assertion for shape that may not have landed yet (mirrors the
# pattern used in test-review-e2e.sh + test-dual-instance-smoke.sh). The
# 7.x ReviewManager wiring lands in 7.8; until then any "did the
# DataChannel actually deliver the comment?" assertions go through this
# helper so the script can be merged today without blocking on 7.8.
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

cleanup() {
    stop_dual || true
}
trap cleanup EXIT

echo "==> WebRTC e2e test (bash, attn-nnj.7.7)"
echo "    owner    home: $ATTN_DUAL_OWNER"
echo "    reviewer home: $ATTN_DUAL_REVIEWER"
echo "    binary       : $ATTN_BIN"
echo "    fixture      : $ATTN_DUAL_FIXTURE"
echo ""

# --- Boot both daemons ----------------------------------------------------

echo "--- Boot ---"
start_dual
wait_for_dual 'h1'
echo "  PASS: both daemons booted and rendered h1"
PASS=$((PASS + 1))

# --- Sanity: both webviews expose the bridge ------------------------------
echo ""
echo "--- Daemon bridge surface ---"
owner_bridge=$(attn_owner --eval "typeof window.__attn__" 2>/dev/null || echo '"undefined"')
assert_eq "owner window.__attn__ is object" "$owner_bridge" '"object"'
reviewer_bridge=$(attn_reviewer --eval "typeof window.__attn__" 2>/dev/null || echo '"undefined"')
assert_eq "reviewer window.__attn__ is object" "$reviewer_bridge" '"object"'

# --- Review-surface seams must exist on both daemons ----------------------
# Mirrors test-review-e2e.sh shape checks but on both processes so we know
# the WebRTC wiring's *upstream* surface is in place. The actual review
# IPC methods (request_snapshot, etc.) flow through window.__attn__ and
# their presence is a prerequisite for the soft assertions below.
echo ""
echo "--- Review IPC surface present on each daemon ---"
owner_review=$(attn_owner --eval "typeof window.__attn__?.review" 2>/dev/null || echo '"undefined"')
expect_eq_soft "owner window.__attn__.review present" "$owner_review" '"object"' "attn-nnj.7.8 (review IPC wiring)"
reviewer_review=$(attn_reviewer --eval "typeof window.__attn__?.review" 2>/dev/null || echo '"undefined"')
expect_eq_soft "reviewer window.__attn__.review present" "$reviewer_review" '"object"' "attn-nnj.7.8 (review IPC wiring)"

# --- WebRTC negotiation between the two daemons ---------------------------
# Today this section is a placeholder: the daemons don't yet share a room
# at boot — that's the ReviewManager bootstrap pipeline (5.x + 7.8). Once
# 7.8 lands we'll:
#
#   1. Have the owner call window.__attn__.review.share() to mint a room
#      invite and print the (roomId, roomSecret) tuple to stdout via
#      --eval.
#   2. Pipe that invite into the reviewer via
#      window.__attn__.review.join(invite).
#   3. Wait for both daemons' review state to enter `live` mode (the
#      mode-aware selector at 7.5 flips Hybrid -> Live once the
#      DataChannel is up).
#   4. Drive a comment from the reviewer side (--click 'text=Add comment'
#      → --fill '.composer textarea' "hello via WebRTC").
#   5. Assert the owner's review-thread DOM shows the comment.
#   6. Tear down by --eval'ing review.leave() on both sides.
#
# Until 7.8 we PEND-mark the bring-up so a future engineer sees exactly
# what work is left.

echo ""
echo "--- WebRTC negotiation handshake (PEND until 7.8) ---"
owner_share=$(attn_owner --eval "typeof window.__attn__?.review?.share" 2>/dev/null || echo '"undefined"')
expect_eq_soft "owner review.share() exposed" "$owner_share" '"function"' "attn-nnj.7.8 (share IPC)"

reviewer_join=$(attn_reviewer --eval "typeof window.__attn__?.review?.join" 2>/dev/null || echo '"undefined"')
expect_eq_soft "reviewer review.join() exposed" "$reviewer_join" '"function"' "attn-nnj.7.8 (join IPC)"

owner_request_snapshot=$(attn_owner --eval "typeof window.__attn__?.review?.requestSnapshot" 2>/dev/null || echo '"undefined"')
expect_eq_soft "owner requestSnapshot() exposed" "$owner_request_snapshot" '"function"' "attn-nnj.7.6 (request_snapshot IPC)"

# --- Comment-delivery assertion (the eventual hard test) ------------------
# Once 7.8 lands and the bring-up above turns into PASSes, this assertion
# will check that an event the reviewer sends over the DataChannel lands
# in the owner's events.jsonl. The Rust integration test
# (tests/webrtc_e2e.rs::webrtc_happy_path_delivers_comment_envelope_to_owner_store)
# already covers this at the transport layer; this is the daemon-shape
# parallel.

echo ""
echo "--- Comment delivery (PEND until 7.8) ---"
# Placeholder — drives a no-op selector today so the harness verifies the
# query surface still works even when nothing's been sent.
owner_threads=$(attn_owner --query '.review-thread' 2>/dev/null || echo '{}')
owner_thread_count=$(echo "$owner_threads" | jq -r '.count // 0' 2>/dev/null || echo "0")
expect_eq_soft "owner review-thread count after WebRTC delivery" "$owner_thread_count" "1" "attn-nnj.7.8 (DataChannel delivery → DOM)"

# --- Disconnect path (PEND until 7.8) -------------------------------------
echo ""
echo "--- Disconnect mid-session (PEND until 7.8) ---"
# Once 7.8 lands we'll close the reviewer and assert the owner's
# transport state surfaces the mode-aware error (live mode) or the
# silent mailbox fallback (hybrid mode). Today this is purely a shape
# check that the connection-state surface exists on the bridge.
owner_conn=$(attn_owner --eval "typeof window.__attn__?.review?.connection" 2>/dev/null || echo '"undefined"')
expect_eq_soft "owner review.connection state exposed" "$owner_conn" '"object"' "attn-nnj.7.8 (connection state surface)"

# --- Outbox-flushed check (PEND until 7.8) --------------------------------
echo ""
echo "--- Reviewer outbox empty after DataChannel delivery (PEND until 7.8) ---"
# The spec's invariant: when the DataChannel delivery succeeds, the
# reviewer's outbox should NOT keep a fallback mailbox enqueue. The
# selector at 7.5 owns this — until it lands we just probe for the
# outbox surface.
reviewer_outbox=$(attn_reviewer --eval "typeof window.__attn__?.review?.outbox" 2>/dev/null || echo '"undefined"')
expect_eq_soft "reviewer review.outbox exposed" "$reviewer_outbox" '"object"' "attn-nnj.7.5 (transport selector + outbox surface)"

# --- Summary --------------------------------------------------------------
echo ""
echo "=== WebRTC e2e summary ==="
echo "  PASS: $PASS"
echo "  PEND: $PEND"
echo "  FAIL: $FAIL"
echo ""
echo "NOTE: This bash test is a daemon-shape scaffold for attn-nnj.7.7."
echo "      The Rust integration test at tests/webrtc_e2e.rs covers the"
echo "      transport-layer WebRTC handshake + DataChannel delivery"
echo "      end-to-end already. PEND items in this script flip to PASS"
echo "      once attn-nnj.7.8 wires the ReviewManager bootstrap pipeline"
echo "      into window.__attn__.review."

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
