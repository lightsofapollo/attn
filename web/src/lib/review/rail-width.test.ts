// Rail resize bounds and the Rust/TypeScript parity that keeps them honest
// (attn-11g4.2).
//
// Two jobs. First, the arithmetic in `clampRailWidth`/`railResizeMax` — the
// only place a width is decided, on drag, on keypress and on load. Second, the
// cross-language contract: the webview clamps before it sends and
// `src/prefs.rs` clamps before it stores, so if those two ranges ever drift a
// legitimate drag starts writing widths the daemon rejects, and the rail
// silently snaps back to 320 on every restart. That is a miserable bug to find
// by hand, so it is asserted here instead.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/rail-width.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RAIL_WIDTH_MAX_FRACTION,
  RAIL_WIDTH_MAX_PX,
  RAIL_WIDTH_MIN_PX,
  RAIL_WIDTH_PX,
  clampRailWidth,
  computeRailMode,
  railResizeMax,
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

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const prefsRs = fs.readFileSync(
  path.resolve(here, '../../../../src/prefs.rs'),
  'utf8',
);

/** Pull `pub const NAME: u32 = 123;` out of src/prefs.rs. */
function rustConst(name: string): number {
  const match = prefsRs.match(new RegExp(`pub const ${name}: u32 = (\\d+);`));
  assert(match !== null, `src/prefs.rs must declare ${name}`);
  return Number(match[1]);
}

defineCase('the bounds are a usable range around the default', () => {
  assert(RAIL_WIDTH_MIN_PX < RAIL_WIDTH_MAX_PX, 'min must be below max');
  assert(
    RAIL_WIDTH_MIN_PX <= RAIL_WIDTH_PX.expanded &&
      RAIL_WIDTH_PX.expanded <= RAIL_WIDTH_MAX_PX,
    'the default width must be reachable — otherwise reset is a no-op',
  );
  // The rail must be able to grow, not only shrink; a max at the default would
  // make the whole feature a shrink control.
  assert(RAIL_WIDTH_MAX_PX > RAIL_WIDTH_PX.expanded, 'the rail must be able to widen');
});

defineCase('closing the rail reaches zero width without rewriting its saved expanded width', () => {
  const chosenWidth = clampRailWidth(480);
  const closed = computeRailMode({ inReviewRoom: true, panelOpen: false });
  assertEq(closed, 'hidden', 'closed review room maps to hidden');
  assertEq(RAIL_WIDTH_PX[closed], 0, 'hidden rail takes no document width');
  assertEq(clampRailWidth(chosenWidth), chosenWidth, 'the persisted expanded width survives reopening');
});

defineCase('clamp holds the bounds and rounds to whole pixels', () => {
  assertEq(clampRailWidth(400), 400, 'in-range width passes through');
  assertEq(clampRailWidth(10), RAIL_WIDTH_MIN_PX, 'below min pins to min');
  assertEq(clampRailWidth(5000), RAIL_WIDTH_MAX_PX, 'above max pins to max');
  assertEq(clampRailWidth(RAIL_WIDTH_MIN_PX), RAIL_WIDTH_MIN_PX, 'min is inclusive');
  assertEq(clampRailWidth(RAIL_WIDTH_MAX_PX), RAIL_WIDTH_MAX_PX, 'max is inclusive');
  // Sub-pixel widths reach here from pointer deltas on a scaled display.
  assertEq(clampRailWidth(400.4), 400, 'rounds down');
  assertEq(clampRailWidth(400.6), 401, 'rounds up');
});

defineCase('a lost width falls back to the default, not to a bound', () => {
  // NaN means we lost the value (a bad parse, a stale delta), which is not the
  // same as the user asking for something extreme — pinning to min would leave
  // them staring at a rail they never dragged.
  assertEq(clampRailWidth(Number.NaN), RAIL_WIDTH_PX.expanded, 'NaN → default');
  assertEq(clampRailWidth(Number.POSITIVE_INFINITY), RAIL_WIDTH_PX.expanded, '+inf → default');
  assertEq(clampRailWidth(Number.NEGATIVE_INFINITY), RAIL_WIDTH_PX.expanded, '-inf → default');
});

defineCase('the interactive max is a fraction of the row, capped absolutely', () => {
  // A generous row is still capped, so an ultrawide display cannot hand half
  // the screen to comments.
  assertEq(railResizeMax(4000), RAIL_WIDTH_MAX_PX, 'wide row hits the absolute cap');
  // A typical 1440px window with the sidebar open.
  assertEq(
    railResizeMax(1180),
    Math.round(1180 * RAIL_WIDTH_MAX_FRACTION),
    'ordinary row uses the fraction',
  );
  // ...and that leaves the prose column wide enough to still be the subject.
  assert(1180 - railResizeMax(1180) > 700, 'the document keeps at least ~65ch');
});

defineCase('a narrow window removes headroom without redefining the default', () => {
  // attn's own window opens at 960px, which is a ~700px content row. 40% of
  // that is ~280 — narrower than the rail already is. The ceiling must floor
  // at the default, or the first drag in a default-size window would shrink
  // the rail and then refuse to give the width back.
  assertEq(railResizeMax(700), RAIL_WIDTH_PX.expanded, '960px window → no headroom, no shrink');
  assertEq(railResizeMax(500), RAIL_WIDTH_PX.expanded, 'very narrow row still allows the default');
  assertEq(
    clampRailWidth(RAIL_WIDTH_MAX_PX, railResizeMax(700)),
    RAIL_WIDTH_PX.expanded,
    'a drag cannot grow past the floored ceiling',
  );
  // Shrinking always stays available — that is the direction a cramped window
  // actually wants.
  assertEq(clampRailWidth(260, railResizeMax(700)), RAIL_WIDTH_MIN_PX, 'shrink still works');
});

defineCase('the ceiling only rises once the row can afford it', () => {
  // The crossover: below ~800px of row the fraction is under the default.
  assertEq(railResizeMax(800), RAIL_WIDTH_PX.expanded, '800px row → exactly the default');
  assert(
    railResizeMax(900) > RAIL_WIDTH_PX.expanded,
    '900px row has real headroom (40% = 360)',
  );
  assertEq(railResizeMax(900), 360, '900px row → 360');
});

defineCase('an unmeasured row falls back to the absolute cap', () => {
  // `bind:clientWidth` reports 0 until the ResizeObserver fires. A drag started
  // in that window must be bounded by something sane, not by 0.
  assertEq(railResizeMax(0), RAIL_WIDTH_MAX_PX, 'unmeasured row → absolute cap');
  assertEq(railResizeMax(Number.NaN), RAIL_WIDTH_MAX_PX, 'NaN row → absolute cap');
  assertEq(railResizeMax(-100), RAIL_WIDTH_MAX_PX, 'negative row → absolute cap');
});

defineCase('the stored width the frame renders ignores the row-relative cap', () => {
  // Rendering clamps against the ABSOLUTE bounds only. If it used the
  // row-relative cap, opening the window narrow once would rewrite a width the
  // user chose on a wide display the next time anything committed.
  assertEq(clampRailWidth(600), 600, '600 survives regardless of the current row');
});

defineCase('the resize range matches src/prefs.rs exactly', () => {
  assertEq(rustConst('RAIL_WIDTH_MIN'), RAIL_WIDTH_MIN_PX, 'RAIL_WIDTH_MIN parity');
  assertEq(rustConst('RAIL_WIDTH_MAX'), RAIL_WIDTH_MAX_PX, 'RAIL_WIDTH_MAX parity');
  assertEq(
    rustConst('RAIL_WIDTH_DEFAULT'),
    RAIL_WIDTH_PX.expanded,
    'RAIL_WIDTH_DEFAULT parity',
  );
});

defineCase('every width a drag can produce is one the daemon will store', () => {
  // The end-to-end guarantee: whatever `clampRailWidth` emits must land inside
  // the Rust accept range, or `normalize_rail_width` throws it away and resets
  // the user to 320 on the next launch.
  const rustMin = rustConst('RAIL_WIDTH_MIN');
  const rustMax = rustConst('RAIL_WIDTH_MAX');
  const rows = [0, 500, 900, 1180, 1600, 3000];
  const attempts = [-9999, 0, 100, 259, 320, 500, 641, 9999];
  for (const row of rows) {
    for (const attempt of attempts) {
      const width = clampRailWidth(attempt, railResizeMax(row));
      assert(
        width >= rustMin && width <= rustMax,
        `row ${row} + attempt ${attempt} → ${width}, outside the Rust range`,
      );
      assert(Number.isInteger(width), `row ${row} + attempt ${attempt} → non-integer ${width}`);
    }
  }
});

defineCase('the frame wires the handle to the pointer and keyboard contract', () => {
  // Shape-level, but these are the pieces that silently stop working: an
  // affordance with no pointer capture drops the drag the moment the cursor
  // leaves a 10px strip, and a separator without aria-valuenow is invisible to
  // a screen reader even though it is focusable.
  const frame = fs.readFileSync(path.resolve(here, '../WorkspaceEditorFrame.svelte'), 'utf8');
  assert(frame.includes('data-slot="rail-resize-handle"'), 'handle needs a stable automation slot');
  assert(frame.includes('setPointerCapture'), 'drag must use pointer capture, not window listeners');
  assert(frame.includes('role="separator"'), 'handle must be a splitter, not a bare div');
  assert(frame.includes('aria-valuenow={expandedWidth}'), 'separator must report its value');
  assert(frame.includes('aria-orientation="vertical"'), 'separator orientation must be explicit');
  assert(frame.includes('ondblclick={resetRailWidth}'), 'double-click must reset to default');
  assert(frame.includes('tabindex="0"'), 'handle must be reachable by keyboard');
  assert(frame.includes('touch-action: none'), 'touch drag must resize, not scroll');
  // The rail width is driven frame-by-frame; easing it would trail the cursor.
  assert(!/transition:[^;]*\bwidth\b/.test(frame), 'the rail width must never be animated');
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
