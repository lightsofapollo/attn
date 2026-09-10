#!/usr/bin/env bash
# Headless end-to-end test for HTML document ANNOTATION (attn-61t).
#
# The sibling script test-html-share-e2e.sh proves an HTML document reaches a
# reviewer read-only. This one proves the half that makes it a review surface:
#
#   1. Boot a Miniflare relay (wrangler dev --local).
#   2. Boot two isolated daemons (owner + reviewer) via ATTN_HOME isolation.
#   3. Owner shares an .html file → the snapshot now declares the client-side
#      annotation capability (html_selectors_v1) instead of publishing bare.
#   4. Reviewer joins → its window switches to the shared doc AND injects the
#      annotation runtime into the sandboxed frame.
#   5. Assert the runtime booted inside the opaque-origin frame, that the
#      comment margin mounts for an annotatable HTML doc, and that the
#      capability survived the encrypted round-trip.
#   6. Annotate mode (attn-wrf3): on both sides, the page's own button keeps
#      working under review; pressing the pinned note toggle turns the same
#      click into a comment composer; pressing it again hands the click back.
#
# Why the assertions look indirect: the document renders in a cross-origin
# sandboxed iframe, so the automation bridge (which evaluates in the SHELL's
# context) cannot reach into it. We therefore assert on what the shell can
# legitimately observe — the injected marker in the iframe's srcdoc, the
# capability on the received snapshot, the shell's own annotation wiring, and
# the mounted margin — rather than pretending to inspect the frame's DOM.
#
# THE IN-FRAME INTERACTION LAYER IS MOSTLY NOT TESTED HERE, and pretending
# otherwise is how the hover/click layer once shipped green while being unusable
# by hand. Hovering, the label chip, element clicks and the Comment pill are
# driven with a real mouse against a real opaque-origin frame in
# web/e2e/html-annotation-runtime.spec.ts (`npm run test:e2e:html-annotation`).
# What this script uniquely proves is the part that needs two daemons and a
# relay: that the capability, the bytes and the runtime survive the encrypted
# round trip, and that both sides' shells wire an annotatable frame up.
#
# The one in-frame behaviour it does exercise is the annotate-mode switch, and
# it does so through the FIXTURE: tests/fixtures/interactive.html answers a
# postMessage from the shell by hovering and clicking its own button with the
# event sequence the runtime listens to, then reports its DOM state back. That
# is the only way to observe "the button's handler ran" from outside an opaque
# frame; the shell-side halves (the toggle's aria-pressed, the composer) are
# asserted directly.
#
# Honors ATTN_SKIP_HTML_ANNOTATION_E2E=1 as a CI escape hatch (relay + webview
# need a display + loopback, flaky on some headless infra).
#
# Usage:
#   scripts/test-html-annotation-e2e.sh
#   ATTN_RELAY_URL=http://localhost:8788 scripts/test-html-annotation-e2e.sh

set -euo pipefail

if [ "${ATTN_SKIP_HTML_ANNOTATION_E2E:-0}" = "1" ]; then
    echo "SKIP html-annotation e2e (ATTN_SKIP_HTML_ANNOTATION_E2E=1)"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${ATTN_RELAY_URL:=http://localhost:8787}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
FIXTURE="$PROJECT_DIR/tests/fixtures/interactive.html"
MARKER="Interactive HTML fixture"
# The injected runtime carries this attribute; it is the only reliable
# shell-visible proof that injection happened.
RUNTIME_MARKER="data-attn-runtime"

export ATTN_DUAL_OWNER="/tmp/attn-html-annotation-owner"
export ATTN_DUAL_REVIEWER="/tmp/attn-html-annotation-reviewer"
export ATTN_DUAL_FIXTURE="$FIXTURE"
export ATTN_DUAL_REVIEWER_FIXTURE="$PROJECT_DIR/tests/fixtures/basic.md"
export ATTN_BIN
export ATTN_RELAY_URL

RELAY_PID=""
RELAY_LOG="/tmp/attn-html-annotation-relay.log"
FAILURES=0

log()  { printf '==> %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pend() { printf 'PEND %s\n' "$*"; }

require_bin() {
    if [ ! -x "$ATTN_BIN" ]; then
        log "attn binary missing at $ATTN_BIN — building (cargo build)"
        cargo build
    fi
}

start_relay() {
    if [ ! -d "$PROJECT_DIR/relay/node_modules" ]; then
        log "Installing relay deps (relay/npm ci)"
        (cd "$PROJECT_DIR/relay" && npm ci) >/dev/null
    fi
    log "Starting Miniflare relay → $ATTN_RELAY_URL"
    (
        cd "$PROJECT_DIR/relay"
        exec npm run dev
    ) >"$RELAY_LOG" 2>&1 &
    RELAY_PID=$!
    local deadline=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if ! kill -0 "$RELAY_PID" 2>/dev/null; then
            fail "relay exited early — see $RELAY_LOG"; tail -20 "$RELAY_LOG" >&2 || true; return 1
        fi
        if curl -fsS "$ATTN_RELAY_URL/health" >/dev/null 2>&1; then
            log "Relay health OK"; return 0
        fi
        sleep 0.3
    done
    fail "relay /health never came up — see $RELAY_LOG"; tail -20 "$RELAY_LOG" >&2 || true; return 1
}

stop_relay() {
    [ -z "${RELAY_PID:-}" ] && return 0
    kill -0 "$RELAY_PID" 2>/dev/null || return 0
    kill "$RELAY_PID" 2>/dev/null || true
    pkill -P "$RELAY_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$RELAY_PID" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    kill -9 "$RELAY_PID" 2>/dev/null || true
    wait "$RELAY_PID" 2>/dev/null || true
    RELAY_PID=""
}

__cleanup_ran=0
cleanup() {
    [ "$__cleanup_ran" = "1" ] && return 0
    __cleanup_ran=1
    log "Cleaning up..."
    stop_dual || true
    stop_relay || true
}

# shellcheck source=scripts/lib/dual-instance.sh
source "$SCRIPT_DIR/lib/dual-instance.sh"
trap cleanup EXIT INT TERM

# ---------- run ----------

require_bin
start_relay

log "Booting owner ($FIXTURE) + reviewer daemons"
start_dual

__attn_dual_wait_one "$ATTN_DUAL_OWNER" '[data-slot="html-viewer"]' 20000 \
    && pass "owner renders the local .html file" \
    || fail "owner never rendered [data-slot=html-viewer]"

__attn_dual_wait_one "$ATTN_DUAL_REVIEWER" 'h1' 20000 \
    && pass "reviewer window up on its own fixture" \
    || fail "reviewer never rendered"

log "Owner sharing $FIXTURE (hybrid)"
attn_owner review share "$FIXTURE" --mode hybrid >/dev/null 2>&1 \
    || fail "owner 'review share' command failed"

INVITE=""
for _ in $(seq 1 75); do
    INVITE="$(attn_owner --eval \
        "window.__attn_review_store__?.currentShare?.inviteUrl ?? ''" 2>/dev/null \
        | jq -r . 2>/dev/null || echo '')"
    case "$INVITE" in
        attn://review/*) break ;;
        *) INVITE="" ; sleep 0.4 ;;
    esac
done
if [ -n "$INVITE" ]; then
    pass "owner minted invite: ${INVITE%%#*}#<key>"
else
    fail "owner never produced an invite URL (see $ATTN_DUAL_OWNER/daemon.stderr.log)"
    cleanup; echo; echo "RESULT: $FAILURES failure(s)"; exit 1
fi

# The owner stays on their local path-mode document after sharing. Its source
# must ask the native protocol handler for the runtime rather than switching to
# srcdoc (which would discard the local base URL and break ./assets). The Rust
# injection helper has direct unit coverage; this is the shell-observable E2E
# half that guards the owner wiring.
OWNER_MODE="$(attn_owner --eval \
    "document.querySelector('[data-slot=\"html-viewer\"]')?.getAttribute('data-annotation-mode') ?? ''" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
OWNER_SRC="$(attn_owner --eval \
    "document.querySelector('[data-slot=\"html-viewer\"] iframe')?.getAttribute('src') ?? ''" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
case "$OWNER_MODE:$OWNER_SRC" in
    path:*attn-annotate=1*) pass "owner path-mode frame requests the annotation runtime" ;;
    *) fail "owner did not retain an annotatable local HTML path (mode='$OWNER_MODE', src='$OWNER_SRC')" ;;
esac
OWNER_SANDBOX="$(attn_owner --eval \
    "document.querySelector('[data-slot=\"html-viewer\"] iframe')?.getAttribute('sandbox') ?? ''" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
case "$OWNER_SANDBOX" in
    *allow-same-origin*) fail "owner frame escaped its opaque origin (sandbox='$OWNER_SANDBOX')" ;;
    *allow-scripts*) pass "owner annotating frame retains opaque-origin scripts" ;;
    *) fail "owner frame has unexpected sandbox ('$OWNER_SANDBOX')" ;;
esac

# The owner's own document has to be annotatable and its frame has to have
# COMPLETED the handshake. Both were false in the shipped build: annotatability
# was keyed on the focused room (which an owner routinely does not have, since
# they stay on their local file — attn-0wa), and the path-mode iframe was never
# bound to the bridge at all, so the runtime said hello and nothing answered.
# Neither failure is visible in any iframe attribute, which is why they reached
# a human. Polled: the handshake is asynchronous.
OWNER_WIRED=""
for _ in $(seq 1 30); do
    OWNER_WIRED="$(attn_owner --eval \
        "JSON.stringify([window.__attn_html_debug__?.annotatable === true, window.__attn_html_debug__?.bridgeConnected?.() === true])" \
        2>/dev/null | jq -r . 2>/dev/null || echo '')"
    case "$OWNER_WIRED" in *'[true,true]'*) break ;; esac
    sleep 0.5
done
case "$OWNER_WIRED" in
    *'[true,true]'*) pass "owner's shared HTML doc is annotatable and its frame is connected" ;;
    *) fail "owner annotation wiring incomplete ([annotatable,connected]=$OWNER_WIRED)" ;;
esac

__attn_dual_wait_one "$ATTN_DUAL_OWNER" '[data-slot="review-margin"]' 15000 \
    && pass "owner has a comment rail after sharing" \
    || fail "owner never mounted the comment rail"

log "Reviewer joining"
attn_reviewer review join "$INVITE" >/dev/null 2>&1 \
    || fail "reviewer 'review join' command failed"

__attn_dual_wait_one "$ATTN_DUAL_REVIEWER" '[data-slot="html-viewer"]' 25000 \
    && pass "reviewer switched to the HTML viewer for the shared doc" \
    || fail "reviewer never rendered [data-slot=html-viewer]"

# ---- the annotation-specific assertions --------------------------------------

# 1. The capability must survive publish → encrypt → relay → decrypt. Without
#    it the reviewer silently falls back to the read-only viewer, which looks
#    identical until you try to comment.
CAPABILITY="$(attn_reviewer --eval \
    "(window.__attn_review_store__?.snapshots ?? []).filter(s => s.docType === 'html').map(s => s.annotation ?? 'none').join(',')" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
case "$CAPABILITY" in
    *html_selectors_v1*) pass "reviewer's HTML snapshot declares html_selectors_v1" ;;
    *) fail "annotation capability lost in transit (got '$CAPABILITY')" ;;
esac

# 2. The runtime must actually be spliced into the frame's srcdoc. This is the
#    shell-visible half of "the frame can annotate"; the frame's own boot is
#    covered by web/e2e/html-annotation-runtime.spec.ts in a real browser.
SRCDOC="$(attn_reviewer --eval \
    "document.querySelector('[data-slot=\\\"html-viewer\\\"] iframe')?.getAttribute('srcdoc') ?? ''" \
    2>/dev/null || echo '')"
case "$SRCDOC" in
    *"$MARKER"*) pass "reviewer iframe carries the owner's HTML bytes" ;;
    *) fail "reviewer iframe srcdoc missing marker '$MARKER' (got ${#SRCDOC} chars)" ;;
esac
case "$SRCDOC" in
    *"$RUNTIME_MARKER"*) pass "annotation runtime injected into the document frame" ;;
    *) fail "runtime not injected — no $RUNTIME_MARKER in srcdoc" ;;
esac

# 3. The frame must stay origin-isolated. Annotation adds allow-scripts; it must
#    NOT add allow-same-origin, or the untrusted document gains storage and
#    same-origin reach (amendments.md #19).
SANDBOX="$(attn_reviewer --eval \
    "document.querySelector('[data-slot=\\\"html-viewer\\\"] iframe')?.getAttribute('sandbox') ?? ''" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
case "$SANDBOX" in
    *allow-same-origin*) fail "frame escaped its opaque origin (sandbox='$SANDBOX')" ;;
    *allow-scripts*) pass "frame keeps an opaque origin with scripts (sandbox='$SANDBOX')" ;;
    *) fail "unexpected sandbox on the document frame ('$SANDBOX')" ;;
esac

# 4. The comment margin must mount for an annotatable HTML doc — it is hidden
#    for a read-only one, so this is the user-visible difference.
__attn_dual_wait_one "$ATTN_DUAL_REVIEWER" '[data-slot="review-margin"]' 15000 \
    && pass "comment margin mounts for the annotatable HTML doc" \
    || pend "review margin not observed (attn-7ev: needs the rail expanded)"

# ---- annotate mode: off by default; the pinned toggle enters and leaves it ---
#
# Both shells are the same App.svelte, so the same walk runs on the owner
# (path-mode frame, runtime spliced by the attn:// handler) and on the reviewer
# (srcdoc frame, runtime spliced by the shell). The fixture reports its own
# state over postMessage — see the header comment for why.

TOGGLE='[data-slot="html-annotate-toggle"]'
COMPOSER='[data-slot="html-comment-composer"]'

# $1: home. Evaluate JS in that shell; print the JSON result (or 'err').
shell_eval() {
    ATTN_HOME="$1" "$ATTN_BIN" --eval "$2" 2>/dev/null | jq -r . 2>/dev/null || echo 'err'
}

# Install the shell-side listener that captures the fixture's state reports.
install_fixture_listener() {
    shell_eval "$1" "(() => { if (!window.__attn_fixture_listener) { window.__attn_fixture_listener = true; window.__attn_fixture_state = null; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'attn-fixture:state') window.__attn_fixture_state = { pressed: e.data.pressed, hash: e.data.hash }; }); } return true; })()" >/dev/null
}

# $1: home, $2: CSS selector inside the fixture. Hover + click it, as the
# runtime would see a real pointer do, and wait for the state report.
fixture_press() {
    shell_eval "$1" "(() => { window.__attn_fixture_state = null; document.querySelector('[data-slot=\"html-viewer\"] iframe')?.contentWindow?.postMessage({ type: 'attn-fixture:press', target: '$2' }, '*'); return true; })()" >/dev/null
    local i=0
    while [ $i -lt 30 ]; do
        local got
        got="$(shell_eval "$1" "window.__attn_fixture_state !== null")"
        [ "$got" = "true" ] && return 0
        sleep 0.1; i=$((i + 1))
    done
    return 1
}

fixture_pressed() { shell_eval "$1" "window.__attn_fixture_state?.pressed ?? -1"; }
toggle_pressed() { shell_eval "$1" "document.querySelector('$TOGGLE')?.getAttribute('aria-pressed') ?? 'missing'"; }
composer_open()  { shell_eval "$1" "document.querySelector('$COMPOSER') !== null"; }

# $1: home, $2: label
assert_annotate_mode() {
    local home="$1" who="$2"

    __attn_dual_wait_one "$home" "$TOGGLE" 15000 \
        && pass "$who: pinned annotate toggle shown for the annotatable doc" \
        || { fail "$who: annotate toggle never rendered"; return; }
    case "$(toggle_pressed "$home")" in
        false) pass "$who: annotate mode is OFF by default" ;;
        *) fail "$who: annotate mode not off by default (aria-pressed=$(toggle_pressed "$home"))" ;;
    esac

    install_fixture_listener "$home"

    # (1) Off: the page's own handler runs and no composer appears.
    if fixture_press "$home" '#action'; then
        local pressed; pressed="$(fixture_pressed "$home")"
        if [ "$pressed" = "1" ] && [ "$(composer_open "$home")" = "false" ]; then
            pass "$who: (1) with the mode off, the page's button runs its handler and no composer opens"
        else
            fail "$who: (1) mode off — pressed=$pressed composer=$(composer_open "$home")"
        fi
    else
        fail "$who: (1) fixture never reported after the press"
    fi

    # (2) On: the same click opens the composer and the handler does NOT run.
    ATTN_HOME="$home" "$ATTN_BIN" --click "$TOGGLE" >/dev/null 2>&1 \
        || fail "$who: could not click the annotate toggle"
    sleep 0.4
    case "$(toggle_pressed "$home")" in
        true) pass "$who: toggle reports pressed after the click" ;;
        *) fail "$who: toggle did not flip on (aria-pressed=$(toggle_pressed "$home"))" ;;
    esac
    local mode; mode="$(shell_eval "$home" "window.__attn_html_debug__?.annotateMode === true")"
    [ "$mode" = "true" ] \
        && pass "$who: shell mirrors annotate mode on" \
        || fail "$who: shell debug mirror says annotateMode=$mode"
    if fixture_press "$home" '#action'; then
        local pressed; pressed="$(fixture_pressed "$home")"
        if __attn_dual_wait_one "$home" "$COMPOSER" 5000 && [ "$pressed" = "1" ]; then
            pass "$who: (2) with the mode on, the same click opens the composer and the handler does not run"
        else
            fail "$who: (2) mode on — pressed=$pressed composer=$(composer_open "$home")"
        fi
    else
        fail "$who: (2) fixture never reported after the press"
    fi

    # Cancel the composer (by its label, not its position), then leave the mode.
    shell_eval "$home" "(() => { const b = [...document.querySelectorAll('$COMPOSER button')].find((el) => el.textContent.trim() === 'Cancel'); b?.click(); return Boolean(b); })()" >/dev/null
    sleep 0.2
    [ "$(composer_open "$home")" = "false" ] \
        && pass "$who: cancelling the composer closes it" \
        || fail "$who: composer still open after Cancel"
    ATTN_HOME="$home" "$ATTN_BIN" --click "$TOGGLE" >/dev/null 2>&1 \
        || fail "$who: could not click the annotate toggle a second time"
    sleep 0.4
    case "$(toggle_pressed "$home")" in
        false) pass "$who: toggle reports released after the second click" ;;
        *) fail "$who: toggle did not flip off (aria-pressed=$(toggle_pressed "$home"))" ;;
    esac

    # (3) Off again: the handler runs and nothing proposes.
    if fixture_press "$home" '#action'; then
        local pressed; pressed="$(fixture_pressed "$home")"
        if [ "$pressed" = "2" ] && [ "$(composer_open "$home")" = "false" ]; then
            pass "$who: (3) with the mode off again, the page's button runs its handler"
        else
            fail "$who: (3) mode off again — pressed=$pressed composer=$(composer_open "$home")"
        fi
    else
        fail "$who: (3) fixture never reported after the press"
    fi
}

log "Annotate mode walk — owner"
assert_annotate_mode "$ATTN_DUAL_OWNER" "owner"
log "Annotate mode walk — reviewer"
assert_annotate_mode "$ATTN_DUAL_REVIEWER" "reviewer"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: html-annotation e2e passed"
    exit 0
else
    echo "RESULT: $FAILURES failure(s)"
    exit 1
fi
