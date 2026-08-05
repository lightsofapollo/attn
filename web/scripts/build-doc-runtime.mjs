#!/usr/bin/env node
/**
 * Bundle the HTML annotation runtime into a single self-contained IIFE and emit
 * it as a TypeScript string constant.
 *
 * The runtime does not run in the app — it is *injected into an arbitrary HTML
 * document* that the shell renders in a sandboxed iframe. There is no module
 * loader, no build step, and no second file to fetch on the far side, so the
 * runtime has to arrive as one inert string the shell can splice into the
 * document source. That works identically for a local file and for bytes
 * received over the encrypted channel, which is the point (html-annotation.md §1).
 *
 * Regenerate with `npm run build:doc-runtime`; `--check` verifies the committed
 * artifact is current without writing (used by CI).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const entry = resolve(webRoot, 'src/doc-runtime/index.ts');
const outFile = resolve(webRoot, 'src/lib/review/doc-runtime.generated.ts');

const checkOnly = process.argv.includes('--check');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  write: false,
  legalComments: 'none',
  // The document frame has no bundler and no import map; everything the
  // runtime needs must be inlined.
  external: [],
});

const [output] = result.outputFiles;
if (!output) {
  console.error('build-doc-runtime: esbuild produced no output');
  process.exit(1);
}

const banner = `/**
 * GENERATED — do not edit. Run \`npm run build:doc-runtime\`.
 *
 * Bundled source of the HTML annotation runtime (web/src/doc-runtime/), which
 * is injected into the document frame rather than loaded as a module.
 * @see planning/collab/html-annotation.md §1
 */`;

const contents = `${banner}\nexport const DOC_RUNTIME_SOURCE = ${JSON.stringify(output.text)};\n`;

if (checkOnly) {
  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {
    console.error('build-doc-runtime: artifact missing; run `npm run build:doc-runtime`');
    process.exit(1);
  }
  if (current !== contents) {
    console.error(
      'build-doc-runtime: artifact is stale; run `npm run build:doc-runtime` and commit the result',
    );
    process.exit(1);
  }
  console.log(`doc-runtime artifact is current (${output.text.length} bytes)`);
} else {
  writeFileSync(outFile, contents);
  console.log(`doc-runtime bundled: ${output.text.length} bytes → ${outFile}`);
}
