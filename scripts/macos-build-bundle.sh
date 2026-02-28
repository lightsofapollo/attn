#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE="${1:-prod}"
TARGET="${2:-aarch64-apple-darwin}"

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
    echo "==> Building debug app bundle for $TARGET"
    cargo bundle --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/debug/bundle/osx"
    ;;
  release)
    echo "==> Building release app bundle for $TARGET"
    cargo bundle --release --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/release/bundle/osx"
    ;;
  prod|production)
    echo "==> Building production app bundle for $TARGET"
    cargo bundle --release --features production --target "$TARGET"
    ARTIFACT_DIR="target/$TARGET/release/bundle/osx"
    ;;
  *)
    echo "Usage: $0 [debug|release|prod] [target]" >&2
    exit 1
    ;;
esac

APP_PATH="$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.app' | head -n 1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: no .app found under $ARTIFACT_DIR" >&2
  exit 1
fi

echo "Built app: $APP_PATH"
