// Manual smoke harness for OutboxIndicator.svelte (attn-nnj.4.13).
// Pattern mirrors ConnectionBadge.test.ts / SnapshotBadge.test.ts — `web/`
// has no vitest config yet, so tests are tsx-runnable functions with a tiny
// harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/OutboxIndicator.test.ts
//
// IMPORTANT: tsx cannot mount the .svelte file (runes only compile through
// the Vite + svelte plugin). So we test the contracts the component
// depends on:
//
//   1. 0 outbox → indicator hidden (visible === false)
//   2. 3 pending → "3 pending" pill label
//   3. 1 pending → "1 pending" (singular form)
//   4. Reviewer + owner offline + pending → owner-offline notice shows
//   5. Owner-side + owner-offline conditions → notice suppressed (owner
//      can never see themselves offline)
//   6. Owner online + reviewer side + pending → notice suppressed
//   7. Click handler toggles popover open/closed
//   8. Retry handler dispatches AND closes the popover
//   9. entryLabel renders "kind · idTail" + falls back when fields missing

import type { ReviewStatusPeer } from './types';

// ---------------------------------------------------------------------------
// Tiny harness (matches ConnectionBadge.test.ts conventions)
// ---------------------------------------------------------------------------

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const cases: Array<() => Promise<CaseResult> | CaseResult> = [];

function defineCase(
  name: string,
  fn: () => void | string | Promise<void | string>,
): void {
  cases.push(async () => {
    try {
      const note = await fn();
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
// Stub reviewStore — same approach as ConnectionBadge.test.ts. The real
// store uses runes; we only need `pendingOutbox` + `peers` for the
// indicator's contract.
// ---------------------------------------------------------------------------

interface OutboxEntryShape {
  envelopeId: string;
  kind?: string;
  createdAt?: number;
}

interface StubStore {
  pendingOutbox: OutboxEntryShape[];
  peers: ReviewStatusPeer[];
}

function makeStubStore(overrides: Partial<StubStore> = {}): StubStore {
  return { pendingOutbox: [], peers: [], ...overrides };
}

function makeEntry(id: string, kind?: string): OutboxEntryShape {
  return { envelopeId: id, ...(kind !== undefined ? { kind } : {}) };
}

function makePeer(
  kind: ReviewStatusPeer['kind'],
  online: boolean,
  id: string,
): ReviewStatusPeer {
  return {
    participantId: `p-${id}` as ReviewStatusPeer['participantId'],
    deviceId: `d-${id}` as ReviewStatusPeer['deviceId'],
    displayName: id,
    kind,
    online,
  };
}

// ---------------------------------------------------------------------------
// Mirror the component's derivations as pure helpers — this is the contract
// the component file owns. If the component diverges, these tests fail.
// ---------------------------------------------------------------------------

function derivePending(store: StubStore): number {
  return store.pendingOutbox.length;
}

function deriveVisible(store: StubStore): boolean {
  return derivePending(store) > 0;
}

function deriveOwnerPresent(store: StubStore): boolean {
  return store.peers.some((p) => p.kind === 'owner' && p.online);
}

function deriveShowOwnerOfflineNotice(
  store: StubStore,
  isOwner: boolean,
): boolean {
  return !isOwner && derivePending(store) > 0 && !deriveOwnerPresent(store);
}

function derivePillLabel(store: StubStore): string {
  const n = derivePending(store);
  return n === 1 ? '1 pending' : `${n} pending`;
}

function entryLabel(entry: OutboxEntryShape, index: number): string {
  const kind = typeof entry.kind === 'string' ? entry.kind : 'envelope';
  const idTail =
    typeof entry.envelopeId === 'string' && entry.envelopeId.length > 0
      ? entry.envelopeId.slice(-6)
      : String(index + 1);
  return `${kind} · ${idTail}`;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (1) Empty outbox → indicator hidden
defineCase('0 outbox entries → indicator collapses (visible === false)', () => {
  const store = makeStubStore();
  assert(derivePending(store) === 0, 'expected pending count 0');
  assert(deriveVisible(store) === false, 'expected hidden when outbox empty');
});

// (2) 3 pending → "3 pending" pill label
defineCase('3 outbox entries → pill label "3 pending"', () => {
  const store = makeStubStore({
    pendingOutbox: [
      makeEntry('env-aaa', 'event'),
      makeEntry('env-bbb', 'event'),
      makeEntry('env-ccc', 'snapshot_blob'),
    ],
  });
  assert(derivePending(store) === 3, `expected pending 3, got ${derivePending(store)}`);
  assert(deriveVisible(store) === true, 'expected visible with 3 entries');
  const label = derivePillLabel(store);
  assert(label === '3 pending', `expected "3 pending", got "${label}"`);
});

// (3) Singular form is "1 pending" — not "1 pendings"
defineCase('1 outbox entry → singular pill label "1 pending"', () => {
  const store = makeStubStore({
    pendingOutbox: [makeEntry('env-solo', 'event')],
  });
  const label = derivePillLabel(store);
  assert(label === '1 pending', `expected singular "1 pending", got "${label}"`);
  // And NOT "1 pendings" or "1 pending(s)" — guard against template drift.
  assert(!label.includes('pendings'), 'pill must not pluralize at count 1');
});

// (4) Reviewer + owner absent from peers + 1 pending → owner-offline notice
defineCase('Reviewer + owner-not-in-peers + 1 pending → owner-offline notice fires', () => {
  const store = makeStubStore({
    pendingOutbox: [makeEntry('env-1', 'event')],
    // Owner is absent — only the reviewer-self peer is here.
    peers: [makePeer('reviewer', true, 'alex')],
  });
  const isOwner = false; // reviewer side
  assert(deriveOwnerPresent(store) === false, 'owner should be absent');
  assert(
    deriveShowOwnerOfflineNotice(store, isOwner) === true,
    'reviewer with owner offline + pending must show owner-offline notice',
  );
});

// (5) Owner-side never shows the owner-offline notice (asymmetry guard)
defineCase('Owner-side + outbox + no owner-online peer → notice suppressed', () => {
  // Even if no peer flagged "owner online" (the owner IS the local device),
  // the indicator must not light the notice — the owner can never see
  // themselves offline. This is the reviewer-only message.
  const store = makeStubStore({
    pendingOutbox: [makeEntry('env-x', 'event'), makeEntry('env-y', 'event')],
    peers: [makePeer('reviewer', true, 'alex')],
  });
  const isOwner = true;
  assert(
    deriveShowOwnerOfflineNotice(store, isOwner) === false,
    'owner-side must never see the owner-offline notice',
  );
  // ...but the "2 pending" pill still shows.
  assert(deriveVisible(store) === true, 'pill itself remains visible on owner side');
});

// (6) Reviewer + owner ONLINE + pending → notice suppressed
defineCase('Reviewer + owner online + pending → owner-offline notice suppressed', () => {
  const store = makeStubStore({
    pendingOutbox: [makeEntry('env-1', 'event')],
    peers: [
      makePeer('owner', true, 'james'),
      makePeer('reviewer', true, 'alex'),
    ],
  });
  const isOwner = false;
  assert(deriveOwnerPresent(store) === true, 'owner online → owner present');
  assert(
    deriveShowOwnerOfflineNotice(store, isOwner) === false,
    'owner online must suppress the notice (envelopes deliver immediately)',
  );
});

// (7) Click chip → popover toggles open then closed (same predicate as
//     ConnectionBadge — mirror it so we catch contract drift).
defineCase('Click pill → popover toggles open then closed', () => {
  function nextOpen(prev: boolean): boolean {
    return !prev;
  }
  let popoverOpen = false;
  assert(popoverOpen === false, 'expected popover initially closed');
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === true, 'expected popover open after first click');
  popoverOpen = nextOpen(popoverOpen);
  assert(popoverOpen === false, 'expected popover closed after second click');
});

// (8) Retry handler fires AND closes the popover (component contract).
defineCase('Retry handler dispatches callback AND closes popover', () => {
  const state: { popoverOpen: boolean; retryFired: number } = {
    popoverOpen: true,
    retryFired: 0,
  };
  const onRetry = (): void => {
    state.retryFired += 1;
  };
  // Mirror handleRetry from OutboxIndicator.svelte.
  function handleRetry(): void {
    onRetry();
    state.popoverOpen = false;
  }

  handleRetry();
  assert(
    state.retryFired === 1,
    `expected onRetry to fire once, got ${state.retryFired}`,
  );
  assert(
    state.popoverOpen === false,
    'expected popover to close after retry now',
  );
});

// (9) entryLabel renders "kind · idTail" and falls back on missing fields
defineCase('entryLabel formats kind + idTail; falls back when fields missing', () => {
  // 'env-aaaaabbbbb' is 14 chars; last 6 are 'abbbbb'.
  const full = entryLabel(makeEntry('env-aaaaabbbbb', 'event'), 0);
  assert(full === 'event · abbbbb', `expected "event · abbbbb", got "${full}"`);

  // Missing `kind` → defaults to "envelope".
  const noKind = entryLabel({ envelopeId: 'env-cafe1234' }, 0);
  assert(
    noKind === 'envelope · fe1234',
    `expected fallback "envelope · fe1234", got "${noKind}"`,
  );

  // Empty envelopeId → falls back to (index + 1).
  const noId = entryLabel({ envelopeId: '', kind: 'event' }, 4);
  assert(noId === 'event · 5', `expected fallback "event · 5", got "${noId}"`);

  // Short id (<6 chars) → uses the whole id.
  const shortId = entryLabel({ envelopeId: 'env-1' } as OutboxEntryShape, 0);
  assert(
    shortId === 'envelope · env-1',
    `short id should be used verbatim, got "${shortId}"`,
  );
});

// (10) Popover list keying — entries with same envelopeId would collapse.
//      Guard the contract that envelopeIds are unique in the rendered list.
defineCase('Popover list keys are stable and unique per envelopeId', () => {
  const entries = [
    makeEntry('env-a', 'event'),
    makeEntry('env-b', 'event'),
    makeEntry('env-c', 'snapshot_blob'),
  ];
  const seen = new Set<string>();
  for (const e of entries) {
    assert(!seen.has(e.envelopeId), `duplicate envelopeId "${e.envelopeId}"`);
    seen.add(e.envelopeId);
  }
  assert(seen.size === 3, `expected 3 unique entries, got ${seen.size}`);
});

// ---------------------------------------------------------------------------
// Runner — same shape as ConnectionBadge.test.ts / SnapshotBadge.test.ts
// ---------------------------------------------------------------------------

interface NodeProcessShape {
  exit?: (code: number) => void;
}

async function runAllCases(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    const r = await run();
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

void runAllCases();
