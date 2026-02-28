#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

APP_PATH="${1:-}"
DMG_PATH="${2:-}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macos-create-dmg.sh must run on macOS" >&2
  exit 1
fi

if [ -z "$APP_PATH" ]; then
  APP_PATH="$(find target -path '*/bundle/osx/*.app' -maxdepth 6 | sort | tail -n1)"
fi

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "ERROR: app bundle not found. Pass path as first arg." >&2
  exit 1
fi

if [ -z "$DMG_PATH" ]; then
  APP_DIR="$(dirname "$APP_PATH")"
  DMG_PATH="$APP_DIR/attn.dmg"
fi

rm -f "$DMG_PATH"

hdiutil create -volname "attn" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH"

if [ -n "$SIGNING_IDENTITY" ]; then
  SIGN_CMD=(codesign --force --sign "$SIGNING_IDENTITY" --timestamp)
  if [ -n "$KEYCHAIN_PATH" ]; then
    SIGN_CMD+=(--keychain "$KEYCHAIN_PATH")
  fi
  SIGN_CMD+=("$DMG_PATH")
  "${SIGN_CMD[@]}"
  codesign --verify --verbose=4 "$DMG_PATH"
fi

echo "DMG: $DMG_PATH"
