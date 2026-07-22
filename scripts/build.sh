#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE="${1:-debug}"

# Relay and hosted-review origins are one environment pair. Debug/staging
# builds use staging end to end; release/prod builds use production. Runtime
# ATTN_RELAY_URL / ATTN_BROWSER_REVIEW_URL still win for local/self-hosted use.
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
        echo "Usage: $0 [debug|staging|release|prod]"
        exit 1
        ;;
esac

# Install npm deps if missing
if [ ! -d "web/node_modules" ]; then
    echo "==> Installing npm dependencies..."
    (cd web && npm ci)
fi

# Build Svelte frontend
echo "==> Building Svelte frontend..."
(cd web && npm run build)

# Build Rust binary
case "$MODE" in
    debug)
        echo "==> Building Rust (debug, staging services)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
            ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
            cargo build
        echo "==> Built: target/debug/attn"
        ;;
    staging)
        echo "==> Building Rust (release profile, staging services)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
            ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
            cargo build --release
        echo "==> Built: target/release/attn"
        ;;
    release)
        echo "==> Building Rust (release, devtools+screenshots enabled)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
            ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
            cargo build --release
        echo "==> Built: target/release/attn"
        ;;
    prod|production)
        echo "==> Building Rust (production release)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        echo "    ATTN_DEFAULT_BROWSER_REVIEW_URL=$ATTN_DEFAULT_BROWSER_REVIEW_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" \
            ATTN_DEFAULT_BROWSER_REVIEW_URL="$ATTN_DEFAULT_BROWSER_REVIEW_URL" \
            cargo build --release
        echo "==> Built: target/release/attn"
        ;;
esac
