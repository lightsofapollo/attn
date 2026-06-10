// Manual smoke harness for the review-rail mode derivation (attn-d7y).
//
// Run with:
//
//   cd web && npx tsx src/lib/review/rail-mode.test.ts

import { RAIL_WIDTH_PX, computeRailMode } from './rail-mode';

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

defineCase('closed whenever the panel is closed, regardless of contents', () => {
  for (const active of [0, 3]) {
    for (const resolved of [0, 5]) {
      for (const expanded of [false, true]) {
        const mode = computeRailMode({
          panelOpen: false,
          activeThreadCount: active,
          resolvedThreadCount: resolved,
          hasExpandedResolved: expanded,
        });
        assert(mode === 'closed', `closed expected for active=${active} resolved=${resolved} expanded=${expanded}, got ${mode}`);
      }
    }
  }
});

defineCase('full when any active thread exists (with or without resolved)', () => {
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 1, resolvedThreadCount: 0, hasExpandedResolved: false }) === 'full',
    'one active, no resolved → full',
  );
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 2, resolvedThreadCount: 7, hasExpandedResolved: false }) === 'full',
    'active + resolved mix → full',
  );
});

defineCase('slim when only resolved threads exist and nothing is expanded', () => {
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 0, resolvedThreadCount: 1, hasExpandedResolved: false }) === 'slim',
    'single resolved thread → slim',
  );
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 0, resolvedThreadCount: 12, hasExpandedResolved: false }) === 'slim',
    'many resolved threads → slim',
  );
});

defineCase('full when a resolved thread is expanded (card needs the width)', () => {
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 0, resolvedThreadCount: 1, hasExpandedResolved: true }) === 'full',
    'expanded resolved card → full',
  );
});

defineCase('full when there are no threads at all (empty state needs the width)', () => {
  assert(
    computeRailMode({ panelOpen: true, activeThreadCount: 0, resolvedThreadCount: 0, hasExpandedResolved: false }) === 'full',
    'zero threads → full (empty state)',
  );
});

defineCase('width mapping: closed 0, slim 48, full 320', () => {
  assert(RAIL_WIDTH_PX.closed === 0, 'closed → 0px');
  assert(RAIL_WIDTH_PX.slim === 48, 'slim → 48px');
  assert(RAIL_WIDTH_PX.full === 320, 'full → 320px');
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
