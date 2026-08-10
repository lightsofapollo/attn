// The rail width's read path depends on module-evaluation ORDER, and that
// dependency fails silently (attn-11g4.2).
//
// `WorkspaceEditorFrame.svelte` captures `window.__attn_init__.railWidth` in a
// `<script module>` block, because `App.svelte` deletes the whole payload the
// first time it reads it. If anything ever moves that capture into the
// component instance, or makes App delete the payload at module scope, or
// turns the frame into a dynamic import, the capture quietly reads `undefined`
// and every launch silently starts at 320px. Nothing throws, no test that
// exercises the component notices, and the only symptom is "my rail width
// doesn't stick" — which looks like a daemon or prefs bug, in a completely
// different file.
//
// So the ordering is asserted directly, against the COMPILED output rather
// than the source: `<script module>` being hoisted to module scope is a Svelte
// compiler behaviour, and reading the source would only tell us what we wrote,
// not what runs.
//
// Run with:
//
//   cd web && npx tsx src/lib/review/rail-width-init-order.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'svelte/compiler';

import { RAIL_WIDTH_PX, clampRailWidth } from './rail-mode';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../..');

function compiled(relative: string): string {
  const filename = path.join(srcDir, relative);
  return compile(fs.readFileSync(filename, 'utf8'), { generate: 'client', filename }).js.code;
}

defineCase('the frame reads the init payload at module scope, not per instance', () => {
  const out = compiled('lib/WorkspaceEditorFrame.svelte');
  const capture = out.indexOf('__attn_init__');
  const component = out.search(/function WorkspaceEditorFrame\s*\(/);
  assert(capture !== -1, 'the frame must still read window.__attn_init__ somewhere');
  assert(component !== -1, 'expected a compiled WorkspaceEditorFrame component function');
  assert(
    capture < component,
    'the railWidth capture compiled INSIDE the component function — it now runs after ' +
      'App.svelte has deleted window.__attn_init__, so the stored width is silently ignored. ' +
      'Keep it in the `<script module>` block.',
  );
});

defineCase('App deletes the payload from instance code, after imports have run', () => {
  const out = compiled('App.svelte');
  const del = out.search(/delete\s+window\.__attn_init__/);
  const component = out.search(/function App\s*\(/);
  assert(del !== -1, 'App must still be the one that clears the payload');
  assert(component !== -1, 'expected a compiled App component function');
  assert(
    del > component,
    'App.svelte now deletes window.__attn_init__ at MODULE scope. Module bodies run in ' +
      'import order, so this may execute before the frame captures railWidth.',
  );
});

defineCase('the frame is a static import of App, so it evaluates first', () => {
  const out = compiled('App.svelte');
  assert(
    /^import WorkspaceEditorFrame from/m.test(out),
    'the frame must be a static import — ESM evaluates static dependencies before the ' +
      "importing module's own body, which is the whole basis of the ordering",
  );
  assert(
    !/import\(\s*['"][^'"]*WorkspaceEditorFrame/.test(out),
    'a dynamic import of the frame would evaluate AFTER App has cleared the payload',
  );
});

// --- Degradation ------------------------------------------------------------
//
// Replays the capture expression against every payload shape that reaches it.
// Kept as a literal copy of the frame's logic rather than an import, because
// the point is that the *expression* is total — it has to survive shapes that
// only exist in builds this test cannot instantiate.
function captureRailWidth(win: { __attn_init__?: { railWidth?: unknown } } | undefined): number {
  if (typeof win === 'undefined') return RAIL_WIDTH_PX.expanded;
  const stored = win.__attn_init__?.railWidth;
  return typeof stored === 'number' ? clampRailWidth(stored) : RAIL_WIDTH_PX.expanded;
}

defineCase('the capture expression matches the frame verbatim', () => {
  // If the frame's expression changes, the degradation cases below stop
  // describing reality — so pin them together.
  const frame = fs.readFileSync(path.join(srcDir, 'lib/WorkspaceEditorFrame.svelte'), 'utf8');
  assert(
    frame.includes("typeof stored === 'number' ? clampRailWidth(stored) : RAIL_WIDTH_PX.expanded"),
    'the frame capture changed shape — update captureRailWidth() here to match',
  );
  assert(
    frame.includes("typeof window === 'undefined'"),
    'the frame must still guard the window read for the Node/SSR case',
  );
});

defineCase('every environment that lacks a daemon gets the default, without throwing', () => {
  // Node test environment / SSR — no `window` at all.
  assert(captureRailWidth(undefined) === RAIL_WIDTH_PX.expanded, 'no window → default');
  // Hosted browser build: nothing under src/hosted/ ever sets a payload, so the
  // property is simply absent.
  assert(captureRailWidth({}) === RAIL_WIDTH_PX.expanded, 'no payload → default');
  // The `npm run dev:browser` mock IPC DOES install a payload (mock-ipc.ts),
  // but it has never carried railWidth.
  assert(
    captureRailWidth({ __attn_init__: { } }) === RAIL_WIDTH_PX.expanded,
    'payload without railWidth → default',
  );
  // A daemon predating attn-11g4.2, or one whose prefs.json wrote null.
  assert(
    captureRailWidth({ __attn_init__: { railWidth: undefined } }) === RAIL_WIDTH_PX.expanded,
    'undefined railWidth → default',
  );
  assert(
    captureRailWidth({ __attn_init__: { railWidth: null } }) === RAIL_WIDTH_PX.expanded,
    'null railWidth → default',
  );
  // Junk of the wrong type must not become NaN px.
  assert(
    captureRailWidth({ __attn_init__: { railWidth: '420' } }) === RAIL_WIDTH_PX.expanded,
    'string railWidth → default (never a NaN width)',
  );
  assert(
    captureRailWidth({ __attn_init__: { railWidth: Number.NaN } }) === RAIL_WIDTH_PX.expanded,
    'NaN railWidth → default',
  );
});

defineCase('a real stored width from the daemon is honoured and re-clamped', () => {
  assert(captureRailWidth({ __attn_init__: { railWidth: 480 } }) === 480, 'in-range width is used');
  // The daemon already gates this, but the frame is shared with builds that
  // have no daemon to do the gating.
  assert(captureRailWidth({ __attn_init__: { railWidth: 5000 } }) === 640, 'out-of-range clamps');
  assert(captureRailWidth({ __attn_init__: { railWidth: 10 } }) === 260, 'undersized clamps');
});

defineCase('the daemon actually ships railWidth in the init payload', () => {
  // The other half of the round trip. Without this line in main.rs the capture
  // above is correct and permanently reads `undefined`.
  const mainRs = fs.readFileSync(path.resolve(srcDir, '../../src/main.rs'), 'utf8');
  assert(
    mainRs.includes('"railWidth": rail_width,'),
    'src/main.rs must put railWidth in the init payload, or nothing is ever restored',
  );
  assert(
    mainRs.includes('let rail_width = stored_prefs.rail_width;'),
    'src/main.rs must read the width from the loaded (and range-gated) preferences',
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
