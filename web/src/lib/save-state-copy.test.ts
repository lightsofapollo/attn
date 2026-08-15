// The save-state vocabulary has one home (design-system consolidation,
// 2026-08-08 — issue 9 of the conflict inventory).
//
// Before attn-yzsa the native chip and the hosted shell told the same user two
// different sentences about the same fact. The constants module ended that;
// this test keeps it ended: the canonical strings are pinned (a copy change is
// a deliberate edit HERE, reviewed once), and no orphan literal of them may
// survive in source — a literal that compiles is a literal that drifts.
//
// Run with:
//
//   cd web && npx tsx src/lib/save-state-copy.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_FIRST_CLAIM,
  SAVE_STATE_AUTOSAVED,
  SAVE_STATE_AUTOSAVED_TITLE,
  SAVE_STATE_SAVING,
  SAVE_STATE_STORAGE_ATTENTION,
} from './save-state-copy';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void): void {
  cases.push(() => {
    try {
      fn();
      return { name, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

defineCase('the canonical copy is what the owner ratified', () => {
  // Owner-confirmed 2026-08-08. Changing any of these is a product decision,
  // not a refactor — this case exists so the diff that changes one says so.
  assert(SAVE_STATE_AUTOSAVED === 'Changes autosaved', 'resting state');
  assert(
    SAVE_STATE_AUTOSAVED_TITLE === 'Changes autosaved on this device',
    'the title keeps the local half of the claim',
  );
  assert(SAVE_STATE_SAVING === 'Saving…', 'in-flight state');
  assert(SAVE_STATE_STORAGE_ATTENTION === 'Storage needs attention', 'hosted failure state');
  assert(LOCAL_FIRST_CLAIM === 'Saved on this device', 'the standing local-first claim');
});

defineCase('no orphan literal survives in source', () => {
  // Sweep every source file for the raw strings. Allowed homes: the constants
  // module itself and test files (which pin copy on purpose). Comments are
  // stripped first — prose ABOUT the copy is documentation, not drift.
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const needles = [
    SAVE_STATE_AUTOSAVED_TITLE, // before its prefix so the prefix match cannot shadow it
    SAVE_STATE_AUTOSAVED,
    SAVE_STATE_SAVING,
    SAVE_STATE_STORAGE_ATTENTION,
    LOCAL_FIRST_CLAIM,
  ];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'anchor-wasm-pkg') continue;
        walk(full);
        continue;
      }
      if (!/\.(svelte|ts)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      if (entry.name === 'save-state-copy.ts') continue;
      const raw = fs.readFileSync(full, 'utf8');
      const bare = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      for (const needle of needles) {
        if (bare.includes(`'${needle}'`) || bare.includes(`"${needle}"`) || bare.includes(`\`${needle}\``)) {
          offenders.push(`${path.relative(srcRoot, full)}: '${needle}'`);
        }
      }
    }
  };
  walk(srcRoot);
  assert(
    offenders.length === 0,
    `save-state copy must come from save-state-copy.ts, found literals:\n  ${offenders.join('\n  ')}`,
  );
});

defineCase('both surfaces consume the module', () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string): string => fs.readFileSync(path.join(srcRoot, rel), 'utf8');
  assert(
    read('App.svelte').includes("from './lib/save-state-copy'"),
    'the native chip must import the shared copy',
  );
  assert(
    read('hosted/app/types.ts').includes('typeof SAVE_STATE_AUTOSAVED'),
    'the hosted SaveState union must derive from the constants, not restate them',
  );
  assert(
    read('hosted/app/autosave.ts').includes('SAVE_STATE_AUTOSAVED'),
    'the hosted autosave controller must emit the shared constants',
  );
  assert(
    read('hosted/app/EditorShell.svelte').includes('SAVE_STATE_AUTOSAVED_TITLE')
      && read('hosted/app/EditorShell.svelte').includes('<SaveChip'),
    'the hosted header must pass canonical copy to the shared icon chip',
  );
});

let failed = 0;
for (const run of cases) {
  const result = run();
  if (result.ok) {
    console.log(`PASS ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${result.name}`);
    if (result.detail) console.error(`  ${result.detail}`);
  }
}

if (failed > 0) process.exit(1);
