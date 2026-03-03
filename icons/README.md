# Icons

This directory contains app icons used for macOS bundling.

* `attn-source-original.png` is the raw design export.
* `attn-placeholder-source.png` is the normalized square PNG used for iconset generation.
* `attn.icns` is the bundled macOS app icon.
* `attn.png` is a Linux/portable PNG app icon.
* Regenerate from source using:

```bash
scripts/generate-placeholder-icon.sh
# or with an explicit source file:
scripts/generate-placeholder-icon.sh ~/Downloads/your-icon.png
```

When swapping branding, replace `attn-source-original.png` (or pass a source path) and rerun the script.