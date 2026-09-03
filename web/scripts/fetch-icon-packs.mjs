#!/usr/bin/env node
// Fetch the unpublished icon packs as pinned source tarballs (attn-6q7b).
//
// Codeload serves a tarball per commit over plain https, so this needs no git,
// no ssh key, and — crucially — no npm resolution of the upstream project's own
// dependencies. That resolution is what made `npm ci` non-hermetic.
//
// The download lands in `web/.icon-packs/` (gitignored). It is an input to
// `npm run refresh:icons` only; the committed output under
// `src/lib/icons/vscode-generated/` is what the build actually reads.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ICON_PACK_PINS } from './icon-pack-pins.mjs';

const execFileAsync = promisify(execFile);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(webRoot, '.icon-packs');

function packDir(pack) {
  return path.join(cacheDir, pack.name);
}

/** A pack is current when its stamp records the commit we want. */
function stampedCommit(pack) {
  try {
    return fs.readFileSync(path.join(packDir(pack), '.commit'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function fetchPack(pack) {
  const target = packDir(pack);
  if (stampedCommit(pack) === pack.commit) {
    process.stdout.write(`${pack.name}: already at ${pack.commit.slice(0, 12)}\n`);
    return;
  }

  const url = `https://codeload.github.com/${pack.repo}/tar.gz/${pack.commit}`;
  process.stdout.write(`${pack.name}: fetching ${pack.repo}@${pack.commit.slice(0, 12)}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${pack.name}: ${url} returned ${response.status}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const tarball = path.join(cacheDir, `${pack.name}.tar.gz`);
  fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  try {
    // --strip-components=1 drops the `<repo>-<sha>/` wrapper directory.
    await execFileAsync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
  } finally {
    fs.rmSync(tarball, { force: true });
  }

  // Fail loudly here rather than deep inside the generator with a confusing
  // "Missing icon asset" — a pack that moved its layout is the likely cause.
  for (const relative of pack.paths) {
    if (!fs.existsSync(path.join(target, relative))) {
      throw new Error(
        `${pack.name}: expected ${relative} at ${pack.commit.slice(0, 12)}; upstream layout changed`,
      );
    }
  }
  fs.writeFileSync(path.join(target, '.commit'), `${pack.commit}\n`);
}

async function main() {
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const pack of ICON_PACK_PINS) {
    await fetchPack(pack);
  }
  process.stdout.write(`icon packs ready in ${path.relative(webRoot, cacheDir)}/\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
