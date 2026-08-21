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
#   collab-hero-{light,dark}.mp4
#                           — MP4 recordings of the editorial workflow:
#                             reviewer comment, reviewer suggestion, then a
#                             live reviewer cursor in the owner's window.
#   collab-hero-{light,dark}.gif
#                           — compact GIF fallbacks generated from the MP4s.
#   share-flow-{light,dark}.gif
#                           — compact GIFs of the actual one-click Share flow.
#
# Requires a debug build (--screenshot is debug+macOS only).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

: "${RELAY_PORT:=8793}"
: "${ATTN_BIN:=$PROJECT_DIR/target/debug/attn}"
RELAY_URL="http://localhost:${RELAY_PORT}"
OWNER_HOME="/tmp/attn-cap-owner"; RV_HOME="/tmp/attn-cap-rv"; AGENT_HOME="/tmp/attn-cap-agent"
WORK="/tmp/attn-cap-work"; SHARED_DOC="$WORK/launch-plan.md"; RELAY_LOG="$WORK/relay.log"
SCRATCH="/tmp/attn-cap-scratch"
OUT="$PROJECT_DIR/site/static/screenshots"
LIGHT_CAPTURE_BG="#e3dfd8"
DARK_CAPTURE_BG="#090a0c"

: "${ATTN_CAPTURE_VARIANT:=}"
if [ -z "$ATTN_CAPTURE_VARIANT" ]; then
  for variant in light dark; do
    printf '==> capture hero variant: %s\n' "$variant"
    ATTN_CAPTURE_VARIANT="$variant" "$0" || exit $?
  done
  rm -f "$OUT/collab-hero.mp4" "$OUT/collab-hero.gif"
  exit 0
fi
case "$ATTN_CAPTURE_VARIANT" in
  light|dark) ;;
  *) echo "ATTN_CAPTURE_VARIANT must be light or dark" >&2; exit 2 ;;
esac
HERO_THEME="$ATTN_CAPTURE_VARIANT"
HERO_SUFFIX="$ATTN_CAPTURE_VARIANT"

RELAY_PID=""; OWNER_PID=""; RV_PID=""; AGENT_PID=""
AGENT_CMDS=""; AGENT_LOG=""

log(){ printf '==> %s\n' "$*"; }
attn_owner(){ ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_rv(){ ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
attn_agent(){ ATTN_HOME="$AGENT_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" "$@"; }
poll(){ local t="$1"; shift; local d=$(( $(date +%s)*1000 + t )); while [ "$(($(date +%s)*1000))" -lt "$d" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
wait_ready(){ poll "${3:-25000}" "$1" --wait-for "$2" --timeout 1000; }
kill_pid(){ local p="$1"; [ -z "$p" ] && return 0; kill "$p" 2>/dev/null||true; local i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 30 ];do sleep 0.1;i=$((i+1));done; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null||true; }
cleanup(){ log "cleanup"; kill_pid "$AGENT_PID"; kill_pid "$OWNER_PID"; kill_pid "$RV_PID"; [ -n "$RELAY_PID" ] && { pkill -P "$RELAY_PID" 2>/dev/null||true; kill_pid "$RELAY_PID"; }; pkill -f "wrangler dev --local --port $RELAY_PORT" 2>/dev/null||true; rm -rf "$SCRATCH"; }
trap cleanup EXIT INT TERM
focus_owner(){
  local pid
  pid="$(attn_owner --info 2>/dev/null | awk '/^pid:/ {print $2; exit}')"
  if [ -n "$pid" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "tell application \"System Events\" to set frontmost of first process whose unix id is $pid to true" >/dev/null 2>&1 || true
  fi
  attn_owner --eval "window.focus(); document.body.focus(); 'focused'" >/dev/null 2>&1 || true
  sleep 0.35
}
bg_for_theme(){ [ "$1" = "dark" ] && printf '%s' "$DARK_CAPTURE_BG" || printf '%s' "$LIGHT_CAPTURE_BG"; }
theme_for_asset(){ case "$1" in *-dark.*|*-dark) printf 'dark';; *) printf 'light';; esac; }
media_dims(){ ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$1" 2>/dev/null | head -1; }
flatten_png_capture(){
  local src="$1" dest="$2" theme="$3" dims bg tmp
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then cp "$src" "$dest"; return $?; fi
  dims="$(media_dims "$src")"
  [ -z "$dims" ] && { cp "$src" "$dest"; return $?; }
  bg="$(bg_for_theme "$theme")"
  tmp="$SCRATCH/flatten-$(basename "$dest")"
  ffmpeg -y -f lavfi -i "color=c=${bg}:s=${dims}:r=1" -i "$src" \
    -filter_complex "[1:v]format=rgba[fg];[0:v][fg]overlay=shortest=1:format=auto,format=rgb24[out]" \
    -map "[out]" -frames:v 1 "$tmp" >/dev/null 2>&1 \
    && mv "$tmp" "$dest"
}
flatten_window_video(){
  local src="$1" dest="$2" theme="$3" dims bg
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then mv "$src" "$dest"; return $?; fi
  dims="$(media_dims "$src")"
  [ -z "$dims" ] && return 1
  bg="$(bg_for_theme "$theme")"
  if [ "$theme" = "light" ]; then
    ffmpeg -y -f lavfi -i "color=c=${bg}:s=${dims}:r=60" -i "$src" \
      -filter_complex "[1:v]format=rgba,colorkey=0x000000:0.018:0.0[fg];[0:v][fg]overlay=shortest=1:format=auto[flat];[flat]scale='min(1600,iw)':-2,format=yuv420p[out]" \
      -map "[out]" -an -movflags +faststart "$dest" >/dev/null 2>&1
  else
    ffmpeg -y -f lavfi -i "color=c=${bg}:s=${dims}:r=60" -i "$src" \
      -filter_complex "[1:v]format=rgba[fg];[0:v][fg]overlay=shortest=1:format=auto[flat];[flat]scale='min(1600,iw)':-2,format=yuv420p[out]" \
      -map "[out]" -an -movflags +faststart "$dest" >/dev/null 2>&1
  fi
}

# Capture helpers (all shots are of the owner window).
shot(){ attn_owner --screenshot 2>/dev/null | grep -oE '/tmp/attn-screenshot-[0-9]+\.png' | tail -1; }
owner_window_id(){ attn_owner --info 2>/dev/null | awk '/^window_id:/ {print $2; exit}'; }
reviewer_window_id(){ attn_rv --info 2>/dev/null | awk '/^window_id:/ {print $2; exit}'; }
owner_shot(){
  local wid out native
  focus_owner
  # Native WKWebView snapshot first: exact webview pixels (1920×1440 at 2x),
  # independent of Spaces/occlusion — `screencapture -l` of an off-space
  # window silently returns a ~214px proxy thumbnail.
  native="$(shot)"
  if [ -n "$native" ] && [ -f "$native" ]; then echo "$native"; return 0; fi
  wid="$(owner_window_id)"
  out="$SCRATCH/owner-shot-$(date +%s%N).png"
  if [ -n "$wid" ] && command -v screencapture >/dev/null 2>&1; then
    screencapture -x -o -l "$wid" "$out" >/dev/null 2>&1 && { echo "$out"; return 0; }
  fi
  return 1
}
# Match the app's setTheme (theme.ts): set BOTH data-theme AND the .dark class,
# otherwise prose text color and shadcn surfaces disagree.
set_theme(){ attn_owner --eval "var d=document.documentElement;d.dataset.theme='$1';d.classList.toggle('dark','$1'==='dark');'x'" >/dev/null 2>&1; }
save(){
  local src="$1" name="$2" theme
  if [ -z "$src" ]; then log "FAILED $name"; return 0; fi
  theme="$(theme_for_asset "$name")"
  flatten_png_capture "$src" "$OUT/$name" "$theme" && log "wrote $name" || log "FAILED $name"
}
sel(){ attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var S=v.state.selection.constructor;v.focus();v.dispatch(v.state.tr.setSelection(S.create(v.state.doc,$1,$2)));return 'ok';})()" >/dev/null 2>&1; }
# Select a substring by content (robust against position drift). $2 (optional)
# 'collapse' parks a caret at the start instead of selecting the range.
selText(){ local mode="${2:-}"; attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no';var doc=v.state.doc,n='$1',f=null;doc.descendants(function(node,pos){if(f||!node.isText)return !f;var i=node.text.indexOf(n);if(i>=0)f={a:pos+i,b:pos+i+n.length};return !f;});if(!f)return 'notfound';var S=v.state.selection.constructor;v.focus();var to='$mode'==='collapse'?f.a:f.b;v.dispatch(v.state.tr.setSelection(S.create(doc,f.a,to)));return 'ok';})()" 2>/dev/null | tr -d '"'; }
pm_insert_reviewer(){ local text="$1"; text="${text//\\/\\\\}"; text="${text//\'/\\\'}"; attn_rv --eval "(function(){var v=window.__attnPmView;if(!v)return 'no-view';v.focus();v.dispatch(v.state.tr.insertText('$text'));return 'ok';})()" >/dev/null 2>&1; }
type_reviewer_text(){ local text="$1"; local i ch; for ((i=0; i<${#text}; i++)); do ch="${text:i:1}"; pm_insert_reviewer "$ch"; sleep 0.16; done; }
# Stage a persona display name directly in a home's identity.json. Announces
# (ParticipantJoined) load the identity fresh, so editing between boot and
# share/join is enough — and it keeps the first-run name prompt out of the
# captures.
set_identity_name(){
  python3 - "$1" "$2" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["displayName"] = name
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
}
# Fallback if the first-run name prompt still appears in front of a flow.
confirm_name_prompt(){ # $1 = attn fn, $2 = persona name
  if "$1" --wait-for '[data-slot=name-prompt-input]' --timeout 2500 >/dev/null 2>&1; then
    "$1" --fill '[data-slot=name-prompt-input]' "$2" >/dev/null 2>&1
    sleep 0.3
    "$1" --eval "document.querySelector('[data-slot=name-prompt-confirm]')?.click();'x'" >/dev/null 2>&1
    sleep 0.6
  fi
}
# Count owner margin cards of one kind.
sugg_cards_owner(){ attn_owner --eval "document.querySelectorAll('[data-testid=review-margin-card][data-kind=suggestion]').length" 2>/dev/null | tr -d '"'; }
# Append one JSON command line to the headless agent's command file.
agent_suggest_diff(){
  python3 - "$1" >> "$AGENT_CMDS" <<'PY'
import json, sys
print(json.dumps({"cmd": "suggest-diff", "diff": open(sys.argv[1]).read()}))
PY
}
drive_hero_workflow(){
  sleep 0.8

  log "hero workflow: reviewer comments on launch scope"
  selText 'a few teams' >/dev/null
  sleep 0.35
  attn_rv --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'.',code:'Period',metaKey:true,bubbles:true}));'x'" >/dev/null 2>&1
  confirm_name_prompt attn_rv "Sam Porter"
  if wait_ready attn_rv '.comment-composer textarea' 8000; then
    attn_rv --fill '.comment-composer textarea' 'Can we open this to the whole waitlist, not just a few teams?' >/dev/null 2>&1
    sleep 0.35
    attn_rv --click 'text=Submit' >/dev/null 2>&1
  else
    log "comment composer did not open"
  fi
  sleep 1.3

  # The suggestion beat now belongs to the AGENT (landing cast: one human
  # comment + one agent-attributed suggestion in the same margin). The
  # headless participant anchors a diff hunk against the shared snapshot.
  log "hero workflow: agent suggests editorial rewrite"
  agent_suggest_diff "$AGENT_DIFF"
  d=$(( $(date +%s)+20 ))
  while [ "$(date +%s)" -lt "$d" ]; do
    [ "$(sugg_cards_owner)" -ge 1 ] 2>/dev/null && break
    sleep 0.5
  done
  log "owner shows agent suggestion card: $(sugg_cards_owner)"
  sleep 1.3

  log "hero workflow: reviewer parks a live cursor"
  selText 'public launch' collapse >/dev/null
  sleep 1.8
}
encode_hero_gif(){
  local mp4="$OUT/collab-hero-${HERO_SUFFIX}.mp4"
  local gif="$OUT/collab-hero-${HERO_SUFFIX}.gif"
  local palette="$SCRATCH/collab-hero-${HERO_SUFFIX}-palette.png"
  if [ ! -f "$mp4" ]; then log "SKIP collab-hero-${HERO_SUFFIX}.gif (missing MP4)"; return 0; fi
  if ! command -v ffmpeg >/dev/null 2>&1; then log "SKIP collab-hero-${HERO_SUFFIX}.gif (ffmpeg missing)"; return 0; fi

  rm -f "$gif" "$palette"
  ffmpeg -y -i "$mp4" -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" "$palette" >/dev/null 2>&1 \
    && ffmpeg -y -i "$mp4" -i "$palette" -filter_complex "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$gif" >/dev/null 2>&1 \
    && log "wrote collab-hero-${HERO_SUFFIX}.gif" \
    || log "FAILED transcoding collab-hero-${HERO_SUFFIX}.gif"
}
record_hero_video(){
  local out="$OUT/collab-hero-${HERO_SUFFIX}.mp4"
  local raw="$SCRATCH/collab-hero-${HERO_SUFFIX}.mov"
  local wid
  # Stills-only mode: the workflow must still run (it stages the margin cards
  # the editorial shots need), but the screen recording is skipped — it is the
  # slowest leg and long runs let the relay WS idle into an Offline chip.
  if [ "${ATTN_CAPTURE_SKIP_VIDEO:-0}" = "1" ]; then
    log "skipping hero video (ATTN_CAPTURE_SKIP_VIDEO=1); staging workflow only"
    set_theme "$HERO_THEME"
    focus_owner
    drive_hero_workflow
    return 0
  fi
  wid="$(owner_window_id)"
  if [ -z "$wid" ]; then log "SKIP collab-hero-${HERO_SUFFIX}.mp4 (no owner window id)"; return 0; fi
  if ! command -v screencapture >/dev/null 2>&1; then log "SKIP collab-hero-${HERO_SUFFIX}.mp4 (screencapture missing)"; return 0; fi

  rm -f "$raw" "$out"
  set_theme "$HERO_THEME"
  focus_owner
  sleep 0.6
  log "recording collab-hero-${HERO_SUFFIX}.mp4 from owner window $wid"
  screencapture -x -o -v -V 10 -l "$wid" "$raw" >/dev/null 2>&1 &
  local rec_pid=$!
  drive_hero_workflow
  wait "$rec_pid" || { log "FAILED recording collab-hero-${HERO_SUFFIX}.mp4"; return 0; }

  if [ ! -f "$raw" ]; then log "FAILED collab-hero-${HERO_SUFFIX}.mp4 (recorder produced no file)"; return 0; fi
  if command -v ffmpeg >/dev/null 2>&1; then
    flatten_window_video "$raw" "$out" "$HERO_THEME" \
      && log "wrote collab-hero-${HERO_SUFFIX}.mp4" \
      || log "FAILED transcoding collab-hero-${HERO_SUFFIX}.mp4"
  else
    mv "$raw" "$out"
    log "wrote collab-hero-${HERO_SUFFIX}.mp4 (raw screencapture output)"
  fi
  encode_hero_gif
}
encode_share_flow_gif(){
  local raw="$1"
  local gif="$OUT/share-flow-${HERO_SUFFIX}.gif"
  local palette="$SCRATCH/share-flow-${HERO_SUFFIX}-palette.png"
  local flat="$SCRATCH/share-flow-${HERO_SUFFIX}-flat.mp4"
  if [ ! -f "$raw" ]; then log "SKIP share-flow-${HERO_SUFFIX}.gif (missing recording)"; return 0; fi
  if ! command -v ffmpeg >/dev/null 2>&1; then log "SKIP share-flow-${HERO_SUFFIX}.gif (ffmpeg missing)"; return 0; fi

  rm -f "$gif" "$palette" "$flat"
  flatten_window_video "$raw" "$flat" "$HERO_THEME" || { log "FAILED flattening share-flow-${HERO_SUFFIX}.gif"; return 0; }
  ffmpeg -y -i "$flat" -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" "$palette" >/dev/null 2>&1 \
    && ffmpeg -y -i "$flat" -i "$palette" -filter_complex "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$gif" >/dev/null 2>&1 \
    && log "wrote share-flow-${HERO_SUFFIX}.gif" \
    || log "FAILED transcoding share-flow-${HERO_SUFFIX}.gif"
}
record_share_flow(){
  local raw="$SCRATCH/share-flow-${HERO_SUFFIX}.mov"
  local wid
  wid="$(owner_window_id)"
  set_theme "$HERO_THEME"
  focus_owner
  sleep 0.5

  # ⌘⇧S opens the file-picker step; `share-start` ("Create review link…")
  # mints the durable share and swaps the dialog into its link/command state.
  drive_share_dialog(){
    attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
    confirm_name_prompt attn_owner "Maya Alvarez"
    wait_ready attn_owner '[data-slot=share-start]' 10000 || { log "share dialog did not open"; return 1; }
    sleep 0.8
    attn_owner --eval "document.querySelector('[data-slot=share-start]')?.click();'x'" >/dev/null 2>&1
    wait_ready attn_owner '[data-slot=share-invite-url]' 20000
  }

  if [ -n "$wid" ] && command -v screencapture >/dev/null 2>&1; then
    rm -f "$raw" "$OUT/share-flow-${HERO_SUFFIX}.gif"
    log "recording share-flow-${HERO_SUFFIX}.gif from owner window $wid"
    screencapture -x -o -v -V 8 -l "$wid" "$raw" >/dev/null 2>&1 &
    local rec_pid=$!
    sleep 0.65
    drive_share_dialog || { log "no invite"; kill_pid "$rec_pid"; exit 1; }
    sleep 1.2
    wait "$rec_pid" || log "FAILED recording share-flow-${HERO_SUFFIX}.gif"
    encode_share_flow_gif "$raw"
  else
    log "open Share dialog"
    drive_share_dialog || { log "no invite"; exit 1; }
  fi
}

rm -rf "$OWNER_HOME" "$RV_HOME" "$AGENT_HOME" "$WORK" "$SCRATCH"; mkdir -p "$OWNER_HOME" "$RV_HOME" "$AGENT_HOME" "$WORK" "$WORK/empty-rv" "$SCRATCH" "$OUT"
AGENT_CMDS="$WORK/agent-cmds.jsonl"; AGENT_LOG="$WORK/agent.log"; AGENT_DIFF="$WORK/agent-suggestion.diff"
# The "Review loop" section exists so the hero window's bottom third carries
# document instead of empty paper (landing critique 2026-08-18) — and the copy
# it carries is the product's own thesis.
cat > "$SHARED_DOC" <<'MD'
# Q3 Launch Plan

Ship the native viewer first, then open the review flow to a few teams.
Reviewers join from a link — no install required, end-to-end encrypted.

## Timeline

- Week 1 — internal dogfooding
- Week 2 — closed beta with design partners
- Week 3 — public launch on attn.sh

## Review loop

Comments and suggestions land in one margin, attributed to their author.
The file on disk changes only when the owner accepts a change.
MD
cat > "$AGENT_DIFF" <<'DIFF'
--- a/launch-plan.md
+++ b/launch-plan.md
@@ -8 +8 @@
-- Week 1 — internal dogfooding
+- Week 1 — internal dogfooding + a team bug bash
DIFF

[ -d relay/node_modules ] || (cd relay && npm ci >/dev/null)
log "relay :$RELAY_PORT"
# QUOTA_ALLOW_UNATTRIBUTED_CREATES: local wrangler has no CF-Connecting-IP, so
# durable-share creation 503s (ATTN_QUOTA_UNAVAILABLE) without it — same var
# relay/package.json's dev script passes.
( cd relay && exec npx wrangler dev --local --port "$RELAY_PORT" --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true ) >"$RELAY_LOG" 2>&1 & RELAY_PID=$!
d=$(( $(date +%s)+60 )); while [ "$(date +%s)" -lt "$d" ]; do curl -fsS "$RELAY_URL/health" >/dev/null 2>&1 && break; sleep 0.3; done

log "boot owner + reviewer"
ATTN_HOME="$OWNER_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$SHARED_DOC" >"$WORK/owner.log" 2>&1 & OWNER_PID=$!
ATTN_HOME="$RV_HOME" ATTN_RELAY_URL="$RELAY_URL" "$ATTN_BIN" --no-fork "$WORK/empty-rv" >"$WORK/rv.log" 2>&1 & RV_PID=$!
wait_ready attn_owner 'h1' || { log "owner not ready"; exit 1; }
wait_ready attn_rv 'body' || { log "rv not ready"; exit 1; }

# Personas, not the machine's git identity (the boot created identity.json;
# the share/join announces re-read it).
set_identity_name "$OWNER_HOME/identity.json" "Maya Alvarez" && log "owner persona set"
set_identity_name "$RV_HOME/identity.json" "Sam Porter" && log "reviewer persona set"

record_share_flow
# The url slot now carries the HTTPS browser link; the attn:// deep link the
# native CLI join needs lives in the "Send this command" card.
INVITE=""; d=$(( $(date +%s)+15 )); while [ "$(date +%s)" -lt "$d" ]; do INVITE="$(attn_owner --eval "((document.querySelector('[data-slot=share-cli-command]')?.textContent||'').match(/attn:\\/\\/review\\/[^' ]+/)||[''])[0]" 2>/dev/null | tr -d '"' | sed 's|\\/|/|g' | tr -d '\r\n')"; case "$INVITE" in attn://review/*) break;; esac; sleep 0.3; done
ROOM_ID="$(printf '%s' "$INVITE" | sed -E 's|^attn://review/([^#?]+).*|\1|')"

# --- SHARE dialog shots (no reviewer yet → clean, no warnings) ---
# Visibility, not DOM presence: closed overlays stay mounted (`display: none`
# per the Truth Rule), so a presence probe lies about what pixels show.
dlg(){ attn_owner --eval "var d=document.querySelector('[data-slot=share-dialog]'); d&&(d.offsetWidth||d.offsetHeight)?'open':'CLOSED'" 2>/dev/null | tr -d '"'; }
ensure_share_dialog(){
  [ "$(dlg)" = "open" ] && return 0
  attn_owner --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'x'" >/dev/null 2>&1
  sleep 1.2
  [ "$(dlg)" = "open" ]
}
set_theme light
ensure_share_dialog || log "share dialog could not be reopened"
log "share dialog before light shot: $(dlg)"
sleep 1; save "$(owner_shot)" share-light.png
set_theme dark; sleep 1; ensure_share_dialog; log "share dialog before dark shot: $(dlg)"; save "$(owner_shot)" share-dark.png
set_theme light; sleep 1

# Close the dialog so the editorial shots show the doc — invoke the Done button
# (data-slot=share-start → handleDone → open=false) once it's enabled (the
# auto-mint disables it briefly). Poll until the dialog is actually gone.
for _ in $(seq 1 16); do
  [ "$(dlg)" = "CLOSED" ] && break
  attn_owner --eval "var b=document.querySelector('[data-slot=share-start]'); if(b&&!b.disabled){b.click();} var e=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}); document.dispatchEvent(e); window.dispatchEvent(e); 'x'" >/dev/null 2>&1
  # The dialog's own × carries an accessible "Close" — the one path that
  # cannot be argued with by focus-trap or synthetic-event quirks.
  attn_owner --click 'text=Close' >/dev/null 2>&1
  sleep 0.4
done
log "share dialog after close: $(dlg)"
[ "$(dlg)" = "CLOSED" ] || { log "FATAL: share dialog still open before editorial shots"; exit 1; }

log "reviewer joins"
# Daemon-routed CLI join: the webview's review_join IPC is privileged (token
# only the app bundle holds), so a raw postMessage is rejected.
attn_rv review join "$INVITE" >/dev/null 2>&1 || log "reviewer join command failed"
rv_has_doc(){ [ -n "$(attn_rv --eval "window.__attnPmView && window.__attnPmView.state.doc.textContent.includes('Launch Plan') ? 'y':''" 2>/dev/null | tr -d '"')" ]; }
d=$(( $(date +%s)+30 )); while [ "$(date +%s)" -lt "$d" ]; do rv_has_doc && break; sleep 0.5; done
log "reviewer shows shared doc: $(rv_has_doc && echo yes || echo NO)"

# Park the reviewer's caret before recording so the owner window starts with a
# visible collaborator, then let the recording itself tell the feedback story.
selText 'public launch' collapse >/dev/null

# --- Agent participant joins headlessly (kind=agent → violet/hex in the UI).
#     It signs with its own home's base identity and gets a suggest-tier
#     invite, so its diff-anchored suggestion is allowed and attributed. ---
log "agent joins headlessly"
# Suggest-tier invite minted by room id (path matching predates the durable
# share flow and no longer resolves).
AGENT_INVITE="$(attn_owner review invite "$ROOM_ID" --tier suggest 2>/dev/null | tail -1 | tr -d '\r\n')"
case "$AGENT_INVITE" in
  attn://review/*) ;;
  *) log "no agent invite (got: ${AGENT_INVITE:-empty})"; exit 1 ;;
esac
: > "$AGENT_CMDS"
ATTN_HOME="$AGENT_HOME" ATTN_RELAY_URL="$RELAY_URL" ATTN_AGENT_CMD_FILE="$AGENT_CMDS" \
  "$ATTN_BIN" review agent >"$AGENT_LOG" 2>&1 & AGENT_PID=$!
d=$(( $(date +%s)+20 )); while [ "$(date +%s)" -lt "$d" ]; do grep -q '@agent ready' "$AGENT_LOG" 2>/dev/null && break; sleep 0.3; done
# Name the agent BEFORE the join announce; the announce reads identity.json.
set_identity_name "$AGENT_HOME/identity.json" "Claude" && log "agent persona set"
python3 - "$AGENT_INVITE" >> "$AGENT_CMDS" <<'PY'
import json, sys
print(json.dumps({"cmd": "join", "invite": sys.argv[1], "kind": "agent"}))
PY
# Joined once updates start flowing into the agent's store.
d=$(( $(date +%s)+30 )); while [ "$(date +%s)" -lt "$d" ]; do grep -q '@update' "$AGENT_LOG" 2>/dev/null && break; sleep 0.5; done
log "agent runtime: $(grep -c '@update' "$AGENT_LOG" 2>/dev/null || echo 0) update line(s)"

# --- Hero MP4/GIF ---
record_hero_video

# Did the agent's suggestion propagate to the OTHER peer too? (mesh, not just owner)
log "reviewer sees agent suggestion: $(attn_rv --eval "document.querySelectorAll('[data-testid=review-margin-card][data-kind=suggestion]').length>=1?'yes':'no'" 2>/dev/null | tr -d '"')"

# Wait for the owner's review-margin CARDS to actually render (rail auto-opens
# on first feedback, then cards y-position via coordsAtPos). Wait on the DOM,
# don't sleep blindly.
cards_n(){ attn_owner --query '.review-margin-slot' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0; }
# Two cards now: the reviewer's comment and the agent's suggestion.
d=$(( $(date +%s)+25 )); while [ "$(date +%s)" -lt "$d" ]; do [ "$(cards_n)" -ge 2 ] && break; sleep 0.5; done
log "owner review-margin cards: $(cards_n)"
log "owner transport: $(attn_owner --eval "(/Live|Connected|Offline/.exec(document.body.textContent)||['?'])[0]" 2>/dev/null | tr -d '"')"
log "owner persisted suggestion_created: $(grep -rqa 'suggestion_created' "$OWNER_HOME/reviews" 2>/dev/null && echo YES || echo NO)"
log "owner persisted comment_created: $(grep -rqa 'comment_created' "$OWNER_HOME/reviews" 2>/dev/null && echo YES || echo NO)"
log "capture window ids: owner=$(owner_window_id) reviewer=$(reviewer_window_id)"
attn_owner --eval "JSON.stringify({sharedBanner: !!document.querySelector('[data-slot=shared-doc-banner]'), cards: document.querySelectorAll('[data-testid=review-margin-card]').length, trayChildren: (document.querySelector('[data-testid=review-margin-tray]')?.children.length||0), hasSuggestionText: document.body.textContent.includes('bug bash'), backdrop: !!document.querySelector('.comment-composer-backdrop, [data-slot=suggestion-composer], [data-slot=share-dialog]')})" 2>/dev/null

# --- Editorial shots ---
# The header transport chip is in frame: wait for Live so the capture doesn't
# ship an Offline badge next to a "Review room · live" claim.
d=$(( $(date +%s)+25 )); while [ "$(date +%s)" -lt "$d" ]; do
  [ "$(attn_owner --eval "(/Live|Connected|Offline/.exec(document.body.textContent)||['?'])[0]" 2>/dev/null | tr -d '"')" = "Live" ] && break
  sleep 1
done
set_theme light; sleep 1; save "$(owner_shot)" collab-light.png
set_theme dark; sleep 1; save "$(owner_shot)" collab-dark.png
log "done"
