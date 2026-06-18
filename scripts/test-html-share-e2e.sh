#!/usr/bin/env bash
# Headless end-to-end test for read-only HTML document sharing (attn-qgd).
#
# Proves the full owner→reviewer path over the REAL local relay:
#
#   1. Boot a Miniflare relay (wrangler dev --local).
#   2. Boot two isolated daemons (owner + reviewer) via ATTN_HOME isolation.
#   3. Owner shares an .html file → mints a room, publishes a read-only
#      HTML snapshot over the encrypted transport.
#   4. Reviewer joins the invite → its window switches to the shared doc.
#   5. Assert the reviewer renders the HTML in the sandboxed viewer
#      (data-slot=html-viewer, iframe srcdoc carrying the owner's bytes) and
#      does NOT mount the markdown editor (read-only, no collab).
#
# Everything is driven through the automation CLI (--eval/--query/--wait-for),
# so no human interaction is needed. Honors ATTN_SKIP_HTML_SHARE_E2E=1 as a CI
# escape hatch (the relay + webview need a display + loopback, flaky on some
# headless infra).
#
# Usage:
#   scripts/test-html-share-e2e.sh
#   ATTN_RELAY_URL=http://localhost:8788 scripts/test-html-share-e2e.sh

set -euo pipefail

if [ "${ATTN_SKIP_HTML_SHARE_E2E:-0}" = "1" ]; then
    echo "SKIP html-share e2e (ATTN_SKIP_HTML_SHARE_E2E=1)"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${ATTN_RELAY_URL:=http://localhost:8787}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
FIXTURE="$PROJECT_DIR/tests/fixtures/sample.html"
# A marker that appears in the rendered HTML (and only there) so we can assert
# the reviewer actually received + mounted the owner's bytes.
MARKER="Hello from an HTML file"

# Owner opens the .html fixture; reviewer opens a DIFFERENT markdown fixture so
# we can prove its window SWITCHES to the shared HTML doc on join (rather than
# already showing it).
export ATTN_DUAL_OWNER="/tmp/attn-html-share-owner"
export ATTN_DUAL_REVIEWER="/tmp/attn-html-share-reviewer"
export ATTN_DUAL_FIXTURE="$FIXTURE"
export ATTN_DUAL_REVIEWER_FIXTURE="$PROJECT_DIR/tests/fixtures/basic.md"
export ATTN_BIN
export ATTN_RELAY_URL

RELAY_PID=""
RELAY_LOG="/tmp/attn-html-share-relay.log"
FAILURES=0

log()  { printf '==> %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

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

# Owner renders the local HTML file (path mode) — the viewer must mount.
__attn_dual_wait_one "$ATTN_DUAL_OWNER" '[data-slot="html-viewer"]' 20000 \
    && pass "owner renders the local .html file in HtmlViewer" \
    || fail "owner never rendered [data-slot=html-viewer]"

# Reviewer starts on the markdown fixture (NOT the shared doc yet).
__attn_dual_wait_one "$ATTN_DUAL_REVIEWER" 'h1' 20000 \
    && pass "reviewer window up on its own fixture" \
    || fail "reviewer never rendered"

# Owner shares the HTML file via the running daemon (hybrid: live + mailbox).
log "Owner sharing $FIXTURE (hybrid)"
attn_owner review share "$FIXTURE" --mode hybrid >/dev/null 2>&1 \
    || fail "owner 'review share' command failed"

# Poll the owner's review store for the minted invite URL.
INVITE=""
for _ in $(seq 1 75); do
    # --eval returns a JSON-encoded scalar (quoted, slashes escaped), so decode
    # it with `jq -r .` to recover the raw attn://review/... URL.
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

# Reviewer joins via its daemon → its window switches to the shared HTML doc.
log "Reviewer joining"
attn_reviewer review join "$INVITE" >/dev/null 2>&1 \
    || fail "reviewer 'review join' command failed"

# The reviewer's window must switch to the read-only HTML viewer.
__attn_dual_wait_one "$ATTN_DUAL_REVIEWER" '[data-slot="html-viewer"]' 25000 \
    && pass "reviewer switched to HtmlViewer for the shared doc" \
    || fail "reviewer never rendered [data-slot=html-viewer]"

# The iframe must be srcdoc (content mode — reviewer has no local file) and
# carry the owner's bytes (the marker).
SRCDOC="$(attn_reviewer --eval \
    "document.querySelector('[data-slot=\\\"html-viewer\\\"] iframe')?.getAttribute('srcdoc') ?? ''" \
    2>/dev/null || echo '')"
case "$SRCDOC" in
    *"$MARKER"*) pass "reviewer iframe srcdoc carries the owner's HTML bytes" ;;
    *) fail "reviewer iframe srcdoc missing marker '$MARKER' (got ${#SRCDOC} chars)" ;;
esac

# Read-only: the reviewer must NOT mount the markdown editor for an HTML doc.
HAS_EDITOR="$(attn_reviewer --eval \
    "document.querySelector('[data-slot=\\\"html-viewer\\\"] .ProseMirror') ? 'yes' : 'no'" \
    2>/dev/null | jq -r . 2>/dev/null || echo 'err')"
[ "$HAS_EDITOR" = "no" ] \
    && pass "reviewer HTML doc is read-only (no prosemirror editor)" \
    || fail "reviewer unexpectedly mounted an editor for an HTML doc ($HAS_EDITOR)"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: html-share e2e passed"
    exit 0
else
    echo "RESULT: $FAILURES failure(s)"
    exit 1
fi
