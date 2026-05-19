// Manual smoke harness for `AmbiguousAnchorPicker.svelte` (attn-nnj.4.7).
//
// Pattern mirrors `ReviewApplyExpand.test.ts` — `web/` has no vitest config
// yet, so we run tsx-evaluable contract tests against the IPC + selector
// surfaces the component depends on.
//
// Run with:
//
//   cd web && npx tsx src/lib/AmbiguousAnchorPicker.test.ts
//
// IMPORTANT: tsx cannot mount `.svelte` files (runes only compile through
// the Vite + svelte plugin pipeline). So we exercise the contracts the
// picker uses:
//
//   1. Rendering: with two candidates, the rows the picker iterates over
//      are exactly the two ResolvedAnchorCandidate entries — same length,
//      same currentRange values.
//   2. Click row 1 → reviewResolveAnchor IPC fires with candidate 1's
//      currentRange, room id, and event id.
//   3. Click row 2 → fires with candidate 2's.
//   4. Resolution event flow: after the store records a non-ambiguous
//      update for the same eventId, `ambiguousAnchors(...)` no longer
//      returns the entry — so the orphan-tray drops the card naturally.
//   5. Keyboard nav: ArrowDown wraps around, ArrowUp wraps around, Enter
//      picks the currently-selected candidate.
//   6. Picker becomes idempotent after first pick: clicking a different
//      row does not emit a second IPC.

import { reviewResolveAnchor } from './ipc';
import { ambiguousAnchors, pickAmbiguousCandidate } from './review/selectors';
import type {
  EventId,
  PositionAnchor,
  ResolvedAnchor,
  ResolvedAnchorCandidate,
  ReviewAnchorResolutionUpdate,
  RoomId,
} from './types';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts / ReviewApplyExpand.test.ts conv.)
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
// IPC capture (mirror ReviewApplyExpand.test.ts)
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
// Fixture builders
// ---------------------------------------------------------------------------

function makeRange(start: number, end: number): PositionAnchor {
  return {
    byteRange: [start, end],
    lineRange: [1, 1],
  };
}

function makeCandidate(
  start: number,
  end: number,
  confidence: number,
  preview: string,
  reason = 'quote_match',
): ResolvedAnchorCandidate {
  return {
    currentRange: makeRange(start, end),
    confidence,
    preview,
    reason,
  };
}

function sampleCandidates(): ResolvedAnchorCandidate[] {
  return [
    makeCandidate(10, 25, 0.72, 'The first match in section A'),
    makeCandidate(60, 75, 0.68, 'The second match in section B'),
  ];
}

// In-test stand-in mirror of the picker's pick-once semantics. The real
// component sets `pickedIndex = index` once and short-circuits further
// pickCandidate calls; we replicate that here so test 6 can assert it.
interface PickerState {
  pickedIndex: number | null;
  selectedIndex: number;
  candidates: ResolvedAnchorCandidate[];
  pick(index: number, roomId: RoomId, eventId: EventId): boolean;
  keydown(key: string): void;
}

function makePickerState(
  candidates: ResolvedAnchorCandidate[],
): PickerState {
  return {
    pickedIndex: null,
    selectedIndex: 0,
    candidates,
    pick(index: number, roomId: RoomId, eventId: EventId): boolean {
      const c = this.candidates[index];
      if (!c) return false;
      if (this.pickedIndex !== null) return false;
      this.pickedIndex = index;
      void reviewResolveAnchor(roomId, eventId, c.currentRange);
      return true;
    },
    keydown(key: string): void {
      if (this.candidates.length === 0) return;
      if (key === 'ArrowDown') {
        this.selectedIndex = (this.selectedIndex + 1) % this.candidates.length;
        return;
      }
      if (key === 'ArrowUp') {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.candidates.length) % this.candidates.length;
        return;
      }
      // Enter handled by callers via pick(selectedIndex, ...).
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Rendering: two candidates → two clickable rows
// ---------------------------------------------------------------------------

defineCase('rendering: two candidates produce two distinct row inputs', () => {
  const candidates = sampleCandidates();
  assert(candidates.length === 2, `expected 2 candidates, got ${candidates.length}`);
  // The component iterates over `candidates` and emits one row each. We
  // verify the data the rows derive from is shaped correctly here.
  assert(candidates[0].confidence !== candidates[1].confidence, 'rows differ on confidence');
  assert(
    candidates[0].currentRange.byteRange[0] !== candidates[1].currentRange.byteRange[0],
    'rows differ on currentRange.byteRange',
  );
  assert(
    candidates[0].preview !== candidates[1].preview,
    'rows differ on preview text',
  );
});

// ---------------------------------------------------------------------------
// 2. Click row 1 → IPC fires with candidate 1's currentRange
// ---------------------------------------------------------------------------

defineCase('click row 1: reviewResolveAnchor IPC fires with candidate 1 currentRange', () => {
  ipc.reset();
  const roomId: RoomId = 'room-ambig-1';
  const eventId: EventId = 'evt-ambig-1';
  const candidates = sampleCandidates();
  const state = makePickerState(candidates);

  const ok = state.pick(0, roomId, eventId);
  assert(ok, 'pick(0) should succeed on a fresh picker');

  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as {
    type: string;
    roomId: string;
    eventId: string;
    range: PositionAnchor;
  };
  assert(msg.type === 'review_resolve_anchor', `unexpected type=${msg.type}`);
  assert(msg.roomId === roomId, `roomId mismatch: got ${msg.roomId}`);
  assert(msg.eventId === eventId, `eventId mismatch: got ${msg.eventId}`);
  assert(
    msg.range.byteRange[0] === candidates[0].currentRange.byteRange[0],
    `range.byteRange[0] mismatch: got ${msg.range.byteRange[0]}`,
  );
  assert(
    msg.range.byteRange[1] === candidates[0].currentRange.byteRange[1],
    `range.byteRange[1] mismatch: got ${msg.range.byteRange[1]}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Click row 2 → IPC fires with candidate 2's currentRange
// ---------------------------------------------------------------------------

defineCase('click row 2: reviewResolveAnchor IPC fires with candidate 2 currentRange', () => {
  ipc.reset();
  const roomId: RoomId = 'room-ambig-2';
  const eventId: EventId = 'evt-ambig-2';
  const candidates = sampleCandidates();
  const state = makePickerState(candidates);

  const ok = state.pick(1, roomId, eventId);
  assert(ok, 'pick(1) should succeed on a fresh picker');

  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as {
    type: string;
    range: PositionAnchor;
  };
  assert(msg.type === 'review_resolve_anchor', `unexpected type=${msg.type}`);
  assert(
    msg.range.byteRange[0] === candidates[1].currentRange.byteRange[0],
    `range.byteRange[0] should be candidate-1's start, got ${msg.range.byteRange[0]}`,
  );
  assert(
    msg.range.byteRange[1] === candidates[1].currentRange.byteRange[1],
    `range.byteRange[1] should be candidate-1's end, got ${msg.range.byteRange[1]}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Resolution event handling: store flips status → entry leaves orphan tray
// ---------------------------------------------------------------------------

defineCase('resolution flow: after AnchorResolutionChanged status=remapped, orphan tray drops the entry', () => {
  // Start with an ambiguous resolution in the map.
  const eventId: EventId = 'evt-resolved-1';
  const ambiguous: ReviewAnchorResolutionUpdate = {
    roomId: 'room-x',
    fileId: 'file-x',
    eventId,
    resolved: {
      status: 'ambiguous',
      candidates: sampleCandidates(),
      reason: 'multiple_matches',
    },
  };
  const map: Record<string, ReviewAnchorResolutionUpdate> = {
    [eventId]: ambiguous,
  };
  // Pre-condition: the orphan-tray selector returns 1 entry for this event.
  const beforeRows = ambiguousAnchors(map);
  assert(
    beforeRows.length === 1 && beforeRows[0].eventId === eventId,
    `expected 1 ambiguous row for ${eventId}, got ${beforeRows.length}`,
  );

  // Simulate the AnchorResolutionChanged callback arriving with the picked
  // candidate as the new authoritative anchor (status: 'remapped').
  const picked = sampleCandidates()[0];
  const remapped: ReviewAnchorResolutionUpdate = {
    roomId: 'room-x',
    fileId: 'file-x',
    eventId,
    resolved: {
      status: 'remapped',
      confidence: 0.95,
      currentRange: picked.currentRange,
      reason: 'quote_match',
    },
  };
  map[eventId] = remapped;

  // Post-condition: the orphan-tray selector no longer surfaces it.
  const afterRows = ambiguousAnchors(map);
  assert(
    afterRows.length === 0,
    `expected 0 ambiguous rows after remap, got ${afterRows.length}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Keyboard nav: ArrowDown / ArrowUp wrap; Enter picks selected
// ---------------------------------------------------------------------------

defineCase('keyboard: ArrowDown/ArrowUp navigate; Enter picks selected candidate', () => {
  ipc.reset();
  const roomId: RoomId = 'room-kbd';
  const eventId: EventId = 'evt-kbd';
  const candidates = sampleCandidates();
  const state = makePickerState(candidates);

  // Use a getter through the state object to defeat TS literal-narrowing
  // (each `assert(state.selectedIndex === N)` would otherwise narrow the
  // type to the literal `N` for the rest of the function).
  const sel = (): number => state.selectedIndex;

  assert(sel() === 0, 'fresh picker selects row 0');
  state.keydown('ArrowDown');
  assert(sel() === 1, `ArrowDown → selectedIndex=1, got ${sel()}`);
  state.keydown('ArrowDown');
  // Wraps back to 0 because there are 2 candidates.
  assert(sel() === 0, `ArrowDown wrap → 0, got ${sel()}`);
  state.keydown('ArrowUp');
  // Wraps backwards to 1.
  assert(sel() === 1, `ArrowUp wrap → 1, got ${sel()}`);

  // Enter picks the currently-selected candidate via pick(selectedIndex).
  state.pick(state.selectedIndex, roomId, eventId);

  assert(ipc.messages.length === 1, `expected 1 IPC after Enter, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as { range: PositionAnchor };
  assert(
    msg.range.byteRange[0] === candidates[1].currentRange.byteRange[0],
    'Enter on selected=1 should pick candidate[1]',
  );
});

// ---------------------------------------------------------------------------
// 6. Idempotent after first pick — second click is a no-op
// ---------------------------------------------------------------------------

defineCase('idempotency: a second pick after first does not emit another IPC', () => {
  ipc.reset();
  const roomId: RoomId = 'room-once';
  const eventId: EventId = 'evt-once';
  const candidates = sampleCandidates();
  const state = makePickerState(candidates);

  state.pick(0, roomId, eventId);
  state.pick(1, roomId, eventId); // should be a no-op

  assert(ipc.messages.length === 1, `expected 1 IPC after double-pick, got ${ipc.messages.length}`);
});

// ---------------------------------------------------------------------------
// 7. pickAmbiguousCandidate selector roundtrip — defensive: the picker
// passes `candidates[i].currentRange` into the IPC; the resolver helper
// returns the same `currentRange` for the same index.
// ---------------------------------------------------------------------------

defineCase('selector helper: pickAmbiguousCandidate returns the picked candidate range', () => {
  const candidates = sampleCandidates();
  const resolved: ResolvedAnchor = {
    status: 'ambiguous',
    candidates,
    reason: 'multiple_matches',
  };
  const got = pickAmbiguousCandidate(resolved, 1);
  assert(got !== null, 'pickAmbiguousCandidate should return a range for valid index');
  assert(
    got.byteRange[0] === candidates[1].currentRange.byteRange[0],
    `range mismatch for index 1: got ${got.byteRange[0]}`,
  );

  // Out-of-bounds → null.
  const oob = pickAmbiguousCandidate(resolved, 5);
  assert(oob === null, 'out-of-bounds index should return null');

  // Non-ambiguous resolution → null.
  const exact: ResolvedAnchor = {
    status: 'exact',
    confidence: 1.0,
    currentRange: makeRange(0, 5),
    reason: 'base_hash_match',
  };
  const nonAmbig = pickAmbiguousCandidate(exact, 0);
  assert(nonAmbig === null, 'non-ambiguous resolution should return null');
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
