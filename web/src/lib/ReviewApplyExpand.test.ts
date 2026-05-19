// Manual smoke harness for `ReviewApplyExpand.svelte` (attn-nnj.8.3).
// Pattern mirrors `review/store.test.ts` and `review/resolver.test.ts` —
// `web/` has no vitest config yet, so tests are tsx-runnable functions
// with a tiny harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/ReviewApplyExpand.test.ts
//
// IMPORTANT: this test cannot mount the Svelte component itself — tsx
// evaluates `*.svelte` files as bare TypeScript and the runes (`$state`,
// `$derived`, `$effect`) only compile through the Vite + svelte plugin
// pipeline. So we test the contracts the component depends on:
//
//   1. `reviewStore.openThreeWayApply` + `clearThreeWayApply` write/clear
//      the rune in the expected order (in-test stand-in store mirrors the
//      one-liner methods exactly).
//   2. `text-diff.diffLines` + `diffWordsInLine` produce the add/del/same
//      segments the component consumes for the three columns.
//   3. The accept-vs-keep IPC semantics: `reviewAcceptSuggestion` is
//      called on accept; nothing is sent on keep-mine; the edit path
//      submits the EDITED replacement via the same IPC.
//   4. Cancel (Esc / click-outside) clears state with no IPC.
//   5. The expand fixture renders shape correctly under each scenario.

import { reviewAcceptSuggestion } from './ipc';
import { diffLines, diffWordsInLine } from './review/text-diff';
import type { RequiresThreeWayVerdict } from './types';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

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
// In-test stand-in for the runes-backed reviewStore — mirrors the exact
// open/clear contract from store.svelte.ts. (Same pattern store.test.ts
// uses; `$state` cannot be evaluated in raw tsx.)
// ---------------------------------------------------------------------------

interface StubStore {
  activeThreeWayApply: RequiresThreeWayVerdict | null;
  openThreeWayApply(v: RequiresThreeWayVerdict): void;
  clearThreeWayApply(): void;
}

function makeStubStore(): StubStore {
  return {
    activeThreeWayApply: null,
    openThreeWayApply(v: RequiresThreeWayVerdict): void {
      this.activeThreeWayApply = v;
    },
    clearThreeWayApply(): void {
      this.activeThreeWayApply = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock ipc capture — intercepts `window.ipc.postMessage` so we can assert
// on outbound payloads from `reviewAcceptSuggestion` without spinning up
// the real wry bridge.
// ---------------------------------------------------------------------------

interface IpcCapture {
  messages: unknown[];
  reset(): void;
}

function installIpcCapture(): IpcCapture {
  const capture: IpcCapture = {
    messages: [],
    reset() {
      this.messages = [];
    },
  };
  const w = globalThis as unknown as {
    window?: { ipc?: { postMessage: (m: string) => void } };
  };
  if (!w.window) {
    (w as unknown as { window: object }).window = w as object;
  }
  w.window!.ipc = {
    postMessage(message: string): void {
      capture.messages.push(JSON.parse(message));
    },
  };
  return capture;
}

const ipc = installIpcCapture();

// ---------------------------------------------------------------------------
// Sample verdict fixture
// ---------------------------------------------------------------------------

function sampleVerdict(
  overrides: Partial<RequiresThreeWayVerdict> = {},
): RequiresThreeWayVerdict {
  return {
    kind: 'requires_three_way',
    suggestionId: 'evt-sugg-1',
    roomId: 'room-1',
    targetByteRange: [0, 32],
    snapshotExpected: 'The anchor resolver runs 8 steps.',
    currentText: 'The anchor resolver runs 8 steps, carefully, in order.',
    proposedReplacement: 'The anchor resolver runs 10 steps (+math, +mermaid).',
    confidence: 0.92,
    reviewerDisplayName: 'rufus',
    createdAt: Date.now() - 6 * 60 * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Rendering: a non-null verdict produces three-column-ready diff data
// ---------------------------------------------------------------------------

defineCase('rendering: store with a verdict produces three column inputs', () => {
  const store = makeStubStore();
  const v = sampleVerdict();
  store.openThreeWayApply(v);

  assert(store.activeThreeWayApply !== null, 'expected verdict to be active');
  // The component reads three strings — one per column. They are all
  // distinct in the drift case (this is the entire point of three-way).
  const got = store.activeThreeWayApply;
  assert(got.snapshotExpected !== got.currentText, 'snapshot ≠ current');
  assert(got.currentText !== got.proposedReplacement, 'current ≠ proposed');
  assert(got.snapshotExpected !== got.proposedReplacement, 'snapshot ≠ proposed');

  // The component computes line-diffs for each of "current vs snapshot"
  // and "proposed vs snapshot" to color additions/deletions. Both must
  // contain at least one non-`same` segment in the drift case.
  const currentDelta = diffLines(got.snapshotExpected, got.currentText);
  const proposedDelta = diffLines(got.snapshotExpected, got.proposedReplacement);
  assert(
    currentDelta.some((seg) => seg.kind !== 'same'),
    'current-vs-snapshot diff should have add/del segments',
  );
  assert(
    proposedDelta.some((seg) => seg.kind !== 'same'),
    'proposed-vs-snapshot diff should have add/del segments',
  );
});

// ---------------------------------------------------------------------------
// 2. Diff coloring: deletions vs additions classified correctly
// ---------------------------------------------------------------------------

defineCase('diff coloring: lines-level segments classify add/del correctly', () => {
  const snapshot = 'line A\nline B\nline C\n';
  const current = 'line A\nline B-edited\nline C\n';

  const segs = diffLines(snapshot, current);
  const adds = segs.filter((s) => s.kind === 'add');
  const dels = segs.filter((s) => s.kind === 'del');

  assert(adds.length >= 1, 'expected at least one add segment');
  assert(dels.length >= 1, 'expected at least one del segment');
  assert(
    adds.some((s) => s.text.includes('line B-edited')),
    'add segment should carry edited line text',
  );
  assert(
    dels.some((s) => s.text.includes('line B')),
    'del segment should carry original line text',
  );
});

defineCase('diff coloring: word-level diff inside a single line', () => {
  const snapshot = 'runs 8 steps.';
  const current = 'runs 10 steps (+math, +mermaid).';
  const segs = diffWordsInLine(snapshot, current);
  assert(segs.some((s) => s.kind === 'add'), 'expected at least one word add');
  assert(segs.some((s) => s.kind === 'del'), 'expected at least one word del');
  // `runs` is identical on both sides — should be a `same` segment.
  assert(
    segs.some((s) => s.kind === 'same' && s.text.includes('runs')),
    'expected same-segment to retain unchanged word',
  );
});

// ---------------------------------------------------------------------------
// 3. Accept action emits IPC and clears state
// ---------------------------------------------------------------------------

defineCase('accept theirs: reviewAcceptSuggestion sends IPC + clears store', () => {
  ipc.reset();
  const store = makeStubStore();
  const v = sampleVerdict();
  store.openThreeWayApply(v);

  void reviewAcceptSuggestion(v.roomId, v.suggestionId);
  store.clearThreeWayApply();

  assert(ipc.messages.length === 1, `expected 1 IPC message, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as {
    type: string;
    roomId: string;
    suggestionId: string;
    editedReplacement?: string;
  };
  assert(msg.type === 'review_accept_suggestion', `unexpected type=${msg.type}`);
  assert(msg.roomId === v.roomId, `roomId mismatch: got ${msg.roomId}`);
  assert(
    msg.suggestionId === v.suggestionId,
    `suggestionId mismatch: got ${msg.suggestionId}`,
  );
  assert(
    msg.editedReplacement === undefined,
    `accept-theirs must not carry editedReplacement (got ${String(msg.editedReplacement)})`,
  );
  assert(store.activeThreeWayApply === null, 'store should be cleared after accept');
});

// ---------------------------------------------------------------------------
// 4. Keep mine: no IPC, state cleared
// ---------------------------------------------------------------------------

defineCase('keep mine: no IPC emitted; store cleared', () => {
  ipc.reset();
  const store = makeStubStore();
  const v = sampleVerdict();
  store.openThreeWayApply(v);

  // The component's keepMine() just clears the store — no IPC.
  store.clearThreeWayApply();

  assert(
    ipc.messages.length === 0,
    `expected 0 IPC messages, got ${ipc.messages.length}`,
  );
  assert(store.activeThreeWayApply === null, 'store should be cleared after keep-mine');
});

// ---------------------------------------------------------------------------
// 5. Edit mode: submits EDITED replacement via the same IPC
// ---------------------------------------------------------------------------

defineCase('edit mode: confirmEdit sends editedReplacement + clears store', () => {
  ipc.reset();
  const store = makeStubStore();
  const v = sampleVerdict();
  store.openThreeWayApply(v);

  // Owner hand-merged the diff in the textarea.
  const edited =
    'The anchor resolver runs 9 steps, carefully (+math, +mermaid).';
  void reviewAcceptSuggestion(v.roomId, v.suggestionId, edited);
  store.clearThreeWayApply();

  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as {
    type: string;
    suggestionId: string;
    editedReplacement?: string;
  };
  assert(msg.type === 'review_accept_suggestion', `type=${msg.type}`);
  assert(
    msg.editedReplacement === edited,
    `editedReplacement mismatch: got ${String(msg.editedReplacement)}`,
  );
  assert(store.activeThreeWayApply === null, 'store should be cleared after edit');
});

// ---------------------------------------------------------------------------
// 6. Cancel (Esc / click outside) clears state without IPC
// ---------------------------------------------------------------------------

defineCase('cancel: Esc / click-outside clears state without IPC', () => {
  ipc.reset();
  const store = makeStubStore();
  const v = sampleVerdict();
  store.openThreeWayApply(v);

  // Mirror the component's cancel() handler — pure store mutation.
  store.clearThreeWayApply();

  assert(ipc.messages.length === 0, 'cancel must not send IPC');
  assert(store.activeThreeWayApply === null, 'store should be cleared after cancel');
});

// ---------------------------------------------------------------------------
// 7. Opening a second verdict replaces the first (invariant: one at a time)
// ---------------------------------------------------------------------------

defineCase('one-at-a-time: a second open replaces the first verdict', () => {
  const store = makeStubStore();
  const idA = 'evt-a' as RequiresThreeWayVerdict['suggestionId'];
  const idB = 'evt-b' as RequiresThreeWayVerdict['suggestionId'];
  const v1 = sampleVerdict({ suggestionId: idA });
  const v2 = sampleVerdict({ suggestionId: idB });

  store.openThreeWayApply(v1);
  // Cast through the parent's union: stub only ever holds an evt-{a,b}, so
  // TypeScript narrows after the first assertion. Pull the id through the
  // store fresh on each comparison to defeat that narrowing.
  const firstId = (store.activeThreeWayApply as RequiresThreeWayVerdict | null)
    ?.suggestionId;
  assert(firstId === idA, `expected evt-a active first, got ${String(firstId)}`);

  store.openThreeWayApply(v2);
  const secondId = (store.activeThreeWayApply as RequiresThreeWayVerdict | null)
    ?.suggestionId;
  assert(
    secondId === idB,
    `expected evt-b after replace, got ${String(secondId)}`,
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

function runAllCases(): void {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = run();
    if (r.ok) {
      passed += 1;
      console.log(`  ok  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      failed += 1;
      console.error(`  FAIL ${r.name}\n        ${r.detail ?? '(no detail)'}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
    nodeProcess?.exit?.(1);
  }
}

runAllCases();
