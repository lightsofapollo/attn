// Manual smoke harness for the review-rail mode derivation (attn-d7y,
// reworked by attn-42y).
//
// Run with:
//
//   cd web && npx tsx src/lib/review/rail-mode.test.ts

import {
  COLLAPSED_RAIL_TOP_CLEARANCE,
  RAIL_WIDTH_PX,
  computeRailMode,
} from './rail-mode';

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

defineCase('expanded only inside a review room (panelOpen now defaults open)', () => {
  assert(
    computeRailMode({ inReviewRoom: true, panelOpen: true }) === 'expanded',
    'review room + open → expanded',
  );
  // panelOpen defaults to TRUE (floating cards are the resting state), so a
  // roomless file must stay rail-free no matter what the flag says —
  // otherwise every local document renders an empty phantom rail.
  assert(
    computeRailMode({ inReviewRoom: false, panelOpen: true }) === 'hidden',
    'local file + open → hidden (no room, no rail)',
  );
});

defineCase('a closed panel fully hides the rail even in a review room', () => {
  assert(
    computeRailMode({ inReviewRoom: true, panelOpen: false }) === 'hidden',
    'review room + closed → hidden (no marker gutter)',
  );
});

defineCase('hidden outside a review room with the panel closed', () => {
  assert(
    computeRailMode({ inReviewRoom: false, panelOpen: false }) === 'hidden',
    'local file + closed → hidden (historical behavior)',
  );
});

defineCase('width mapping: hidden 0, collapsed 48, expanded 320', () => {
  assert(RAIL_WIDTH_PX.hidden === 0, 'hidden → 0px');
  assert(RAIL_WIDTH_PX.collapsed === 48, 'collapsed → 48px');
  assert(RAIL_WIDTH_PX.expanded === 320, 'expanded → 320px');
});

defineCase('legacy collapsed-gutter clearance stays scoped to resolved-chip layout', () => {
  // `collapsed` is not emitted by the shared toggle, but the resolved-chip
  // redesign still imports this layout constant.
  assert(
    COLLAPSED_RAIL_TOP_CLEARANCE > 0 && COLLAPSED_RAIL_TOP_CLEARANCE <= 16,
    'clearance is breathing room, not dock clearance',
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
