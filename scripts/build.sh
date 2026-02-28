#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

MODE="${1:-debug}"

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
        cargo build --release
        echo "==> Built: target/release/attn"
        ;;
    prod|production)
        echo "==> Building Rust (production, devtools+screenshots stripped)..."
        cargo build --release --features production
        echo "==> Built: target/release/attn"
        ;;
    *)
        echo "Usage: $0 [debug|release|prod]"
        exit 1
        ;;
esac
