#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ICON_DIR="$PROJECT_DIR/icons"
BASE_PNG="$ICON_DIR/attn-placeholder-source.png"
ICONSET_DIR="$ICON_DIR/attn.iconset"
ICNS_PATH="$ICON_DIR/attn.icns"

mkdir -p "$ICON_DIR"

echo "==> Generating placeholder base PNG with Swift/AppKit..."
cat > /tmp/attn-generate-icon.swift <<'SWIFT'
import AppKit
import Foundation

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "attn-placeholder-1024.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

image.lockFocus()

let canvas = NSRect(origin: .zero, size: size)
NSColor(calibratedRed: 0.98, green: 0.35, blue: 0.10, alpha: 1.0).setFill()
canvas.fill()

let cardRect = canvas.insetBy(dx: 96, dy: 96)
let cardPath = NSBezierPath(roundedRect: cardRect, xRadius: 180, yRadius: 180)
let gradient = NSGradient(colors: [
  NSColor(calibratedRed: 0.99, green: 0.70, blue: 0.08, alpha: 1.0),
  NSColor(calibratedRed: 0.98, green: 0.35, blue: 0.10, alpha: 1.0)
])!
gradient.draw(in: cardPath, angle: -35)

let letter = "A" as NSString
let letterAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 520, weight: .bold),
  .foregroundColor: NSColor(calibratedRed: 0.10, green: 0.10, blue: 0.10, alpha: 1.0)
]
let letterSize = letter.size(withAttributes: letterAttrs)
let letterRect = NSRect(
  x: (size.width - letterSize.width) / 2,
  y: (size.height - letterSize.height) / 2 + 40,
  width: letterSize.width,
  height: letterSize.height
)
letter.draw(in: letterRect, withAttributes: letterAttrs)

let tag = "attn" as NSString
let tagAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 110, weight: .semibold),
  .foregroundColor: NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.12, alpha: 1.0)
]
let tagSize = tag.size(withAttributes: tagAttrs)
let tagRect = NSRect(
  x: (size.width - tagSize.width) / 2,
  y: 190,
  width: tagSize.width,
  height: tagSize.height
)
tag.draw(in: tagRect, withAttributes: tagAttrs)

image.unlockFocus()

guard
  let tiffData = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiffData),
  let pngData = bitmap.representation(using: .png, properties: [:])
else {
  fputs("failed to generate PNG data\n", stderr)
  exit(1)
}

do {
  try pngData.write(to: URL(fileURLWithPath: outputPath))
} catch {
  fputs("failed to write PNG: \(error)\n", stderr)
  exit(1)
}
SWIFT

swift /tmp/attn-generate-icon.swift "$BASE_PNG"
rm -f /tmp/attn-generate-icon.swift

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
