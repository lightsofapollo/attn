#!/usr/bin/env node
// Route-level bundle boundary gate (attn-7xl.1.1).
//
// The landing and app entries must never statically pull the editor/crypto
// graph: ProseMirror, Mermaid, KaTeX, room crypto (@noble/*, src/lib/review),
// or WebRTC code. This walks the Vite build manifest from each gated entry,
// collects every chunk reachable through *static* imports (what the browser
// preloads on navigation), and checks each chunk's constituent module IDs
// (emitted by the chunkModulesManifest plugin in vite.browser.config.ts) —
// page copy is allowed to mention "ProseMirror" without tripping the gate.
//
// Usage: node scripts/check-route-bundles.mjs   (after `npm run build:browser`)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(webRoot, 'dist-browser');

// Module-id patterns whose presence in a gated entry's static graph fails the
// build, with human explanations.
const FORBIDDEN_MODULES = [
  [/node_modules\/(?:prosemirror-|@handlewithcare\/prosemirror)/u, 'ProseMirror editor graph'],
  [/node_modules\/mermaid/u, 'Mermaid diagram renderer'],
  [/node_modules\/katex/u, 'KaTeX math renderer'],
  [/node_modules\/@noble\//u, 'room crypto (@noble primitives)'],
  [/node_modules\/shiki/u, 'Shiki syntax highlighter'],
  [/src\/lib\/review\//u, 'review room protocol code'],
];

// The WebRTC transport is app code (no package marker), so match the API
// identifier itself — case-sensitive, which page copy never contains.
const FORBIDDEN_SOURCE = [['RTCPeerConnection', 'WebRTC transport']];

// Entries whose static graph must stay clean. The review entry legitimately
// owns crypto and (dynamically) the editor graph; the app entry gains editor
// code in later phases only through dynamic imports, so it is gated too.
const GATED_ENTRIES = ['landing', 'app'];

const manifest = JSON.parse(await readFile(path.join(distDir, '.vite', 'manifest.json'), 'utf8'));
const chunkModules = JSON.parse(
  await readFile(path.join(distDir, '.vite', 'chunk-modules.json'), 'utf8'),
);

const entryKeys = new Map();
for (const [key, chunk] of Object.entries(manifest)) {
  if (chunk.isEntry && chunk.name) entryKeys.set(chunk.name, key);
}

for (const expected of [...GATED_ENTRIES, 'review']) {
  if (!entryKeys.has(expected)) {
    throw new Error(`build manifest is missing the "${expected}" entry`);
  }
}

let failures = 0;
for (const entryName of GATED_ENTRIES) {
  const files = collectStaticFiles(entryKeys.get(entryName));
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const modules = chunkModules[file];
    if (!modules) throw new Error(`no module map recorded for chunk ${file}`);
    for (const moduleId of modules) {
      for (const [pattern, explanation] of FORBIDDEN_MODULES) {
        if (pattern.test(moduleId)) {
          console.error(`FAIL ${entryName}: ${file} bundles ${explanation} (${moduleId})`);
          failures += 1;
        }
      }
    }
    const source = await readFile(path.join(distDir, file), 'utf8');
    for (const [marker, explanation] of FORBIDDEN_SOURCE) {
      if (source.includes(marker)) {
        console.error(`FAIL ${entryName}: ${file} contains ${explanation} ("${marker}")`);
        failures += 1;
      }
    }
  }
  console.log(`checked ${entryName}: ${files.size} statically reachable files`);
}

if (failures > 0) {
  console.error(`route bundle boundaries violated (${failures} finding${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('route bundle boundaries hold: landing/app never preload editor or crypto chunks');

/**
 * Collect files reachable from a manifest key through static imports only.
 * @param {string} rootKey
 * @returns {Set<string>}
 */
function collectStaticFiles(rootKey) {
  const files = new Set();
  const visited = new Set();
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest key not found: ${key}`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) queue.push(imported);
  }
  return files;
}
