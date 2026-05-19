// Manual smoke harness for the stale-comment panel state (attn-nnj.4.8).
//
// Pattern mirrors `AmbiguousAnchorPicker.test.ts` and `review/store.test.ts` —
// `web/` has no vitest config and runes only compile through the
// Vite+svelte pipeline, so we exercise the *contracts* that the
// `ReviewMarginCard` + `ReviewMargin` + `reviewStore` triple depends on:
//
//   1. `staleAnchors` selector surfaces a stale resolution exactly once
//      under the event id (and only the event id — no candidates).
//   2. The card's body for stale events derives its quote from the
//      original anchor's `quote.exact`. (We mirror the extraction
//      function the component uses; matching word-for-word.)
//   3. `enterManualReanchor` sets manualReanchorState; cancel clears it
//      WITHOUT emitting reviewResolveAnchor IPC.
//   4. `confirmManualReanchor` emits a reviewResolveAnchor IPC carrying
//      the user-built PositionAnchor + roomId + eventId and then clears.
//   5. `discardStaleCard` removes the event from the orphan-tray filter
//      set without emitting IPC.
//   6. A non-stale resolution arriving later naturally drops the entry
//      from `staleAnchors` (resolver round-trip is the success exit).
//   7. Entering reanchor on card A then card B replaces the in-flight
//      state (single-flight invariant).
//
// Run with:
//   cd web && npx tsx src/lib/ReviewMarginCardStale.test.ts

import { reviewResolveAnchor } from './ipc';
import { staleAnchors } from './review/selectors';
import type {
  EventId,
  PositionAnchor,
  ReviewAnchorResolutionUpdate,
  RoomId,
  Thread,
} from './types';

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
// IPC capture (mirror AmbiguousAnchorPicker.test.ts)
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
// In-test stand-in for the rune-backed reviewStore (mirrors the exact
// helper contracts from store.svelte.ts so the assertions exercise the
// same logic the real store applies). We can't import the real store
// because tsx can't evaluate `$state(...)` outside the Vite pipeline.
// ---------------------------------------------------------------------------

interface ManualReanchorState {
  eventId: EventId;
  roomId: RoomId;
}

interface StubStore {
  manualReanchorState: ManualReanchorState | null;
  discardedStale: Set<EventId>;
  enterManualReanchor(eventId: EventId, roomId: RoomId): void;
  confirmManualReanchor(positionAnchor: PositionAnchor): void;
  cancelManualReanchor(): void;
  discardStaleCard(eventId: EventId): void;
}

function makeStubStore(): StubStore {
  return {
    manualReanchorState: null,
    discardedStale: new Set<EventId>(),
    enterManualReanchor(eventId, roomId) {
      this.manualReanchorState = { eventId, roomId };
    },
    confirmManualReanchor(positionAnchor) {
      const state = this.manualReanchorState;
      if (!state) return;
      void reviewResolveAnchor(state.roomId, state.eventId, positionAnchor);
      this.manualReanchorState = null;
    },
    cancelManualReanchor() {
      this.manualReanchorState = null;
    },
    discardStaleCard(eventId) {
      if (this.discardedStale.has(eventId)) return;
      const next = new Set(this.discardedStale);
      next.add(eventId);
      this.discardedStale = next;
      if (this.manualReanchorState?.eventId === eventId) {
        this.manualReanchorState = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mirror of ReviewMarginCard.extractStaleQuote — single source of truth for
// the body shown when state === 'stale'.
// ---------------------------------------------------------------------------

function extractStaleQuote(t: Thread): string {
  const q = t.anchor?.quote?.exact ?? '';
  if (q.length <= 160) return q;
  return `${q.slice(0, 159)}…`;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRange(start: number, end: number): PositionAnchor {
  return {
    byteRange: [start, end],
    lineRange: [1, 1],
    pmRange: [start + 1, end + 1],
  };
}

function staleResolution(
  roomId: RoomId,
  eventId: EventId,
  reason = 'anchor_lost',
): ReviewAnchorResolutionUpdate {
  return {
    roomId,
    fileId: 'file-x',
    eventId,
    resolved: { status: 'stale', reason },
  };
}

function exactResolution(
  roomId: RoomId,
  eventId: EventId,
): ReviewAnchorResolutionUpdate {
  return {
    roomId,
    fileId: 'file-x',
    eventId,
    resolved: {
      status: 'exact',
      confidence: 1.0,
      currentRange: makeRange(0, 5),
      reason: 'base_hash_match',
    },
  };
}

function makeStaleThread(eventId: EventId, quoteExact: string): Thread {
  return {
    id: `t-${eventId}`,
    rootEvent: {
      meta: {
        v: 2,
        eventId,
        roomId: 'room-x',
        authorId: 'p-author',
        deviceId: 'd-x',
        createdAt: 1000,
        parentEventIds: [],
        snapshotId: 'snap-x',
      },
      body: {
        type: 'comment_created',
        threadId: `t-${eventId}`,
        anchor: {
          v: 2,
          fileId: 'file-x',
          snapshotId: 'snap-x',
          baseHash: 'hash-x',
          position: { byteRange: [0, 5], lineRange: [1, 1] },
          quote: {
            exact: quoteExact,
            exactHash: 'h-exact',
            normalized: quoteExact.toLowerCase(),
            normalizedHash: 'h-norm',
          },
        },
        body: 'a comment',
      },
      auth: { signature: 'sig', signingKeyId: 'kid' },
    },
    replies: [],
    resolved: false,
    anchor: {
      v: 2,
      fileId: 'file-x',
      snapshotId: 'snap-x',
      baseHash: 'hash-x',
      position: { byteRange: [0, 5], lineRange: [1, 1] },
      quote: {
        exact: quoteExact,
        exactHash: 'h-exact',
        normalized: quoteExact.toLowerCase(),
        normalizedHash: 'h-norm',
      },
    },
    resolvedAnchor: { status: 'stale', reason: 'anchor_lost' },
  };
}

// ---------------------------------------------------------------------------
// 1. staleAnchors selector surfaces the stale resolution
// ---------------------------------------------------------------------------

defineCase('staleAnchors: stale resolution surfaces as a single orphan row', () => {
  const eventId: EventId = 'evt-stale-1';
  const map: Record<string, ReviewAnchorResolutionUpdate> = {
    [eventId]: staleResolution('room-x', eventId),
  };
  const rows = staleAnchors(map);
  assert(rows.length === 1, `expected 1 stale row, got ${rows.length}`);
  assert(rows[0]!.eventId === eventId, `expected eventId=${eventId}, got ${rows[0]!.eventId}`);
  assert(rows[0]!.reason === 'anchor_lost', `expected reason=anchor_lost, got ${rows[0]!.reason}`);
});

// ---------------------------------------------------------------------------
// 2. Stale card body derives from the original anchor's quote
// ---------------------------------------------------------------------------

defineCase('stale card body: extractStaleQuote returns the anchor.quote.exact', () => {
  const t = makeStaleThread('evt-stale-quote', 'the quick brown fox');
  const got = extractStaleQuote(t);
  assert(got === 'the quick brown fox', `unexpected quote: ${got}`);
});

defineCase('stale card body: truncates quotes longer than 160 chars', () => {
  const long = 'x'.repeat(200);
  const t = makeStaleThread('evt-stale-long', long);
  const got = extractStaleQuote(t);
  assert(got.length === 160, `expected 160 chars (159+ellipsis), got ${got.length}`);
  assert(got.endsWith('…'), `expected ellipsis terminator, got "...${got.slice(-3)}"`);
});

defineCase('stale card body: empty quote degrades gracefully', () => {
  const t = makeStaleThread('evt-stale-noquote', '');
  const got = extractStaleQuote(t);
  assert(got === '', `expected empty string, got "${got}"`);
});

// ---------------------------------------------------------------------------
// 3. enterManualReanchor + cancelManualReanchor — no IPC on cancel
// ---------------------------------------------------------------------------

defineCase('enterManualReanchor: sets manualReanchorState', () => {
  ipc.reset();
  const store = makeStubStore();
  store.enterManualReanchor('evt-enter-1', 'room-x');
  assert(store.manualReanchorState !== null, 'expected manualReanchorState to be set');
  assert(
    store.manualReanchorState.eventId === 'evt-enter-1',
    `expected eventId=evt-enter-1, got ${store.manualReanchorState.eventId}`,
  );
  assert(
    store.manualReanchorState.roomId === 'room-x',
    `expected roomId=room-x, got ${store.manualReanchorState.roomId}`,
  );
  assert(ipc.messages.length === 0, `entering should not emit IPC, got ${ipc.messages.length}`);
});

defineCase('cancelManualReanchor: clears state without emitting IPC', () => {
  ipc.reset();
  const store = makeStubStore();
  store.enterManualReanchor('evt-cancel-1', 'room-x');
  store.cancelManualReanchor();
  assert(store.manualReanchorState === null, 'expected manualReanchorState to be null after cancel');
  assert(ipc.messages.length === 0, `cancel should not emit IPC, got ${ipc.messages.length}`);
});

// ---------------------------------------------------------------------------
// 4. confirmManualReanchor: emits IPC + clears state
// ---------------------------------------------------------------------------

defineCase('confirmManualReanchor: emits reviewResolveAnchor IPC + clears state', () => {
  ipc.reset();
  const store = makeStubStore();
  const eventId: EventId = 'evt-confirm-1';
  const roomId: RoomId = 'room-x';
  const newAnchor: PositionAnchor = makeRange(50, 70);

  store.enterManualReanchor(eventId, roomId);
  store.confirmManualReanchor(newAnchor);

  assert(store.manualReanchorState === null, 'expected manualReanchorState to be null after confirm');
  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as {
    type: string;
    roomId: RoomId;
    eventId: EventId;
    range: PositionAnchor;
  };
  assert(msg.type === 'review_resolve_anchor', `unexpected type=${msg.type}`);
  assert(msg.roomId === roomId, `roomId mismatch: got ${msg.roomId}`);
  assert(msg.eventId === eventId, `eventId mismatch: got ${msg.eventId}`);
  assert(
    msg.range.byteRange[0] === newAnchor.byteRange[0]
      && msg.range.byteRange[1] === newAnchor.byteRange[1],
    `byteRange mismatch: got [${msg.range.byteRange[0]}, ${msg.range.byteRange[1]}]`,
  );
});

defineCase('confirmManualReanchor: no-op when no card is in flight', () => {
  ipc.reset();
  const store = makeStubStore();
  store.confirmManualReanchor(makeRange(0, 5));
  assert(ipc.messages.length === 0, `confirm with no in-flight card should not emit, got ${ipc.messages.length}`);
});

// ---------------------------------------------------------------------------
// 5. discardStaleCard: removes from orphan-tray set, no IPC
// ---------------------------------------------------------------------------

defineCase('discardStaleCard: adds to discardedStale + does not emit IPC', () => {
  ipc.reset();
  const store = makeStubStore();
  const eventId: EventId = 'evt-discard-1';
  store.discardStaleCard(eventId);
  assert(store.discardedStale.has(eventId), 'expected eventId in discardedStale set');
  assert(ipc.messages.length === 0, `discard should not emit IPC, got ${ipc.messages.length}`);
});

defineCase('discardStaleCard: clears in-flight reanchor if same eventId', () => {
  ipc.reset();
  const store = makeStubStore();
  const eventId: EventId = 'evt-discard-clears';
  store.enterManualReanchor(eventId, 'room-x');
  assert(store.manualReanchorState !== null, 'pre: in-flight should be set');
  store.discardStaleCard(eventId);
  assert(
    store.manualReanchorState === null,
    'discard of in-flight card should also clear manualReanchorState',
  );
  assert(ipc.messages.length === 0, 'no IPC');
});

defineCase('discardStaleCard: leaves in-flight reanchor for a different card alone', () => {
  ipc.reset();
  const store = makeStubStore();
  store.enterManualReanchor('evt-A', 'room-x');
  store.discardStaleCard('evt-B');
  assert(
    store.manualReanchorState !== null
      && store.manualReanchorState.eventId === 'evt-A',
    'discarding evt-B must not affect in-flight reanchor on evt-A',
  );
});

// ---------------------------------------------------------------------------
// 6. Resolution event flow: stale → exact drops the entry from staleAnchors
// ---------------------------------------------------------------------------

defineCase('resolution flow: stale → exact removes the row from staleAnchors', () => {
  const eventId: EventId = 'evt-stale-flow';
  const map: Record<string, ReviewAnchorResolutionUpdate> = {
    [eventId]: staleResolution('room-x', eventId),
  };
  const before = staleAnchors(map);
  assert(before.length === 1, `expected 1 stale row before, got ${before.length}`);

  // Simulate the AnchorResolutionChanged round-trip after the user
  // confirmed a new anchor — the resolver writes an exact resolution.
  map[eventId] = exactResolution('room-x', eventId);
  const after = staleAnchors(map);
  assert(after.length === 0, `expected 0 stale rows after, got ${after.length}`);
});

// ---------------------------------------------------------------------------
// 7. Single-flight: entering reanchor on a second card replaces the first
// ---------------------------------------------------------------------------

defineCase('single-flight: entering reanchor on a second card replaces the first', () => {
  ipc.reset();
  const store = makeStubStore();
  // Defeat TS literal-narrowing on the asserts below by reading through a
  // getter (same dodge AmbiguousAnchorPicker.test.ts uses).
  const currentEventId = (): EventId | undefined => store.manualReanchorState?.eventId;

  store.enterManualReanchor('evt-first', 'room-x');
  assert(
    currentEventId() === 'evt-first',
    `expected first eventId in-flight, got ${String(currentEventId())}`,
  );
  store.enterManualReanchor('evt-second', 'room-x');
  assert(
    currentEventId() === 'evt-second',
    `expected second eventId in-flight after re-entry, got ${String(currentEventId())}`,
  );
  assert(ipc.messages.length === 0, 'switching cards should not emit IPC');
});

// ---------------------------------------------------------------------------
// 8. End-to-end: enter → confirm round-trips through reviewResolveAnchor
// with the *exact* user-supplied PositionAnchor (regression: ensures the
// store doesn't munge the byte/line/pm fields between enter and emit).
// ---------------------------------------------------------------------------

defineCase('end-to-end: PositionAnchor round-trips byteRange + lineRange + pmRange', () => {
  ipc.reset();
  const store = makeStubStore();
  const anchor: PositionAnchor = {
    byteRange: [100, 200],
    lineRange: [10, 20],
    pmRange: [105, 205],
  };
  store.enterManualReanchor('evt-rt', 'room-rt');
  store.confirmManualReanchor(anchor);

  assert(ipc.messages.length === 1, `expected 1 IPC, got ${ipc.messages.length}`);
  const msg = ipc.messages[0] as { range: PositionAnchor };
  assert(msg.range.byteRange[0] === 100 && msg.range.byteRange[1] === 200, 'byteRange round-trip');
  assert(msg.range.lineRange[0] === 10 && msg.range.lineRange[1] === 20, 'lineRange round-trip');
  assert(
    msg.range.pmRange?.[0] === 105 && msg.range.pmRange?.[1] === 205,
    'pmRange round-trip',
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
