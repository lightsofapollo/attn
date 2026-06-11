// Manual harness for the pure margin-layout helpers (attn-nnj.4.3).
//
// Same convention as `selectors.test.ts`: no test framework, just
// `tsx`-runnable assertions. Run with:
//
//   cd web && npx tsx src/lib/review/margin-layout.test.ts
//
// `layoutCards` is the collision-detection logic from
// `planning/collab/ui/review-panel-design.md` §1.3. `visibleCards`
// implements the §6 virtualization band.

import { fitBottom, layoutCards, visibleCards } from './margin-layout';

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => CaseResult> = [];

function defineCase(name: string, fn: () => void | string): void {
  cases.push(() => {
    try {
      const note = fn();
      return { name, ok: true, detail: typeof note === 'string' ? note : undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, ok: false, detail: message };
    }
  });
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

defineCase('layoutCards: single card sits at its anchor', () => {
  const out = layoutCards([{ id: 'a', anchorY: 100, height: 80 }]);
  assert(out.length === 1, `expected 1 placement, got ${out.length}`);
  assert(out[0]!.top === 100, `expected top=100, got ${out[0]!.top}`);
  assert(out[0]!.offset === false, 'single card should not be offset');
});

defineCase('layoutCards: non-overlapping anchors stay at their anchorY', () => {
  const out = layoutCards([
    { id: 'a', anchorY: 0, height: 80 },
    { id: 'b', anchorY: 200, height: 80 },
  ]);
  assert(out[0]!.top === 0 && out[0]!.offset === false, 'a should stay');
  assert(out[1]!.top === 200 && out[1]!.offset === false, 'b should stay');
});

defineCase('layoutCards: overlapping anchors push later cards down', () => {
  // a sits at 0..80; b's anchor is at 50 which overlaps. b should bump to
  // 80 + 8 (gutter) = 88 and be flagged offset.
  const out = layoutCards([
    { id: 'a', anchorY: 0, height: 80 },
    { id: 'b', anchorY: 50, height: 60 },
  ]);
  assert(out[0]!.top === 0, `a should sit at 0, got ${out[0]!.top}`);
  assert(out[0]!.offset === false, 'a should not be offset');
  assert(out[1]!.top === 88, `b should bump to 88, got ${out[1]!.top}`);
  assert(out[1]!.offset === true, 'b should be marked offset');
});

defineCase('layoutCards: custom gutter is honored', () => {
  const out = layoutCards(
    [
      { id: 'a', anchorY: 0, height: 100 },
      { id: 'b', anchorY: 50, height: 60 },
    ],
    { gutter: 20 },
  );
  assert(out[1]!.top === 120, `expected top=120 with gutter=20, got ${out[1]!.top}`);
});

defineCase('layoutCards: returns in caller order even when input is unsorted', () => {
  const out = layoutCards([
    { id: 'b', anchorY: 200, height: 80 },
    { id: 'a', anchorY: 50, height: 80 },
  ]);
  // Returned in caller order so the component can map 1:1 over its source.
  assert(out[0]!.id === 'b', `expected first id=b, got ${out[0]!.id}`);
  assert(out[1]!.id === 'a', `expected second id=a, got ${out[1]!.id}`);
  // Layout-wise, a comes first (anchorY=50) and b comes second (anchorY=200,
  // which is past a's bottom 50+80=130 + gutter 8 = 138, so b stays).
  assert(out[0]!.top === 200, `b should be at 200, got ${out[0]!.top}`);
  assert(out[1]!.top === 50, `a should be at 50, got ${out[1]!.top}`);
});

defineCase('layoutCards: cascade of three overlapping anchors stacks correctly', () => {
  const out = layoutCards([
    { id: 'a', anchorY: 0, height: 80 },
    { id: 'b', anchorY: 10, height: 80 },
    { id: 'c', anchorY: 20, height: 80 },
  ]);
  assert(out[0]!.top === 0, 'a at 0');
  assert(out[1]!.top === 88, `b at 88, got ${out[1]!.top}`);
  assert(out[2]!.top === 176, `c at 176, got ${out[2]!.top}`);
  assert(out[0]!.offset === false && out[1]!.offset === true && out[2]!.offset === true, 'flags');
});

defineCase('layoutCards: never sits above the anchor', () => {
  // First card anchors at 500; second at 100 (way above). Second card should
  // stay at 100, not be pushed up.
  const out = layoutCards([
    { id: 'late', anchorY: 500, height: 80 },
    { id: 'early', anchorY: 100, height: 80 },
  ]);
  // Sorted by anchorY: early (100) then late (500). Both fit without push.
  const early = out.find((p) => p.id === 'early')!;
  const late = out.find((p) => p.id === 'late')!;
  assert(early.top === 100, 'early stays at 100');
  assert(late.top === 500, 'late stays at 500');
});

// ---------------------------------------------------------------------------
// Visibility band
// ---------------------------------------------------------------------------

defineCase('visibleCards: drops anything outside the viewport ± band', () => {
  const placements = [
    { id: 'top', anchorY: 0, top: 0, offset: false },
    { id: 'mid', anchorY: 1000, top: 1000, offset: false },
    { id: 'bot', anchorY: 9000, top: 9000, offset: false },
  ];
  const heights = new Map([['top', 80], ['mid', 80], ['bot', 80]]);
  const out = visibleCards(placements, heights, {
    viewportTop: 800,
    viewportHeight: 600,
    bandPx: 200,
  });
  // Visible band = [600, 1600]. Only `mid` (1000..1080) qualifies.
  assert(out.length === 1, `expected 1 visible, got ${out.length}`);
  assert(out[0]!.id === 'mid', `expected mid, got ${out[0]?.id}`);
});

defineCase('visibleCards: defaults bandPx=800 and includes near-viewport cards', () => {
  const placements = [
    { id: 'near', anchorY: 0, top: -700, offset: false },
    { id: 'far', anchorY: 0, top: -2000, offset: false },
  ];
  const heights = new Map([['near', 40], ['far', 40]]);
  const out = visibleCards(placements, heights, {
    viewportTop: 0,
    viewportHeight: 600,
    // no bandPx → default 800
  });
  const ids = out.map((p) => p.id);
  assert(ids.includes('near'), 'near should be included');
  assert(!ids.includes('far'), 'far should be excluded');
});

defineCase('fitBottom: an on-screen-anchored card never clips past the bottom', () => {
  // Anchor at 540 in a 600px container; a 120px card would end at 660.
  const placed = layoutCards([{ id: 'a', anchorY: 540, height: 120 }]);
  const heights = new Map([['a', 120]]);
  const fitted = fitBottom(placed, heights, { containerHeight: 600 });
  assert(fitted[0]!.top === 480, `card lifted to fit: top=${fitted[0]!.top}`);
  assert(fitted[0]!.offset === true, 'lifted card is flagged offset (connector)');
});

defineCase('fitBottom: cascading lift keeps the gutter between bottom cards', () => {
  const inputs = [
    { id: 'a', anchorY: 400, height: 120 },
    { id: 'b', anchorY: 560, height: 120 },
  ];
  const heights = new Map(inputs.map((i) => [i.id, i.height]));
  const fitted = fitBottom(layoutCards(inputs), heights, { containerHeight: 600 });
  const b = fitted.find((p) => p.id === 'b')!;
  const a = fitted.find((p) => p.id === 'a')!;
  assert(b.top === 480, `bottom card fits: top=${b.top}`);
  assert(a.top === 480 - 8 - 120, `upper card cascades up: top=${a.top}`);
  assert(a.offset && b.offset, 'both lifted cards flagged offset');
});

defineCase('fitBottom: below-the-fold anchors keep tracking off-screen', () => {
  // Anchor at 700 in a 600px container — its text is not visible, so the
  // card must stay with it (attn-23m) instead of being yanked into view.
  const placed = layoutCards([{ id: 'a', anchorY: 700, height: 120 }]);
  const heights = new Map([['a', 120]]);
  const fitted = fitBottom(placed, heights, { containerHeight: 600 });
  assert(fitted[0]!.top === 700, 'off-screen card untouched');
  assert(fitted[0]!.offset === false, 'not flagged offset');
});

defineCase('fitBottom: mid-viewport cards are untouched and order is preserved', () => {
  const inputs = [
    { id: 'mid', anchorY: 100, height: 96 },
    { id: 'low', anchorY: 560, height: 96 },
  ];
  const heights = new Map(inputs.map((i) => [i.id, i.height]));
  const fitted = fitBottom(layoutCards(inputs), heights, { containerHeight: 600 });
  assert(fitted[0]!.id === 'mid' && fitted[1]!.id === 'low', 'caller order kept');
  assert(fitted[0]!.top === 100 && fitted[0]!.offset === false, 'mid card untouched');
  assert(fitted[1]!.top === 504, `low card fitted: top=${fitted[1]!.top}`);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures: CaseResult[] = [];

for (const run of cases) {
  const result = run();
  if (result.ok) {
    pass += 1;
    console.log(`  ✓ ${result.name}`);
  } else {
    fail += 1;
    failures.push(result);
    console.log(`  ✗ ${result.name}`);
    if (result.detail) console.log(`      ${result.detail}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (${cases.length} total)`);

if (fail > 0) {
  // `process` exists at runtime under `tsx` but not in the ambient web
  // tsconfig; same shim as selectors.test.ts.
  interface NodeProcessShape {
    exit?: (code: number) => void;
  }
  const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
  nodeProcess?.exit?.(1);
}
