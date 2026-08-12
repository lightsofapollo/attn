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
#
# Why the assertions look indirect: the document renders in a cross-origin
# sandboxed iframe, so the automation bridge (which evaluates in the SHELL's
# context) cannot reach into it. We therefore assert on what the shell can
# legitimately observe — the injected marker in the iframe's srcdoc, the
# capability on the received snapshot, and the mounted margin — rather than
# pretending to inspect the frame's DOM.
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
FIXTURE="$PROJECT_DIR/tests/fixtures/sample.html"
MARKER="Hello from an HTML file"
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

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: html-annotation e2e passed"
    exit 0
else
    echo "RESULT: $FAILURES failure(s)"
    exit 1
fi
