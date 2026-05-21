#!/usr/bin/env bash
# Folder-share E2E. Boots a relay + an owner daemon opened on a file inside a
# directory (so the directory is watched recursively), runs
# `attn review share <dir>`, and asserts:
#   1. one snapshot per *.md under the dir (2; *.txt is skipped),
#   2. a newly-created *.md publishes live via the fs-watcher (-> 3),
# all in a single room.
#
# Every wait is a polled condition (per CLAUDE.md: never sleep on a condition).
# ATTN_SKIP_FOLDER_SHARE_E2E=1 → clean skip (no relay/daemon infra).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ "${ATTN_SKIP_FOLDER_SHARE_E2E:-0}" = "1" ]; then
    echo "test-folder-share-e2e: ATTN_SKIP_FOLDER_SHARE_E2E=1 — skipping (clean exit)"; exit 0
fi

: "${RELAY_PORT:=8796}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="${ATTN_EXTERNAL_RELAY:-http://localhost:${RELAY_PORT}}"
OWNER_HOME="/tmp/attn-fs-owner"; WORK="/tmp/attn-fs-work"; DOCS="$WORK/docs"
RELAY_LOG="$WORK/relay.log"; OWNER_LOG="$WORK/owner.log"
RELAY_PID=""; OWNER_PID=""; PASS=0; FAIL=0

log() { printf '==> %s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
attn_owner() { ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
poll() { local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
kill_pid() { local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; }
cleanup() { log "Cleaning up"; kill_pid "$OWNER_PID"; if [ -n "$RELAY_PID" ]; then pkill -P "$RELAY_PID" 2>/dev/null || true; kill_pid "$RELAY_PID"; fi; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -x "$ATTN_BIN" ] || { log "Building attn"; cargo build || exit 1; }
rm -rf "$OWNER_HOME" "$WORK"; mkdir -p "$OWNER_HOME" "$DOCS"
printf '# Alpha\n\nalpha body\n' > "$DOCS/a.md"
printf '# Bravo\n\nbravo body\n' > "$DOCS/b.md"
printf 'not markdown\n' > "$DOCS/notes.txt"

if [ -n "${ATTN_EXTERNAL_RELAY:-}" ]; then
    curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 || { log "external relay unreachable"; exit 1; }
else
    [ -d "$PROJECT_DIR/relay/node_modules" ] || (cd relay && npm ci >/dev/null)
    log "Starting relay on :$RELAY_PORT"
    ( cd "$PROJECT_DIR/relay" && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
    deadline=$(( $(date +%s) + 60 )); while [ "$(date +%s)" -lt "$deadline" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; kill -0 "$RELAY_PID" 2>/dev/null || { log "relay died"; exit 1; }; sleep 0.3; done
fi
log "Relay healthy"

log "Owner daemon (opened on docs/a.md → watches docs/ recursively)"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$DOCS/a.md" >"$OWNER_LOG" 2>&1 & OWNER_PID=$!
poll 30000 attn_owner --wait-for 'h1' --timeout 1000 || { bad "owner never rendered"; tail -20 "$OWNER_LOG"; echo; log "Result: $PASS passed, $FAIL failed"; exit 1; }

log "attn review share <docs dir>"
attn_owner review share "$DOCS" 2>&1 | sed 's/^/    /'

distinct_files() { attn_owner --eval "String(new Set(((window.__attn_review_store__&&window.__attn_review_store__.snapshots)||[]).map(function(s){return s.fileId;})).size)" 2>/dev/null | tr -d '"'; }
files_ge() { [ "$(distinct_files)" -ge "$1" ] 2>/dev/null; }

if poll 30000 files_ge 2; then ok "folder-share published one snapshot per .md ($(distinct_files) files, .txt skipped)"; else bad "expected >=2 distinct files, got '$(distinct_files)'"; fi

log "Add a new docs/c.md → expect a live publish (fs-watcher)"
printf '# Charlie\n\ncharlie body\n' > "$DOCS/c.md"
if poll 30000 files_ge 3; then ok "new file published live ($(distinct_files) files)"; else bad "expected >=3 distinct files after adding c.md, got '$(distinct_files)'"; fi

# One room for the whole folder.
rooms="$(grep -oE 'room=[A-Za-z0-9_-]+' "$OWNER_LOG" | sort -u | wc -l | tr -d ' ')"
[ "$rooms" = "1" ] && ok "all snapshots in a single room" || bad "expected 1 room, saw $rooms"

echo ""; log "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
