#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE="${1:-debug}"

# Production relay baked into release/prod builds via the client's
# option_env!("ATTN_DEFAULT_RELAY_URL") fallback — so a shipped app talks to
# relay.attn.sh out of the box (a runtime ATTN_RELAY_URL still overrides).
# Override for a different target: ATTN_DEFAULT_RELAY_URL=... scripts/build.sh prod
: "${ATTN_DEFAULT_RELAY_URL:=https://relay.attn.sh}"

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
        echo "==> Building Rust (debug)..."
        cargo build
        echo "==> Built: target/debug/attn"
        ;;
    release)
        echo "==> Building Rust (release, devtools+screenshots enabled)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" cargo build --release
        echo "==> Built: target/release/attn"
        ;;
    prod|production)
        echo "==> Building Rust (production release)..."
        echo "    ATTN_DEFAULT_RELAY_URL=$ATTN_DEFAULT_RELAY_URL"
        ATTN_DEFAULT_RELAY_URL="$ATTN_DEFAULT_RELAY_URL" cargo build --release
        echo "==> Built: target/release/attn"
        ;;
    *)
        echo "Usage: $0 [debug|release|prod]"
        exit 1
        ;;
esac
