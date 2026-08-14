#!/usr/bin/env bash
# Native-owner -> hosted-browser Playwright E2E.
#
# By default this starts an isolated local relay, hosted Vite app, and native
# owner. Set E2E_RELAY_URL and E2E_WEB_ORIGIN together to run the same proof
# against an already-deployed staging environment. The owner shares a canary
# document; Chromium joins through the generated browser invite and verifies
# document rendering (including an oversized R2 snapshot), fragment stripping,
# real PoW registration, explicit encrypted recovery, and content-blind wire.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELAY_PORT="${RELAY_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
RELAY_URL="${E2E_RELAY_URL:-http://127.0.0.1:${RELAY_PORT}}"
# Must match relay/wrangler.toml's staging browser-origin allowlist exactly.
# Vite still binds loopback-only below; this is the browser-visible origin.
WEB_ORIGIN="${E2E_WEB_ORIGIN:-http://localhost:${WEB_PORT}}"
ATTN_BIN="${ATTN_BIN:-$PROJECT_DIR/target/debug/attn}"
WORK="$(mktemp -d /tmp/attn-hosted-e2e.XXXXXX)"
ATTN_HOME="$WORK/owner-home"
SHARE_DIR="$WORK/shared"
DOC="$SHARE_DIR/hosted.md"
SIBLING_DOC="$SHARE_DIR/sibling.md"
R2_DOC="$SHARE_DIR/r2-large.md"
RELAY_LOG="$WORK/relay.log"
RELAY_STATE="$WORK/relay-state"
WEB_LOG="$WORK/web.log"
OWNER_LOG="$WORK/owner.log"
COMMENT_CANARY="BROWSER-COMMENT-8127"
REPLY_CANARY="BROWSER-REPLY-4631"
SUGGESTION_CANARY="BROWSER-SUGGEST-9054"
R2_CANARY="R2-BROWSER-SEALED-2048"
DIRECT_CANARY="BROWSER-DIRECT-2718"
NATIVE_DIRECT_CANARY="NATIVE-DIRECT-1618"
FALLBACK_CANARY="BROWSER-FALLBACK-3141"
RELAY_PID=""
WEB_PID=""
OWNER_PID=""

kill_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  kill_pid "$OWNER_PID"
  kill_pid "$WEB_PID"
  kill_pid "$RELAY_PID"
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1" deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

mkdir -p "$ATTN_HOME" "$SHARE_DIR" "$RELAY_STATE"
printf '# Hosted review canary\n\n- [ ] Read-only browser task\n\nCiphertext boundary marker: NARWHAL-TEAK-7429.\n\nShared by native, rendered in the hosted reviewer.\n' >"$DOC"
printf '# Folder sibling canary\n\nSwitching files must switch decrypted document content.\n' >"$SIBLING_DOC"
{
  printf '# R2 snapshot canary\n\n%s\n\n<!--\n' "$R2_CANARY"
  # Incompressible filler, deliberately. The R2 spillover decision is made on
  # the CIPHERTEXT size after snapshot compression (bootstrap.rs
  # RELAY_BLOB_SPILLOVER_THRESHOLD_BYTES), and the old 1.2 MB of repeated 'x'
  # deflates to a few KB — so this document quietly stopped exercising the R2
  # lane the day compression landed, and the suite's `?cap=` assertion went
  # dead. Base64 of random bytes stays ~1.8 MB after compression: over the
  # 1 MiB spillover threshold, under the 5 MiB snapshot cap.
  dd if=/dev/urandom bs=1800000 count=1 2>/dev/null | base64
  printf '\n-->\n'
} >"$R2_DOC"

if { [ -n "${E2E_RELAY_URL:-}" ] && [ -z "${E2E_WEB_ORIGIN:-}" ]; } ||
   { [ -z "${E2E_RELAY_URL:-}" ] && [ -n "${E2E_WEB_ORIGIN:-}" ]; }; then
  echo 'E2E_RELAY_URL and E2E_WEB_ORIGIN must be set together' >&2
  exit 1
fi

if [ ! -x "$ATTN_BIN" ]; then
  (cd "$PROJECT_DIR" && cargo build -p attn)
fi

if [ -z "${E2E_RELAY_URL:-}" ]; then
  (
    cd "$PROJECT_DIR/relay"
    exec npx wrangler dev --env staging --local --port "$RELAY_PORT" \
      --persist-to "$RELAY_STATE" \
      --var QUOTA_ALLOW_UNATTRIBUTED_CREATES:true \
      --var BLOB_CAP_SIGNING_KEY:local-e2e-blob-cap-signing-key-32bytes
  ) >"$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
fi
wait_http "$RELAY_URL/health" || { tail -80 "$RELAY_LOG"; exit 1; }

if [ -z "${E2E_WEB_ORIGIN:-}" ]; then
  (
    cd "$PROJECT_DIR/web"
    VITE_ATTN_RELAY_URL="$RELAY_URL" exec npm run dev:browser -- --host 127.0.0.1 --port "$WEB_PORT"
  ) >"$WEB_LOG" 2>&1 &
  WEB_PID=$!
fi
wait_http "$WEB_ORIGIN" || { tail -80 "$WEB_LOG"; exit 1; }

ATTN_HOME="$ATTN_HOME" \
ATTN_RELAY_URL="$RELAY_URL" \
ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" \
  "$ATTN_BIN" --no-fork "$SHARE_DIR" >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --wait-for h1 --timeout 1000 >/dev/null 2>&1; then
    break
  fi
  kill -0 "$OWNER_PID" 2>/dev/null || { tail -80 "$OWNER_LOG"; exit 1; }
  sleep 0.2
done
ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --wait-for h1 --timeout 1000 >/dev/null
ATTN_HOME="$ATTN_HOME" ATTN_RELAY_URL="$RELAY_URL" \
ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" \
  "$ATTN_BIN" review share "$SHARE_DIR" >/dev/null

INVITE=""
COMMENT_INVITE=""
VIEW_INVITE=""
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  raw="$(ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --eval 'JSON.stringify({suggest: window.__attn_review_store__?.currentShare?.browserSuggestInviteUrl || "", comment: window.__attn_review_store__?.currentShare?.browserInviteUrl || "", view: window.__attn_review_store__?.currentShare?.browserViewInviteUrl || ""})' 2>/dev/null || true)"
  invites="$(node -e 'const raw=process.argv[1]; try { const value=JSON.parse(JSON.parse(raw)); process.stdout.write([value.suggest,value.comment,value.view].join("\n")); } catch {}' "$raw")"
  INVITE="$(printf '%s\n' "$invites" | sed -n '1p')"
  COMMENT_INVITE="$(printf '%s\n' "$invites" | sed -n '2p')"
  VIEW_INVITE="$(printf '%s\n' "$invites" | sed -n '3p')"
  [ -n "$INVITE" ] && [ -n "$COMMENT_INVITE" ] && [ -n "$VIEW_INVITE" ] && break
  sleep 0.2
done
[ -n "$INVITE" ] && [ -n "$COMMENT_INVITE" ] && [ -n "$VIEW_INVITE" ] || { tail -80 "$OWNER_LOG"; tail -80 "$RELAY_LOG"; exit 1; }

ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --eval "window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',metaKey:true,shiftKey:true,bubbles:true}));'opened'" >/dev/null
deadline=$((SECONDS + 10))
while [ "$SECONDS" -lt "$deadline" ]; do
  ready="$(ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --eval "Boolean(document.querySelector('[data-slot=share-tier-view]'))" 2>/dev/null || true)"
  [ "$ready" = "true" ] && break
  sleep 0.2
done
[ "${ready:-false}" = "true" ] || { echo 'hosted E2E failed: tiered share sheet did not render' >&2; exit 1; }

for tier_and_label in \
  'view|Anyone with this link can view' \
  'comment|Anyone with this link can comment' \
  'suggest|Anyone with this link can suggest'
do
  tier="${tier_and_label%%|*}"
  expected="${tier_and_label#*|}"
  actual="$(ATTN_HOME="$ATTN_HOME" "$ATTN_BIN" --eval "document.querySelector('[data-slot=share-tier-${tier}] > span:first-child > span:first-child')?.textContent?.trim() || ''" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s))}catch{}})')"
  [ "$actual" = "$expected" ] || { echo "hosted E2E failed: share tier '$tier' label was '$actual'" >&2; exit 1; }
done

ROOM_ID="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.pathname.split("/").filter(Boolean).at(-1) || "")' "$COMMENT_INVITE")"
# `--` before the id: a base64url room id can begin with `-` (about 1 run in
# 64), and clap would otherwise reject it as an unknown flag.
DEFAULT_COMMENT_INVITE="$(ATTN_HOME="$ATTN_HOME" ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" "$ATTN_BIN" review invite --browser -- "$ROOM_ID")"
EXPLICIT_COMMENT_INVITE="$(ATTN_HOME="$ATTN_HOME" ATTN_BROWSER_REVIEW_URL="$WEB_ORIGIN/review" "$ATTN_BIN" review invite --tier comment --browser -- "$ROOM_ID")"
[ "$DEFAULT_COMMENT_INVITE" = "$COMMENT_INVITE" ] && [ "$EXPLICIT_COMMENT_INVITE" = "$COMMENT_INVITE" ] || {
  echo 'hosted E2E failed: human/default browser invite is not comment tier' >&2
  exit 1
}

SECRET="$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(new URLSearchParams(u.hash.slice(1)).get("read") || "")' "$INVITE")"
ATTN_BROWSER_INVITE_URL="$INVITE" \
ATTN_BROWSER_COMMENT_INVITE_URL="$COMMENT_INVITE" \
ATTN_BROWSER_VIEW_INVITE_URL="$VIEW_INVITE" \
ATTN_BROWSER_SUGGEST_INVITE_URL="$INVITE" \
ATTN_ROOM_SECRET_CANARY="$SECRET" \
ATTN_EXPECTED_CANARY="NARWHAL-TEAK-7429" \
ATTN_COMMENT_CANARY="$COMMENT_CANARY" \
ATTN_REPLY_CANARY="$REPLY_CANARY" \
ATTN_SUGGESTION_CANARY="$SUGGESTION_CANARY" \
ATTN_R2_CANARY="$R2_CANARY" \
ATTN_DIRECT_CANARY="$DIRECT_CANARY" \
ATTN_NATIVE_DIRECT_CANARY="$NATIVE_DIRECT_CANARY" \
ATTN_FALLBACK_CANARY="$FALLBACK_CANARY" \
ATTN_OWNER_HOME="$ATTN_HOME" \
ATTN_BIN="$ATTN_BIN" \
  npm --prefix "$PROJECT_DIR/web" run test:e2e:hosted

if [ -z "${E2E_RELAY_URL:-}" ]; then
  for canary in \
    'NARWHAL-TEAK-7429' \
    "$COMMENT_CANARY" \
    "$REPLY_CANARY" \
    "$SUGGESTION_CANARY" \
    "$R2_CANARY" \
    "$DIRECT_CANARY" \
    "$NATIVE_DIRECT_CANARY" \
    "$FALLBACK_CANARY" \
    'encrypted browser suggestion' \
    "$SECRET"
  do
    if grep -aFq -- "$canary" "$RELAY_LOG"; then
      echo 'hosted E2E failed: relay log contained plaintext or secret material' >&2
      exit 1
    fi
    if grep -aRFq -- "$canary" "$RELAY_STATE"; then
      echo 'hosted E2E failed: persisted relay state contained plaintext or secret material' >&2
      exit 1
    fi
  done
  for signaling_plaintext in '"sdp"' 'candidate:' 'a=ice-ufrag:'; do
    if grep -aFq -- "$signaling_plaintext" "$RELAY_LOG" ||
       grep -aRFq -- "$signaling_plaintext" "$RELAY_STATE"; then
      echo 'hosted E2E failed: relay persisted plaintext WebRTC signaling' >&2
      exit 1
    fi
  done
fi

echo 'hosted review E2E passed'
