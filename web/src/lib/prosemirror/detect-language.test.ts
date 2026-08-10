// Heuristic language detection for untagged code fences (attn-rd3j.10).
//
// The policy under test is "confident-match-or-nothing": a wrong guess paints
// misleading syntax colors over a config sample, which is worse than leaving
// the block plain. So the negative cases matter as much as the positive ones.
export {};

import { detectLanguage } from './detect-language';

interface CaseResult { name: string; ok: boolean; detail?: string }
const cases: Array<() => Promise<CaseResult>> = [];

function defineCase(name: string, fn: () => Promise<void> | void): void {
  cases.push(async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  });
}

function assertDetected(source: string, expected: string | undefined, label: string): void {
  const actual = detectLanguage(source);
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

defineCase('detects JSON by parsing it, not by guessing', () => {
  assertDetected('{\n  "name": "attn",\n  "version": "0.3.5"\n}', 'json', 'object');
  assertDetected('[1, 2, 3]', 'json', 'array');
  // Looks like JSON, is not JSON — must not claim it.
  assertDetected('{ this is prose in braces', undefined, 'near-miss');
});

defineCase('detects shell transcripts by command shape', () => {
  assertDetected('cd web\nnpm install\nnpm run build', 'bash', 'commands');
  assertDetected('$ git status\n$ git commit -m "x"', 'bash', 'prompted');
});

defineCase('honors shebangs', () => {
  assertDetected('#!/usr/bin/env bash\nset -euo pipefail\ndo_thing', 'bash', 'bash');
  assertDetected('#!/usr/bin/env python3\nprint("hi")', 'python', 'python');
  assertDetected('#!/usr/bin/env node\nconsole.log(1)', 'javascript', 'node');
});

defineCase('detects rust', () => {
  assertDetected(
    'use std::fs;\n\npub fn read_config(path: &Path) -> Result<Config> {\n    let mut buf = String::new();\n}',
    'rust',
    'rust',
  );
});

defineCase('detects python', () => {
  assertDetected(
    'import os\n\ndef main():\n    print(os.getcwd())\n\nclass Config:\n    pass',
    'python',
    'python',
  );
});

defineCase('separates typescript from javascript by type annotations', () => {
  assertDetected(
    "import { x } from './x';\n\nexport function f(a: string): void {\n  const b = a;\n}",
    'typescript',
    'typescript',
  );
  assertDetected(
    "const add = (a, b) => a + b;\nexport default function main() {\n  return add(1, 2);\n}",
    'javascript',
    'javascript',
  );
});

defineCase('detects yaml, toml, sql, go and diffs', () => {
  assertDetected('name: attn\nversion: 0.3.5\ndeps:\n  - vite\n  - svelte', 'yaml', 'yaml');
  assertDetected('[package]\nname = "attn"\nversion = "0.3.5"', 'toml', 'toml');
  assertDetected('SELECT id, name FROM users WHERE active = 1 ORDER BY name;', 'sql', 'sql');
  assertDetected('package main\n\nfunc main() {\n\tx := 1\n}', 'go', 'go');
  assertDetected('--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new', 'diff', 'diff');
});

defineCase('stays undefined when nothing is confident', () => {
  assertDetected('', undefined, 'empty');
  assertDetected('   \n  \n', undefined, 'whitespace');
  assertDetected('some plain words\nwithout any structure', undefined, 'prose');
  assertDetected('TODO: write this section', undefined, 'note');
});

defineCase('repeat calls hit the cache and stay stable', () => {
  const source = 'name: attn\nversion: 0.3.5\ndeps:\n  - vite\n  - svelte';
  const first = detectLanguage(source);
  const second = detectLanguage(source);
  if (first !== second) throw new Error(`cache drift: ${String(first)} then ${String(second)}`);
});

async function runAllCases(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const run of cases) {
    const result = await run();
    if (result.ok) {
      passed += 1;
      console.log(`PASS ${result.name}`);
    } else {
      failures.push(`${result.name}: ${result.detail ?? 'unknown failure'}`);
      console.error(`FAIL ${result.name}\n${result.detail ?? ''}`);
    }
  }
  console.log(`detect-language: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void runAllCases();
