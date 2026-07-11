#!/usr/bin/env node

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.resolve(webRoot, '../crates/attn-anchor-wasm');
const output = path.resolve(webRoot, 'src/lib/review/anchor-wasm-pkg');
const check = process.argv.includes('--check');
const expectedWasmPack = 'wasm-pack 0.14.0';
const version = spawnSync('wasm-pack', ['--version'], { encoding: 'utf8' });
if (version.error) throw version.error;
if (version.status !== 0 || version.stdout.trim() !== expectedWasmPack) {
  throw new Error(
    `anchor WASM requires ${expectedWasmPack}; got ${version.stdout.trim() || 'an unavailable tool'}`,
  );
}
const temporary = check ? mkdtempSync(path.join(os.tmpdir(), 'attn-anchor-wasm-')) : null;
const destination = temporary ?? output;
if (!check) rmSync(destination, { recursive: true, force: true });
const result = spawnSync(
  'wasm-pack',
  [
    'build',
    crate,
    '--target',
    'web',
    '--release',
    '--out-dir',
    destination,
    '--out-name',
    'attn_anchor_wasm',
  ],
  { stdio: 'inherit' },
);

try {
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  // wasm-pack assumes packages are registry-published and ignores every
  // output by default. This package is a checked-in application artifact.
  rmSync(path.join(destination, '.gitignore'), { force: true });
  if (check) assertDirectoriesEqual(output, destination);
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}

function assertDirectoriesEqual(expected, actual) {
  const expectedFiles = listFiles(expected);
  const actualFiles = listFiles(actual);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `checked-in anchor WASM file list differs: expected ${expectedFiles.join(', ')}, rebuilt ${actualFiles.join(', ')}`,
    );
  }
  for (const relative of expectedFiles) {
    const left = readFileSync(path.join(expected, relative));
    const right = readFileSync(path.join(actual, relative));
    if (!left.equals(right)) {
      throw new Error(`checked-in anchor WASM is stale or non-reproducible: ${relative}`);
    }
  }
  console.log(`anchor WASM reproducibly matches ${expectedFiles.length} checked-in files`);
}

function listFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else out.push(relative);
  }
  return out.sort();
}
