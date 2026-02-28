#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

DMG_PATH="${1:-}"
PROFILE_NAME="${2:-attn-notary-profile}"
APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macos-notarize-dmg.sh must run on macOS" >&2
  exit 1
fi

if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
  echo "ERROR: pass a valid DMG path as arg 1" >&2
  exit 1
fi

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "ERROR: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are required" >&2
  exit 1
fi

EXTRA_ARGS=()
if [ -n "$KEYCHAIN_PATH" ]; then
  EXTRA_ARGS+=(--keychain "$KEYCHAIN_PATH")
fi

xcrun notarytool store-credentials "$PROFILE_NAME" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  "${EXTRA_ARGS[@]}"

xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$PROFILE_NAME" \
  "${EXTRA_ARGS[@]}" \
  --wait

xcrun stapler staple "$DMG_PATH"
spctl --assess --type open --context context:primary-signature -v "$DMG_PATH" || true

echo "Notarized and stapled: $DMG_PATH"
