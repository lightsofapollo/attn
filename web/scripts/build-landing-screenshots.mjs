// Convert the raw marketing captures (scripts/capture-collab-screenshots.sh →
// site/static/screenshots/<name>-{light,dark}.png, 1920×1440) into the landing
// page's responsive asset set:
//
//   web/src/hosted/landing/assets/<name>-<theme>-{768,1280,1920}.avif
//   web/src/hosted/landing/assets/<name>-<theme>-fallback.webp   (1280w)
//
// Every output stays 4:3 — ResponsiveScreenshot hard-codes width=1920
// height=1440 as the CLS box and hosted-routes.spec.ts asserts it.
//
// Usage: node web/scripts/build-landing-screenshots.mjs [name ...]
//        (default: collab share)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.join(webRoot, '..');
const SRC = path.join(repoRoot, 'site', 'static', 'screenshots');
const OUT = path.join(webRoot, 'src', 'hosted', 'landing', 'assets');

/**
 * Per-name 4:3 crops, as fractions of the source width/height.
 * share: tight to the Share dialog — the raw capture is the whole app window,
 * and its dimmed backdrop read as a dead gray slab at exactly the
 * trust-transfer moment (critique 2026-08-18). Height follows from width to
 * hold 4:3.
 */
const CROPS = {
  // Calibrated against the 2026-08-18 capture: dialog spans x 0.242–0.758,
  // its "Send this command" block + E2EE blurb end at y≈0.52, and the next
  // section heading starts at y≈0.60 — so the crop bottom lands in clean
  // dialog whitespace and the left/right edges sit on the dialog's own
  // borders (no backdrop slab). The thin top strip keeps the overlay depth
  // cue.
  share: { left: 0.24, top: 0.05, width: 0.52 },
};

const WIDTHS = [768, 1280, 1920];
const names = process.argv.length > 2 ? process.argv.slice(2) : ['collab', 'share'];

for (const name of names) {
  for (const theme of ['light', 'dark']) {
    const src = path.join(SRC, `${name}-${theme}.png`);
    const meta = await sharp(src).metadata();
    if (Math.abs(meta.width / meta.height - 4 / 3) > 0.01) {
      throw new Error(`${src}: expected a 4:3 source, got ${meta.width}x${meta.height}`);
    }
    let base = sharp(src);
    const crop = CROPS[name];
    if (crop) {
      const width = Math.round(meta.width * crop.width);
      const height = Math.round((width * 3) / 4);
      base = base.extract({
        left: Math.round(meta.width * crop.left),
        top: Math.round(meta.height * crop.top),
        width,
        height,
      });
    }
    const upscale = crop ? true : false;
    for (const width of WIDTHS) {
      const dest = path.join(OUT, `${name}-${theme}-${width}.avif`);
      await base
        .clone()
        .resize({ width, withoutEnlargement: !upscale })
        .avif({ quality: 45, effort: 6 })
        .toFile(dest);
      console.log('wrote', path.relative(repoRoot, dest));
    }
    const fallback = path.join(OUT, `${name}-${theme}-fallback.webp`);
    await base.clone().resize({ width: 1280 }).webp({ quality: 82 }).toFile(fallback);
    console.log('wrote', path.relative(repoRoot, fallback));
  }
}
