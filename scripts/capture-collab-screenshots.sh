#!/usr/bin/env bash
# Capture REAL collaboration screenshots for the marketing site.
#
# Boots a live session (owner + one reviewer) against a local relay and grabs
# two stories from the OWNER's window (the editorial-review surface, which never
# opens a composer — so no backdrop dim):
#
#   share-{light,dark}.png  — the "Share for review" dialog (npx command +
#                             direct link + end-to-end-encrypted blurb).
#   collab-{light,dark}.png — the shared doc with the reviewer's live caret,
#                             anchored highlights, and the inline comment +
#                             suggestion cards in the margin.
#   collab-hero.mp4         — an MP4 recording of the same live session while
#                             the reviewer types into the owner's shared doc.
#
# Requires a debug build (--screenshot is debug+macOS only).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${RELAY_PORT:=8793}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="http://localhost:${RELAY_PORT}"
OWNER_HOME="/tmp/attn-cap-owner"; RV_HOME="/tmp/attn-cap-rv"
WORK="/tmp/attn-cap-work"; SHARED_DOC="$WORK/launch-plan.md"; RELAY_LOG="$WORK/relay.log"
OUT="$PROJECT_DIR/site/static/screenshots"
RELAY_PID=""; OWNER_PID=""; RV_PID=""

log(){ printf '==> %s\n' "$*"; }
attn_owner(){ ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rv(){ ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
poll(){ local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
wait_ready(){ poll "${3:-25000}" "$1" --wait-for "$2" --timeout 1000; }
kill_pid(){ local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null||true; local i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 30 ];do sleep 0.1;i=$((i+1));done; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null||true; }
cleanup(){ log "cleanup"; kill_pid "$OWNER_PID"; kill_pid "$RV_PID"; [ -n "$RELAY_PID" ] && { pkill -P "$RELAY_PID" 2>/dev/null||true; kill_pid "$RELAY_PID"; }; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null||true; }
trap cleanup EXIT INT TERM

# Capture helpers (all shots are of the owner window).
shot(){ attn_owner --screenshot 2>/dev/null | grep -oE '/tmp/attn-screenshot-[0-9]+\.png' | tail -1; }
owner_window_id(){ attn_owner --info 2>/dev/null | awk '/^window_id:/ {print $2; exit}'; }
# Match the app's setTheme (theme.ts): set BOTH data-theme AND the .dark class,
# otherwise prose text color and shadcn surfaces disagree.
set_theme(){ attn_owner --eval "var d=document.documentElement;d.dataset.theme='$1';d.classList.toggle('dark','$1'==='dark');'x'" >/dev/null 2>&1; }
save(){ [ -n "$1" ] && cp "$1" "$OUT/$2" && log "wrote $2" || log "FAILED $2"; }
sel(){ attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var S=v.state.selection.constructor;v.focus();v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,$1,$2)));return 'ok';})()" >/dev/null 2>&1; }
# Select a substring by content (robust against position drift). $2 (optional)
# 'collapse' parks a caret at the start instead of selecting the range.
selText(){ local mode="${2:-}"; attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var doc=v.state.doc,n='$1',f=null;doc.descendants(function(node,pos){if(f||!node.isText)return !f;var i=node.text.indexOf(n);if(i>=0)f={a:pos+i,b:pos+i+n.length};return !f;});if(!f)return 'notfound';var S=v.state.selection.constructor;v.focus();var to='$mode'==='collapse'?f.a:f.b;v.dispatch(v.state.tr.setSelection(S.create(doc,f.a,to)));return 'ok';})()" 2>/dev/null | tr -d '"'; }
pm_insert_reviewer(){ local text="$1"; text="${text//\\/\\\\}"; text="${text//\'/\\\'}"; attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no-view';v.focus();v.dispatch(v.state.tr.insertText('$text'));return 'ok';})()" >/dev/null 2>&1; }
type_reviewer_text(){ local text="$1"; local i ch; for ((i=0; i<${#text}; i++)); do ch="${text:i:1}"; pm_insert_reviewer "$ch"; sleep 0.16; done; }
record_hero_video(){
  local out="$OUT/collab-hero.mp4"
  local raw="$WORK/collab-hero.mov"
  local wid
  wid="$(owner_window_id)"
  if [ -z "$wid" ]; then log "SKIP collab-hero.mp4 (no owner window id)"; return 0; fi
  if ! command -v screencapture >/dev/null 2>&1; then log "SKIP collab-hero.mp4 (screencapture missing)"; return 0; fi

  rm -f "$raw" "$out"
  set_theme dark
  sleep 0.6
  log "recording collab-hero.mp4 from owner window $wid"
  screencapture -x -v -V 8 -l "$wid" "$raw" >/dev/null 2>&1 &
  local rec_pid=$!
  sleep 0.9
  selText 'public launch' collapse >/dev/null
  sleep 0.5
  type_reviewer_text 'partner-led '
  sleep 1.4
  wait "$rec_pid" || { log "FAILED recording collab-hero.mp4"; return 0; }

  if [ ! -f "$raw" ]; then log "FAILED collab-hero.mp4 (recorder produced no file)"; return 0; fi
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -i "$raw" -an -vf "scale='min(1600,iw)':-2" -pix_fmt yuv420p -movflags +faststart "$out" >/dev/null 2>&1 \
      && log "wrote collab-hero.mp4" \
      || log "FAILED transcoding collab-hero.mp4"
  else
    mv "$raw" "$out"
    log "wrote collab-hero.mp4 (raw screencapture output)"
  fi
}

rm -rf "$OWNER_HOME" "$RV_HOME" "$WORK"; mkdir -p "$OWNER_HOME" "$RV_HOME" "$WORK" "$WORK/empty-rv" "$OUT"
cat > "$SHARED_DOC" <<'MD'
# Q3 Launch Plan

Ship the native viewer first, then open the review flow to a few teams.
Reviewers join from a link — no install required, end-to-end encrypted.

## Timeline

- Week 1 — internal dogfooding
- Week 2 — closed beta with design partners
- Week 3 — public launch on attn.sh
MD

[ -d relay/node_modules ] || (cd relay && npm ci >/dev/null)
log "relay :$RELAY_PORT"
( cd relay && exec npx wrangler dev --local --port "$RELAY_PORT" ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
d=$(( $(date +%s)+60 )); while [ "$(date +%s)" -lt "$d" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; sleep 0.3; done

log "boot owner + reviewer"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$SHARED_DOC" >"$WORK/owner.log" 2>&1 & OWNER_PID=$!
ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/empty-rv" >"$WORK/rv.log" 2>&1 & RV_PID=$!
wait_ready attn_owner 'h1' || { log "owner not ready"; exit 1; }
wait_ready attn_rv 'body' || { log "rv not ready"; exit 1; }

log "open Share dialog"
attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
wait_ready attn_owner '[data-slot=share-invite-url]' 20000 || { log "no invite"; exit 1; }
INVITE=""; d=$(( $(date +%s)+15 )); while [ "$(date +%s)" -lt "$d" ]; do INVITE="$(attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?.value||''" 2>/dev/null | tr -d '"\\' | tr -d '\r\n')"; case "$INVITE" in attn://review/*) break;; esac; sleep 0.3; done

# --- SHARE dialog shots (no reviewer yet → clean, no warnings) ---
dlg(){ attn_owner --eval "document.querySelector('[data-slot=share-invite-url]')?'open':'CLOSED'" 2>/dev/null | tr -d '"'; }
log "share dialog before light shot: $(dlg)"
sleep 1; save "$(shot)" share-light.png          # default theme is already light
set_theme dark; sleep 1; log "share dialog before dark shot: $(dlg)"; save "$(shot)" share-dark.png
set_theme light; sleep 1

# Close the dialog so the editorial shots show the doc — invoke the Done button
# (data-slot=share-start → handleDone → open=false) once it's enabled (the
# auto-mint disables it briefly). Poll until the dialog is actually gone.
for _ in $(seq 1 16); do
  [ "$(dlg)" = "CLOSED" ] && break
  attn_owner --eval "var b=document.querySelector('[data-slot=share-start]'); if(b&&!b.disabled){b.click();} 'x'" >/dev/null 2>&1
  sleep 0.4
done
log "share dialog after close: $(dlg)"

log "reviewer joins"
attn_rv --eval "window.ipc&&window.ipc.postMessage(JSON.stringify({type:'review_join',invite:'$INVITE'}));'x'" >/dev/null 2>&1
rv_has_doc(){ [ -n "$(attn_rv --eval "window.__attnPmView && window.__attnPmView.state.doc.textContent.includes('Launch Plan') ? 'y':''" 2>/dev/null | tr -d '"')" ]; }
d=$(( $(date +%s)+30 )); while [ "$(date +%s)" -lt "$d" ]; do rv_has_doc && break; sleep 0.5; done
log "reviewer shows shared doc: $(rv_has_doc && echo yes || echo NO)"

# --- Reviewer COMMENTS on the first paragraph ---
log "reviewer adds a comment: $(selText 'a few teams')"
attn_rv --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'.',code:'Period',metaKey:true,bubbles:true}));'x'" >/dev/null 2>&1
if wait_ready attn_rv '.comment-composer textarea' 8000; then
  attn_rv --fill '.comment-composer textarea' 'Can we open this to the whole waitlist, not just a few teams?' >/dev/null 2>&1
  attn_rv --click 'text=Submit' >/dev/null 2>&1
else log "comment composer did not open"; fi
sleep 1

# --- Reviewer SUGGESTS a replacement down in the Timeline (a different line, so
#     the two cards don't collide in the margin) ---
log "reviewer adds a suggestion: $(selText 'internal dogfooding')"
attn_rv --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'.',code:'Period',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
if wait_ready attn_rv '[data-slot=suggestion-composer-text]' 8000; then
  attn_rv --fill '[data-slot=suggestion-composer-text]' 'internal dogfooding + a team bug bash' >/dev/null 2>&1
  attn_rv --eval "document.querySelector('[data-slot=suggestion-composer-submit]')?.click(); 'x'" >/dev/null 2>&1
else log "suggestion composer did not open"; fi
sleep 1
# Did the suggestion register on the reviewer's OWN screen? (submit vs propagation)
log "reviewer self-sees suggestion: $(attn_rv --eval "document.body.textContent.includes('bug bash')?'yes':'no'" 2>/dev/null | tr -d '"')"

# Park the reviewer's caret on the launch line so the owner sees a live cursor.
selText 'public launch' collapse

# Wait for the owner's review-margin CARDS to actually render (rail auto-opens
# on first feedback, then cards y-position via coordsAtPos). Wait on the DOM,
# don't sleep blindly.
cards_n(){ attn_owner --query '.review-margin-slot' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0; }
d=$(( $(date +%s)+25 )); while [ "$(date +%s)" -lt "$d" ]; do [ "$(cards_n)" -ge 1 ] && break; sleep 0.5; done
log "owner review-margin cards: $(cards_n)"
log "owner transport: $(attn_owner --eval "(/Live|Connected|Offline/.exec(document.body.textContent)||['?'])[0]" 2>/dev/null | tr -d '"')"
log "owner persisted suggestion_created: $(grep -rqa 'suggestion_created' "$OWNER_HOME/reviews" 2>/dev/null && echo YES || echo NO)"
log "owner persisted comment_created: $(grep -rqa 'comment_created' "$OWNER_HOME/reviews" 2>/dev/null && echo YES || echo NO)"
attn_owner --eval "JSON.stringify({cards: document.querySelectorAll('[data-testid=review-margin-card]').length, trayChildren: (document.querySelector('[data-testid=review-margin-tray]')?.children.length||0), hasSuggestionText: document.body.textContent.includes('bug bash'), backdrop: !!document.querySelector('.comment-composer-backdrop, [data-slot=suggestion-composer], [data-slot=share-dialog]')})" 2>/dev/null

# --- Hero MP4 ---
record_hero_video

# --- Editorial shots ---
set_theme light; sleep 1; save "$(shot)" collab-light.png
set_theme dark; sleep 1; save "$(shot)" collab-dark.png
log "done"
