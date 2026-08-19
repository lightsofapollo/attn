#!/usr/bin/env node
// Checks that a cleanup changed comment text and nothing else.
//
// Usage: verify.mjs [--base <ref>] [--json] [<file>...]
//
// Strips every comment from both versions of each changed file and compares
// what is left. Equal means only comment text moved. Exit 1 on any difference,
// and on any file whose base version could not be read.
//
// The stripper is quote-aware but still a heuristic, so this is a backstop
// against a slipped edit rather than a proof. A failure is authoritative;
// treat a pass as strong evidence. Changed files with no known comment syntax
// are listed as unchecked — the pass does not speak for them.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syntaxFor, codeSkeleton } from './lib.mjs';

function parseArgs(argv) {
  const opts = { base: 'HEAD', json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`clean-comments: unknown option: ${a}`); process.exit(2); }
    else opts.files.push(a);
  }
  return opts;
}

function usage() {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(2, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// Never let git write to our stderr directly; a leaked "fatal:" line reads as
// our own failure.
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function inBase(base, file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${file}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function changedFiles(base) {
  return git(['-c', 'core.quotepath=off', 'diff', '--name-only', base]).split('\n').filter(Boolean);
}

function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return { index: i + 1, before: x[i] ?? '(end of file)', after: y[i] ?? '(end of file)' };
    }
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Work from the repository root: git paths are root-relative, and running
  // from a subdirectory must not turn "path exists in base" into "new file".
  const cwd = process.cwd();
  const root = git(['rev-parse', '--show-toplevel']).trim();
  opts.files = opts.files.map((f) => path.relative(root, path.resolve(cwd, f)));
  process.chdir(root);

  const files = opts.files.length ? opts.files : changedFiles(opts.base);
  const results = [];

  for (const file of files) {
    const syn = syntaxFor(file);
    if (!syn) {
      results.push({ file, status: 'unchecked', detail: 'no known comment syntax' });
      continue;
    }

    if (!inBase(opts.base, file)) {
      results.push({ file, status: 'added', detail: 'not in base; nothing to compare' });
      continue;
    }
    let before;
    try {
      before = git(['show', `${opts.base}:${file}`]);
    } catch (e) {
      // The file exists in base but could not be read: fail closed, never
      // report a comparison that did not happen as a pass.
      const msg = (e.stderr || String(e)).toString().trim().split('\n')[0];
      results.push({ file, status: 'fail', detail: `could not read base version (${msg})` });
      continue;
    }
    if (!fs.existsSync(file)) {
      results.push({ file, status: 'fail', detail: 'file was deleted; that is a code change' });
      continue;
    }

    const diff = firstDifference(codeSkeleton(before, syn), codeSkeleton(fs.readFileSync(file, 'utf8'), syn));
    results.push(diff
      ? { file, status: 'fail', detail: `code line ${diff.index} changed`, before: diff.before, after: diff.after }
      : { file, status: 'ok' });
  }

  const failed = results.filter((r) => r.status === 'fail');
  const unchecked = results.filter((r) => r.status === 'unchecked');

  if (opts.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else if (!results.length) {
    console.log('clean-comments: no changed files to compare.');
  } else {
    if (!failed.length) {
      const checked = results.filter((r) => r.status === 'ok').length;
      const added = results.filter((r) => r.status === 'added').length;
      console.log(`clean-comments: comment-only in ${checked} file(s)${added ? `, ${added} skipped as new` : ''}.`);
    } else {
      console.log(`clean-comments: CODE CHANGED in ${failed.length} file(s).\n`);
      for (const f of failed) {
        console.log(`  ${f.file}: ${f.detail}`);
        if (f.before !== undefined) {
          console.log(`    before: ${f.before.trim()}`);
          console.log(`    after:  ${f.after.trim()}`);
        }
      }
      console.log('\nRevert these files and redo the cleanup. Do not commit.');
    }
    if (unchecked.length) {
      console.log(`NOT checked (no known comment syntax) — review by hand: ${unchecked.map((r) => r.file).join(', ')}`);
    }
  }

  process.exit(failed.length ? 1 : 0);
}

main();
