#!/usr/bin/env node
// Keeps the browser desk's icon boundary honest (attn-7xl.7.8).
//
// The native app may switch among all five icon packs. The hosted desktop must
// not therefore inherit that aggregate registry: its shared Sidebar/FileTree
// asks the desktop-owned registry for the selected pack. Material is the
// largest pack, so pinning its own lazy chunk catches a regression both in the
// split and in the generated asset map.

import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(webRoot, 'dist-browser');
const MATERIAL_MODULE = 'src/lib/vscode-icon-packs/material.generated.ts';
const FRAME_MODULE = 'src/hosted/app/HostedDesktopWorkspaceFrame.svelte';
const ICON_PACK_MODULE = 'src/lib/vscode-icon-packs/';
// Measured on the generated material map. Leave enough room for harmless
// source-map-free minifier variation, but not for a second pack to slip in.
const MATERIAL_MAX_GZIP_BYTES = 240 * 1024;

const chunkModules = JSON.parse(
  await readFile(path.join(distDir, '.vite', 'chunk-modules.json'), 'utf8'),
);

const chunksFor = (moduleId) => Object.entries(chunkModules)
  .filter(([, modules]) => modules.includes(moduleId))
  .map(([file]) => file);

const materialChunks = chunksFor(MATERIAL_MODULE);
if (materialChunks.length !== 1) {
  throw new Error(
    `expected exactly one material icon-pack chunk, found ${materialChunks.length}: ${materialChunks.join(', ')}`,
  );
}

const frameChunks = chunksFor(FRAME_MODULE);
if (frameChunks.length !== 1) {
  throw new Error(
    `expected exactly one HostedDesktopWorkspaceFrame chunk, found ${frameChunks.length}: ${frameChunks.join(', ')}`,
  );
}

const frameModules = chunkModules[frameChunks[0]];
const leakedPackModules = frameModules.filter((moduleId) => moduleId.includes(ICON_PACK_MODULE));
if (leakedPackModules.length > 0) {
  throw new Error(
    `HostedDesktopWorkspaceFrame statically includes icon-pack modules: ${leakedPackModules.join(', ')}`,
  );
}

const materialFile = materialChunks[0];
const materialBytes = await readFile(path.join(distDir, materialFile));
const materialGzipBytes = gzipSync(materialBytes).byteLength;
if (materialGzipBytes > MATERIAL_MAX_GZIP_BYTES) {
  throw new Error(
    `material icon pack is ${materialGzipBytes} gzip bytes; pinned limit is ${MATERIAL_MAX_GZIP_BYTES}`,
  );
}

console.log(
  `checked icon bundles: hosted frame excludes pack registry; material pack ${materialBytes.byteLength} raw / ${materialGzipBytes} gzip bytes (limit ${MATERIAL_MAX_GZIP_BYTES})`,
);
