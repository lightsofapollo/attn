#!/usr/bin/env bash
set -euo pipefail

# Updates the homebrew-attn tap formula with real SHA256 values from a release.
#
# Usage:
#   ./homebrew/update-tap.sh <version>
#
# Requires: curl, gh (for pushing to the tap repo)
#
# Called by CI after publish-release, or manually after cutting a release.

REPO="lightsofapollo/attn"
TAP_REPO="lightsofapollo/homebrew-attn"

VERSION="${1:?Usage: update-tap.sh <version>}"
TAG="v${VERSION}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORMULA_TEMPLATE="${SCRIPT_DIR}/attn.rb.template"
CASK_TEMPLATE="${SCRIPT_DIR}/attn-cask.rb.template"

if [ ! -f "$FORMULA_TEMPLATE" ]; then
  echo "Formula template not found: ${FORMULA_TEMPLATE}" >&2
  exit 1
fi
if [ ! -f "$CASK_TEMPLATE" ]; then
  echo "Cask template not found: ${CASK_TEMPLATE}" >&2
  exit 1
fi

echo "Fetching SHA256 checksums for ${TAG}..."

SHA_DARWIN_ARM64="$(curl -sfL "https://github.com/${REPO}/releases/download/${TAG}/attn-${TAG}-darwin-arm64.sha256" | awk '{print $1}')"
SHA_LINUX_X64="$(curl -sfL "https://github.com/${REPO}/releases/download/${TAG}/attn-${TAG}-linux-x64.sha256" | awk '{print $1}')"
SHA_DARWIN_ARM64_APP="$(curl -sfL "https://github.com/${REPO}/releases/download/${TAG}/attn-${TAG}-darwin-arm64.app.zip.sha256" | awk '{print $1}')"

if [ -z "$SHA_DARWIN_ARM64" ]; then
  echo "Failed to fetch darwin-arm64 SHA256" >&2
  exit 1
fi
if [ -z "$SHA_LINUX_X64" ]; then
  echo "Failed to fetch linux-x64 SHA256" >&2
  exit 1
fi
if [ -z "$SHA_DARWIN_ARM64_APP" ]; then
  echo "Failed to fetch darwin-arm64 .app.zip SHA256" >&2
  exit 1
fi

echo "  darwin-arm64:     ${SHA_DARWIN_ARM64}"
echo "  linux-x64:        ${SHA_LINUX_X64}"
echo "  darwin-arm64 app: ${SHA_DARWIN_ARM64_APP}"

# --- Update Formula ---

FORMULA="$(sed \
  -e "s/%%VERSION%%/${VERSION}/g" \
  -e "s/%%SHA256_DARWIN_ARM64%%/${SHA_DARWIN_ARM64}/g" \
  -e "s/%%SHA256_LINUX_X64%%/${SHA_LINUX_X64}/g" \
  "$FORMULA_TEMPLATE")"

CURRENT_SHA="$(gh api "repos/${TAP_REPO}/contents/Formula/attn.rb" --jq '.sha' 2>/dev/null || true)"

ARGS=(
  --method PUT
  --field "message=Update attn formula to ${VERSION}"
  --field "content=$(echo "$FORMULA" | base64)"
  --field "branch=main"
)

if [ -n "$CURRENT_SHA" ]; then
  ARGS+=(--field "sha=${CURRENT_SHA}")
fi

gh api "repos/${TAP_REPO}/contents/Formula/attn.rb" "${ARGS[@]}"

echo "Formula updated in ${TAP_REPO}"

# --- Update Cask ---

CASK="$(sed \
  -e "s/%%VERSION%%/${VERSION}/g" \
  -e "s/%%SHA256_DARWIN_ARM64_APP%%/${SHA_DARWIN_ARM64_APP}/g" \
  "$CASK_TEMPLATE")"

CASK_CURRENT_SHA="$(gh api "repos/${TAP_REPO}/contents/Casks/attn.rb" --jq '.sha' 2>/dev/null || true)"

CASK_ARGS=(
  --method PUT
  --field "message=Update attn cask to ${VERSION}"
  --field "content=$(echo "$CASK" | base64)"
  --field "branch=main"
)

if [ -n "$CASK_CURRENT_SHA" ]; then
  CASK_ARGS+=(--field "sha=${CASK_CURRENT_SHA}")
fi

gh api "repos/${TAP_REPO}/contents/Casks/attn.rb" "${CASK_ARGS[@]}"

echo "Cask updated in ${TAP_REPO}"
