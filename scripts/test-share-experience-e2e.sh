#!/usr/bin/env bash
# Share-experience E2E — guards the sharing/collab UX bugs fixed under the
# attn-lms sweep (2026-05-22). Boots a relay + an owner daemon and a SEPARATE
# reviewer daemon (distinct ATTN_HOME, opened on a DIFFERENT local file), has
# the owner folder-share a directory with a subfolder, then the reviewer joins
# via the WINDOWED daemon path (`attn review join`, NOT `--as-agent`). Asserts:
#
#   #1  the reviewer DAEMON (windowed, has a UI) joins the room
#   #2  the reviewer view jumps to the SHARED document, not its local file
#   #3  the reviewer gets navigation: sidebar shared-file tree + top strip
#   #5  the owner's status names WHAT is shared ("N files"), not "everything"
#
# (#4 — menu-bar z-index — is a visual fix verified by screenshot, captured
# here under $WORK/shots for manual review but not hard-asserted.)
#
# Every wait is a polled condition (per CLAUDE.md: never sleep on a condition).
# ATTN_SKIP_SHARE_EXPERIENCE_E2E=1 → clean skip (no relay/daemon infra).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_SHARE_EXPERIENCE_E2E:-0}" = "1" ]; then
    echo "test-share-experience-e2e: ATTN_SKIP_SHARE_EXPERIENCE_E2E=1 — skipping (clean exit)"; exit 0
fi

: "${RELAY_PORT:=8799}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="${ATTN_EXTERNAL_RELAY:-http://localhost:${RELAY_PORT}}"
OWNER_HOME="/tmp/attn-se-owner"; REV_HOME="/tmp/attn-se-reviewer"
WORK="/tmp/attn-se-work"; DOCS="$WORK/owner-docs"; REVLOCAL="$WORK/reviewer-local"
SHOTS="$WORK/shots"
RELAY_LOG="$WORK/relay.log"; OWNER_LOG="$WORK/owner.log"; REV_LOG="$WORK/reviewer.log"
RELAY_PID=""; OWNER_PID=""; REV_PID=""; PASS=0; FAIL=0

log() { printf '\n==> %s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
info(){ printf '       %s\n' "$*"; }
attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rev()   { ATTN_HOME="$REV_HOME"   ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
ev_owner() { attn_owner --eval "$1" 2>/dev/null | sed 's/^"//; s/"$//'; }
ev_rev()   { attn_rev   --eval "$1" 2>/dev/null | sed 's/^"//; s/"$//'; }
poll() { local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
kill_pid() { local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }
shot() { local who="$1" name="$2" path; if [ "$who" = owner ]; then path=$(attn_owner --screenshot 2>/dev/null); else path=$(attn_rev --screenshot 2>/dev/null); fi; if [ -n "$path" ] && [ -f "$path" ]; then mkdir -p "$SHOTS"; cp "$path" "$SHOTS/${who}-${name}.png"; info "shot: $SHOTS/${who}-${name}.png"; fi; }
cleanup() { log "Cleaning up"; kill_pid "$OWNER_PID"; kill_pid "$REV_PID"; if [ -n "$RELAY_PID" ]; then pkill -P "$RELAY_PID" 2>/dev/null || true; kill_pid "$RELAY_PID"; fi; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -x "$ATTN_BIN" ] || { log "Building attn"; cargo build || exit 1; }

# JSON-decode --eval output so `\/`-escaping doesn't corrupt the invite URL.
json_decode() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)))}catch{process.stdout.write("")}})'; }

rm -rf "$OWNER_HOME" "$REV_HOME" "$WORK"
mkdir -p "$OWNER_HOME" "$REV_HOME" "$DOCS/deep" "$REVLOCAL" "$SHOTS"
printf '# Project Overview\n\nThe shared overview document.\n' > "$DOCS/index.md"
printf '# User Guide\n\nHow to use the thing.\n' > "$DOCS/guide.md"
printf '# Nested Notes\n\nDeep in a subfolder.\n' > "$DOCS/deep/nested.md"
printf '# Reviewer Local Scratch\n\nThis is the reviewer private file.\n' > "$REVLOCAL/mine.md"

if [ -n "${ATTN_EXTERNAL_RELAY:-}" ]; then
    curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 || { log "external relay unreachable"; exit 1; }
else
    [ -d "$PROJECT_DIR/relay/node_modules" ] || (cd relay && npm ci >/dev/null)
    log "Starting relay on :$RELAY_PORT"
    ( cd "$PROJECT_DIR/relay" && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
    deadline=$(( $(date +%s) + 60 )); while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; kill -0 "$RELAY_PID" 2>/dev/null || { log "relay died"; tail -20 "$RELAY_LOG"; exit 1; }; sleep 0.3; done
fi
log "Relay healthy"

log "Owner daemon on owner-docs/index.md; reviewer daemon on reviewer-local/mine.md"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$DOCS/index.md" >"$OWNER_LOG" 2>&1 & OWNER_PID=$!
ATTN_HOME="$REV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$REVLOCAL/mine.md" >"$REV_LOG" 2>&1 & REV_PID=$!
poll 30000 attn_owner --wait-for 'h1' --timeout 1000 || { bad "owner never rendered"; tail -20 "$OWNER_LOG"; echo; log "Result: $PASS passed, $FAIL failed"; exit 1; }
poll 30000 attn_rev   --wait-for 'h1' --timeout 1000 || { bad "reviewer never rendered"; tail -20 "$REV_LOG"; echo; log "Result: $PASS passed, $FAIL failed"; exit 1; }

log "Owner: attn review share owner-docs/"
attn_owner review share "$DOCS" 2>&1 | sed 's/^/    /'
owner_files() { [ "$(ev_owner 'String((window.__attn_review_store__?.snapshots||[]).reduce((s,x)=>(s.add(x.fileId),s),new Set()).size)')" -ge "$1" ] 2>/dev/null; }
if poll 30000 owner_files 3; then ok "owner folder-share published 3 files (incl. subfolder)"; else bad "owner shared <3 files"; fi

INVITE="$(attn_owner --eval 'window.__attn_review_store__?.currentShare?.inviteUrl || ""' 2>/dev/null | json_decode)"
[ -n "$INVITE" ] && ok "owner minted an invite" || { bad "no invite url on owner"; log "Result: $PASS passed, $FAIL failed"; exit 1; }

log "Reviewer: attn review join <invite>  (windowed daemon — NOT --as-agent)"
attn_rev review join "$INVITE" 2>&1 | sed 's/^/    /'
rev_joined() { local r; r="$(ev_rev 'String(window.__attn_review_store__?.currentRoomId)')"; [ "$r" != "null" ] && [ "$r" != "undefined" ] && [ -n "$r" ]; }
if poll 30000 rev_joined; then ok "#1 reviewer DAEMON joined (windowed, has a UI)"; else bad "#1 reviewer daemon never joined"; fi
rev_snap() { [ "$(ev_rev 'String((window.__attn_review_store__?.snapshots||[]).length)')" -ge 1 ] 2>/dev/null; }
poll 30000 rev_snap || true

REV_H1="$(ev_rev "document.querySelector('.attn-content-viewport h1, .ProseMirror h1')?.textContent || ''")"
case "$REV_H1" in
  "Project Overview"|"User Guide"|"Nested Notes") ok "#2 reviewer shows the SHARED document ('$REV_H1')";;
  *) bad "#2 reviewer not on shared doc (heading='$REV_H1')";;
esac
attn_rev --query '[data-slot=shared-doc-banner]' 2>/dev/null | grep -q '"count": *[1-9]' && ok "#2 shared-document banner present" || bad "#2 shared-document banner absent"

attn_rev --query '[data-slot=shared-file-tree]' 2>/dev/null | grep -q '"count": *[1-9]' && ok "#3 sidebar shared-file tree present" || bad "#3 sidebar shared-file tree absent"
attn_rev --query '[data-slot=review-file-nav] .review-file-tab' 2>/dev/null | grep -q '"count": *[2-9]' && ok "#3 top strip lists multiple files" || bad "#3 top strip missing files"
attn_rev --query '[data-slot=shared-file-tree-folder]' 2>/dev/null | grep -q '"count": *[1-9]' && ok "#3 shared tree shows a subfolder" || bad "#3 shared tree has no subfolder"

attn_owner --query '[data-slot=share-chip-files]' 2>/dev/null | grep -q '"count": *[1-9]' && ok "#5 owner status names the shared file(s)" || bad "#5 owner status does not name shared file(s)"

# #4 screenshots (best-effort; macOS debug builds only).
attn_owner --eval "document.querySelector('[data-slot=review-bar-peers] button')?.click()" >/dev/null 2>&1 || true
shot owner "menu-open"; shot reviewer "shared-view"

echo ""; log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
