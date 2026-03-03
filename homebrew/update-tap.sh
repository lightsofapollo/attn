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
TEMPLATE="${SCRIPT_DIR}/attn.rb.template"

if [ ! -f "$TEMPLATE" ]; then
  echo "Template not found: ${TEMPLATE}" >&2
  exit 1
fi

echo "Fetching SHA256 checksums for ${TAG}..."

SHA_DARWIN_ARM64="$(curl -sfL "https://github.com/${REPO}/releases/download/${TAG}/attn-${TAG}-darwin-arm64.sha256" | awk '{print $1}')"
SHA_LINUX_X64="$(curl -sfL "https://github.com/${REPO}/releases/download/${TAG}/attn-${TAG}-linux-x64.sha256" | awk '{print $1}')"

if [ -z "$SHA_DARWIN_ARM64" ]; then
  echo "Failed to fetch darwin-arm64 SHA256" >&2
  exit 1
fi
if [ -z "$SHA_LINUX_X64" ]; then
  echo "Failed to fetch linux-x64 SHA256" >&2
  exit 1
fi

echo "  darwin-arm64: ${SHA_DARWIN_ARM64}"
echo "  linux-x64:    ${SHA_LINUX_X64}"

# Generate formula from template
FORMULA="$(sed \
  -e "s/%%VERSION%%/${VERSION}/g" \
  -e "s/%%SHA256_DARWIN_ARM64%%/${SHA_DARWIN_ARM64}/g" \
  -e "s/%%SHA256_LINUX_X64%%/${SHA_LINUX_X64}/g" \
  "$TEMPLATE")"

# Get the current file SHA from the tap repo (needed for the GitHub API update)
CURRENT_SHA="$(gh api "repos/${TAP_REPO}/contents/Formula/attn.rb" --jq '.sha' 2>/dev/null || true)"

ARGS=(
  --method PUT
  --field "message=Update attn to ${VERSION}"
  --field "content=$(echo "$FORMULA" | base64)"
  --field "branch=main"
)

if [ -n "$CURRENT_SHA" ]; then
  ARGS+=(--field "sha=${CURRENT_SHA}")
fi

gh api "repos/${TAP_REPO}/contents/Formula/attn.rb" "${ARGS[@]}"

echo "Formula updated in ${TAP_REPO}"
