#!/usr/bin/env bash
# Review inline-render E2E (owner-only, single relay).
#
# Regression guard for the margin-recalc reactivity loop: ReviewMargin bumped a
# `_recalcTick` $state via `tick = tick + 1` inside effects (read+write the same
# signal), which tripped `effect_update_depth_exceeded`. Svelte then DISABLED
# the effect, anchor Y positions stopped recomputing, and only the FIRST
# comment/suggestion ever rendered an inline mark.
#
# This boots a relay + a single owner, shares (→ room + snapshot), creates THREE
# comments at distinct ranges, and asserts ALL THREE resolve + render an inline
# mark, with ZERO effect_update_depth_exceeded errors in the webview log.
#
# Every wait is a polled condition (per CLAUDE.md: never sleep on a condition).
# ATTN_SKIP_REVIEW_RENDER_E2E=1 → clean skip (no relay/daemon infra).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_REVIEW_RENDER_E2E:-0}" = "1" ]; then
    echo "test-review-render-e2e: ATTN_SKIP_REVIEW_RENDER_E2E=1 — skipping (clean exit)"; exit 0
fi

: "${RELAY_PORT:=8795}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="${ATTN_EXTERNAL_RELAY:-http://localhost:${RELAY_PORT}}"
OWNER_HOME="/tmp/attn-rr-owner"
WORK="/tmp/attn-rr-work"
DOC="$WORK/doc.md"
RELAY_LOG="$WORK/relay.log"
OWNER_LOG="$WORK/owner.log"
RELAY_PID=""; OWNER_PID=""
PASS=0; FAIL=0

log() { printf '==> %s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
poll() { local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
wait_ready() { poll "${3:-25000}" "$1" --wait-for "$2" --timeout 1000; }
kill_pid() { local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }
cleanup() { log "Cleaning up"; kill_pid "$OWNER_PID"; if [ -n "$RELAY_PID" ]; then pkill -P "$RELAY_PID" 2>/dev/null || true; kill_pid "$RELAY_PID"; fi; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -x "$ATTN_BIN" ] || { log "Building attn"; cargo build || exit 1; }
rm -rf "$OWNER_HOME" "$WORK"; mkdir -p "$OWNER_HOME" "$WORK"
printf '# Render Doc\n\nAlpha bravo charlie delta echo foxtrot.\n\nGolf hotel india juliett kilo lima mike.\n\nNovember oscar papa quebec romeo sierra.\n' > "$DOC"

if [ -n "${ATTN_EXTERNAL_RELAY:-}" ]; then
    curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 || { log "external relay /health unreachable at $RELAY_URL"; exit 1; }
    log "Using external relay: $RELAY_URL"
else
    [ -d "$PROJECT_DIR/relay/node_modules" ] || (cd relay && npm ci >/dev/null)
    log "Starting relay on :$RELAY_PORT"
    ( cd "$PROJECT_DIR/relay" && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
    deadline=$(( $(date +%s) + 60 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; kill -0 "$RELAY_PID" 2>/dev/null || { log "relay died"; tail -20 "$RELAY_LOG"; exit 1; }; sleep 0.3; done
    log "Relay healthy"
fi

log "Booting owner"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$DOC" >"$OWNER_LOG" 2>&1 & OWNER_PID=$!
wait_ready attn_owner 'h1' 30000 || { log "owner never rendered"; tail -30 "$OWNER_LOG"; exit 1; }

log "Owner shares (Cmd+Shift+S)"
attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1 || true
wait_ready attn_owner '[data-slot=share-invite-url]' 20000 || { log "share dialog didn't open"; tail -30 "$OWNER_LOG"; exit 1; }
has_invite() { case "$(attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value||''" 2>/dev/null | tr -d '"\\')" in *attn://review/*) return 0;; *) return 1;; esac; }
poll 20000 has_invite && ok "owner minted invite (room live)" || { bad "no invite — share failed"; tail -40 "$OWNER_LOG"; }

pm_ready() { [ -n "$(attn_owner --eval "window.__attnPmView?'y':''" 2>/dev/null | tr -d '"')" ]; }
poll 20000 pm_ready || { bad "PM editor never came up"; }

composer_ready() { [ -n "$(attn_owner --eval "document.querySelector('.comment-composer textarea')?'y':''" 2>/dev/null | tr -d '"')" ]; }
composer_gone()  { [ -z "$(attn_owner --eval "document.querySelector('.comment-composer textarea')?'y':''" 2>/dev/null | tr -d '"')" ]; }
make_comment() {
  local from="$1" to="$2" mark="$3" attempt
  # The first Cmd+. after share can race the editor's focus/selection, so retry
  # the select+open a few times before giving up.
  for attempt in 1 2 3 4 5; do
    attn_owner --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var S=v.state.selection.constructor;var sz=v.state.doc.content.size;v.focus();v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,Math.min($from,sz-1),Math.min($to,sz-1))));return 'ok';})()" >/dev/null 2>&1
    attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'.',code:'Period',metaKey:true,bubbles:true}));'x'" >/dev/null 2>&1
    if poll 3000 composer_ready; then
      attn_owner --fill '.comment-composer textarea' "$mark note" >/dev/null 2>&1
      attn_owner --click 'text=Submit' >/dev/null 2>&1
      poll 4000 composer_gone || true
      return 0
    fi
  done
  bad "comment composer did not open for $mark after retries"
}

log "Creating 3 comments at distinct ranges"
make_comment 2 7 CMTA
make_comment 12 18 CMTB
make_comment 30 36 CMTC
sleep 1.5

resolutions_n() { attn_owner --eval "String(Object.keys((window.__attn_review_store__&&window.__attn_review_store__.anchorResolutions)||{}).length)" 2>/dev/null | tr -d '"'; }
marks_n() { attn_owner --query '[data-review-kind]' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0; }

R="$(resolutions_n)"; M="$(marks_n)"
[ "$R" = "3" ] && ok "all 3 anchors resolved (anchorResolutions=$R)" || bad "expected 3 resolutions, got '$R'"
[ "$M" = "3" ] && ok "all 3 inline marks rendered ([data-review-kind]=$M)" || bad "expected 3 inline marks, got '$M'"

LOOP_ERRS="$(grep -c effect_update_depth "$OWNER_LOG" 2>/dev/null || true)"
[ "$LOOP_ERRS" = "0" ] && ok "no effect_update_depth_exceeded loops" || bad "$LOOP_ERRS effect_update_depth_exceeded error(s) in webview log"

echo ""; log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
