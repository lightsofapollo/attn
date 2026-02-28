#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

APP_PATH="${1:-}"
SIGNING_IDENTITY="${2:-${APPLE_SIGNING_IDENTITY:-}}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macos-sign-app.sh must run on macOS" >&2
  exit 1
fi

if [ -z "$APP_PATH" ]; then
  APP_PATH="$(find target -path '*/bundle/osx/*.app' -maxdepth 6 | sort | tail -n1)"
fi

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "ERROR: app bundle not found. Pass path as first arg." >&2
  exit 1
fi

if [ -z "$SIGNING_IDENTITY" ]; then
  echo "ERROR: signing identity missing. Set APPLE_SIGNING_IDENTITY or pass arg 2." >&2
  exit 1
fi

SIGN_CMD=(codesign --force --deep --sign "$SIGNING_IDENTITY" --options runtime --timestamp)
if [ -n "$KEYCHAIN_PATH" ]; then
  SIGN_CMD+=(--keychain "$KEYCHAIN_PATH")
fi
SIGN_CMD+=("$APP_PATH")

"${SIGN_CMD[@]}"

codesign --verify --verbose=4 "$APP_PATH"
codesign -dv --verbose=4 "$APP_PATH" 2>&1 | sed -n '1,30p'

echo "Signed app: $APP_PATH"
