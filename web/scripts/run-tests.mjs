#!/usr/bin/env node
// Runs every web unit test (src/**/*.test.ts) in its own tsx child process.
//
// The test files use a custom defineCase/runAllCases harness that prints
// PASS/FAIL and calls process.exit(1) on failure — they are NOT vitest. Each
// must therefore run standalone in its own process; a non-zero child exit is
// treated as a failure. We aggregate results and exit non-zero if any file
// failed, so CI can gate on it.
//
// No files are currently excluded — all 25 test files run green standalone
// under tsx. If a file ever genuinely cannot run standalone (an import/runtime
// error unrelated to a real assertion), add it to EXCLUDED below with a reason
// rather than masking a real failing assertion.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {{ file: string; reason: string }[]} */
const EXCLUDED = [];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(projectRoot, 'src');

/**
 * Recursively collect *.test.ts files under a directory.
 * (We walk by hand instead of fs.globSync so the runner works on Node 20,
 * where globSync is not yet available.)
 * @param {string} dir
 * @returns {string[]}
 */
function collectTestFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Run a single test file under tsx, inheriting stdio so its PASS/FAIL output
 * streams straight through. Resolves with the child's exit code.
 * @param {string} file
 * @returns {Promise<number>}
 */
function runTestFile(file) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', file], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(`failed to spawn tsx for ${file}: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const excludedSet = new Set(EXCLUDED.map((e) => path.join(projectRoot, e.file)));
  const files = collectTestFiles(srcDir)
    .filter((f) => !excludedSet.has(f))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.error('run-tests: no *.test.ts files found under src/');
    process.exit(1);
  }

  /** @type {string[]} */
  const failures = [];
  for (const file of files) {
    const rel = path.relative(projectRoot, file);
    console.log(`\n──── ${rel} ────`);
    const code = await runTestFile(file);
    if (code !== 0) {
      failures.push(rel);
    }
  }

  console.log('\n════════════════════════════════════════');
  console.log(`Ran ${files.length} test file${files.length === 1 ? '' : 's'}, ${failures.length} failure${failures.length === 1 ? '' : 's'}.`);
  if (EXCLUDED.length > 0) {
    console.log(`Excluded ${EXCLUDED.length} file${EXCLUDED.length === 1 ? '' : 's'}:`);
    for (const e of EXCLUDED) {
      console.log(`  - ${e.file} (${e.reason})`);
    }
  }
  if (failures.length > 0) {
    console.log('Failed files:');
    for (const f of failures) {
      console.log(`  ✗ ${f}`);
    }
    process.exit(1);
  }
  console.log('All test files passed.');
}

main();
