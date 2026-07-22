#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE="${1:-prod}"
TARGET="${2:-aarch64-apple-darwin}"

# Keep the relay and hosted review entry on the same environment. Runtime URL
# overrides remain available for local/self-hosted deployments.
case "$MODE" in
  debug|staging)
    : "${ATTN_DEFAULT_RELAY_URL:=https://relay-staging.attn.sh}"
    : "${ATTN_DEFAULT_BROWSER_REVIEW_URL:=https://staging.attn.sh/review}"
    ;;
  release|prod|production)
    : "${ATTN_DEFAULT_RELAY_URL:=https://relay.attn.sh}"
    : "${ATTN_DEFAULT_BROWSER_REVIEW_URL:=https://attn.sh/review}"
    ;;
  *)
    echo "Usage: $0 [debug|staging|release|prod] [target]" >&2
    exit 1
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macos-build-bundle.sh must run on macOS" >&2
  exit 1
fi

if ! cargo bundle --version >/dev/null 2>&1; then
  echo "ERROR: cargo-bundle is not installed." >&2
  echo "Install it with: cargo install cargo-bundle" >&2
  exit 1
fi

if [ ! -f "icons/attn.icns" ]; then
  echo "==> icons/attn.icns missing, generating placeholder icon..."
  "$SCRIPT_DIR/generate-placeholder-icon.sh"
fi

case "$MODE" in
  debug)
    echo "==> Building debug app bundle for $TARGET (staging services)"
    echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
    echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
    ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
      ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
      cargo bundle --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/debug/bundle/osx"
    ;;
  staging|release)
    echo "==> Building $MODE app bundle for $TARGET"
    echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
    echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
    ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
      ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
      cargo bundle --release --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/release/bundle/osx"
    ;;
  prod|production)
    echo "==> Building production app bundle for $TARGET"
    echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
    echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
    ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
      ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
      cargo bundle --release --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/release/bundle/osx"
    ;;
esac

APP_PATH="$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.app' | head -n 1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: no .app found under $ARTIFACT_DIR" >&2
  exit 1
fi

echo "Built app: $APP_PATH"
