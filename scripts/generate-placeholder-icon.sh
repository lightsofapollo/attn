#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ICON_DIR="$PROJECT_DIR/icons"
RAW_SOURCE="${1:-$ICON_DIR/attn-source-original.png}"
BASE_PNG="$ICON_DIR/attn-placeholder-source.png"
LINUX_PNG="$ICON_DIR/attn.png"
ICONSET_DIR="$ICON_DIR/attn.iconset"
ICNS_PATH="$ICON_DIR/attn.icns"

mkdir -p "$ICON_DIR"

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick ('magick') is required to build icons." >&2
  exit 1
fi

if [ ! -f "$RAW_SOURCE" ]; then
  echo "error: icon source not found: $RAW_SOURCE" >&2
  echo "usage: $0 [path-to-source-png]" >&2
  exit 1
fi

echo "==> Preparing base PNG from source: $RAW_SOURCE"
# Keep original colors and glyph; only remove outer flat canvas/background.
# This preserves the brand look while avoiding the extra light frame in Dock.
magick "$RAW_SOURCE" \
  -alpha on \
  -fuzz 3% -trim +repage \
  -fuzz 5% -transparent "srgb(251,245,238)" \
  -resize 1860x1860 \
  -gravity center -background none -extent 2048x2048 \
  -colorspace sRGB \
  -unsharp 0x0.5+0.5+0.01 \
  "$BASE_PNG"

echo "==> Creating Linux/portable PNG icon..."
magick "$BASE_PNG" -resize 1024x1024 "$LINUX_PNG"

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

echo "==> Building macOS iconset sizes..."
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$BASE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  size2x=$((size * 2))
  sips -z "$size2x" "$size2x" "$BASE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

echo "==> Creating ICNS bundle..."
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

rm -rf "$ICONSET_DIR"

echo "Generated: $ICNS_PATH"
echo "Generated: $LINUX_PNG"
