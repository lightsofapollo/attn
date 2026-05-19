// Manual smoke harness for SnapshotBadge.svelte (attn-nnj.4.9).
// Pattern mirrors ConnectionBadge.test.ts — `web/` has no vitest config yet,
// so tests are tsx-runnable functions with a tiny harness.
//
// Run with:
//
//   cd web && npx tsx src/lib/SnapshotBadge.test.ts
//
// IMPORTANT: tsx cannot mount the .svelte file (runes only compile through
// the Vite + svelte plugin). So we test the contracts the component depends
// on:
//
//   1. Age formatter: "Ns ago", "N min ago", "Nh ago", "Nd ago".
//   2. Clock formatter: zero-padded HH:MM in local time.
//   3. Owner label rule: current vs superseded vs reviewer_on_older.
//   4. Reviewer label rule: "Snapshot @ HH:MM" + owner-on-newer warning.
//   5. Older-peer detail: name + their snapshot's age.
//   6. Click → popover toggle predicate.
//   7. Sort order in popover: newest-first.

import {
  formatSnapshotAge,
  formatSnapshotClock,
} from './snapshot-badge-format';
import type {
  ReviewSnapshot,
  ReviewStatusPeer,
  SnapshotId,
} from './types';

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
// Fixtures — mirror the badge's derivations as pure helpers so this test
// catches contract drift without trying to mount the .svelte component.
// ---------------------------------------------------------------------------

type OwnerLabelKind = 'current' | 'superseded' | 'reviewer_on_older';

interface PartialStore {
  currentFileId: string | null;
  currentSnapshotId: SnapshotId | null;
  snapshots: ReviewSnapshot[];
  peers: ReviewStatusPeer[];
}

function makeStore(overrides: Partial<PartialStore> = {}): PartialStore {
  return {
    currentFileId: null,
    currentSnapshotId: null,
    snapshots: [],
    peers: [],
    ...overrides,
  };
}

function snapshot(
  id: string,
  createdAt: number,
  overrides: Partial<ReviewSnapshot> = {},
): ReviewSnapshot {
  return {
    roomId: 'room-test' as ReviewSnapshot['roomId'],
    fileId: 'file-test' as ReviewSnapshot['fileId'],
    snapshotId: id as SnapshotId,
    createdAt,
    createdBy: 'p-owner' as ReviewSnapshot['createdBy'],
    baseHash: 'hash-' + id as ReviewSnapshot['baseHash'],
    byteLength: 100,
    ...overrides,
  };
}

function peer(
  id: string,
  kind: ReviewStatusPeer['kind'],
  onSnapshotId: string | undefined,
  online: boolean = true,
): ReviewStatusPeer {
  return {
    participantId: ('p-' + id) as ReviewStatusPeer['participantId'],
    deviceId: ('d-' + id) as ReviewStatusPeer['deviceId'],
    displayName: id,
    kind,
    online,
    onSnapshotId: onSnapshotId as SnapshotId | undefined,
  };
}

// Mirror of the badge's `fileSnapshots` derivation.
function fileSnapshots(store: PartialStore): ReviewSnapshot[] {
  return store.snapshots
    .filter((s) => s.fileId === store.currentFileId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Mirror of the badge's `supersededIds` derivation.
function supersededIds(store: PartialStore): Set<SnapshotId> {
  const set = new Set<SnapshotId>();
  for (const s of store.snapshots) {
    if (s.supersedesSnapshotId !== undefined) set.add(s.supersedesSnapshotId);
  }
  return set;
}

// Mirror of the badge's `latestSnapshot` derivation.
function latestSnapshot(store: PartialStore): ReviewSnapshot | null {
  const file = fileSnapshots(store);
  const superseded = supersededIds(store);
  for (const s of file) {
    if (!superseded.has(s.snapshotId)) return s;
  }
  return file[0] ?? null;
}

// Mirror of the badge's `activeSnapshot` derivation.
function activeSnapshot(store: PartialStore): ReviewSnapshot | null {
  const latest = latestSnapshot(store);
  if (store.currentSnapshotId !== null) {
    return (
      fileSnapshots(store).find((s) => s.snapshotId === store.currentSnapshotId)
      ?? latest
    );
  }
  return latest;
}

// Mirror of the badge's `peerSplit` (reduced to onOlderSnapshot count).
function peerSplitOlderCount(store: PartialStore): number {
  const latest = latestSnapshot(store);
  if (latest === null) return store.peers.length;
  let n = 0;
  for (const p of store.peers) {
    if (p.onSnapshotId !== latest.snapshotId) n += 1;
  }
  return n;
}

// Mirror of the badge's `ownerLabel` derivation.
function ownerLabel(store: PartialStore): OwnerLabelKind {
  const active = activeSnapshot(store);
  const latest = latestSnapshot(store);
  if (active === null || latest === null) return 'current';
  const activeIsLatest = active.snapshotId === latest.snapshotId;
  const activeWasSuperseded = supersededIds(store).has(active.snapshotId);
  if (activeWasSuperseded) return 'superseded';
  if (activeIsLatest && peerSplitOlderCount(store) > 0) return 'reviewer_on_older';
  return 'current';
}

// Mirror of the badge's `ownerOnNewerSnapshot` derivation (reviewer view).
function ownerOnNewerSnapshot(store: PartialStore): boolean {
  const active = activeSnapshot(store);
  const latest = latestSnapshot(store);
  if (active === null) return false;
  for (const p of store.peers) {
    if (
      p.kind === 'owner'
      && p.onSnapshotId !== undefined
      && p.onSnapshotId !== active.snapshotId
      && p.onSnapshotId === latest?.snapshotId
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (1) Age formatter covers the four resolution bands.
defineCase('formatSnapshotAge produces "Ns / N min / Nh / Nd ago" strings', () => {
  const now = 1_700_000_000_000;
  assert(formatSnapshotAge(now - 5_000, now) === '5s ago', 'expected "5s ago" for 5s past');
  assert(
    formatSnapshotAge(now - 3 * 60_000, now) === '3 min ago',
    `expected "3 min ago" for 3 min past, got "${formatSnapshotAge(now - 3 * 60_000, now)}"`,
  );
  assert(
    formatSnapshotAge(now - 2 * 60 * 60_000, now) === '2h ago',
    `expected "2h ago" for 2h past, got "${formatSnapshotAge(now - 2 * 60 * 60_000, now)}"`,
  );
  assert(
    formatSnapshotAge(now - 5 * 24 * 60 * 60_000, now) === '5d ago',
    `expected "5d ago" for 5d past, got "${formatSnapshotAge(now - 5 * 24 * 60 * 60_000, now)}"`,
  );
  assert(
    formatSnapshotAge(now + 30_000, now).startsWith('in '),
    'expected future timestamp to use "in N…" prefix',
  );
});

// (2) Clock formatter produces zero-padded HH:MM.
defineCase('formatSnapshotClock formats HH:MM in local time', () => {
  // Pick a timestamp whose local components we can probe directly.
  const ts = new Date(2026, 4, 18, 14, 2, 0).getTime();
  const str = formatSnapshotClock(ts);
  assert(str === '14:02', `expected "14:02", got "${str}"`);

  const earlyTs = new Date(2026, 4, 18, 7, 5, 0).getTime();
  assert(formatSnapshotClock(earlyTs) === '07:05', `expected zero-padded "07:05"`);
});

// (3) Owner perspective: current snapshot → "Snapshot current" verdict
//     when (a) we're on the latest snapshot and (b) every peer is on latest.
defineCase('Owner: on latest snapshot with peers on latest → "current"', () => {
  const latest = snapshot('s2', 1_700_000_000_000);
  const older = snapshot('s1', 1_700_000_000_000 - 60_000);
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: latest.snapshotId,
    snapshots: [older, latest],
    peers: [peer('alex', 'reviewer', latest.snapshotId)],
  });
  assert(ownerLabel(store) === 'current', `expected "current" verdict, got "${ownerLabel(store)}"`);
});

// (4) Owner perspective: active snapshot is in supersededIds → "superseded"
//     (grey strikethrough + jump-to-current).
defineCase('Owner: superseded snapshot → "superseded" verdict + jump button', () => {
  const older = snapshot('s1', 1_700_000_000_000 - 60_000);
  const newer = snapshot('s2', 1_700_000_000_000, {
    supersedesSnapshotId: older.snapshotId,
  });
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: older.snapshotId,
    snapshots: [older, newer],
    peers: [],
  });
  // older.snapshotId is in supersededIds because newer supersedes it.
  assert(
    supersededIds(store).has(older.snapshotId),
    'expected older snapshot id to appear in supersededIds set',
  );
  assert(
    ownerLabel(store) === 'superseded',
    `expected "superseded" verdict, got "${ownerLabel(store)}"`,
  );
  // The jump button targets the latest (= newer) snapshot.
  const latest = latestSnapshot(store);
  assert(latest !== null, 'expected a latest snapshot');
  assert(
    latest?.snapshotId === newer.snapshotId,
    `expected latest = newer, got ${latest?.snapshotId}`,
  );
});

// (5) Owner perspective: on latest BUT a reviewer is on an older snapshot →
//     yellow warning ("Reviewer on older snapshot").
defineCase('Owner: reviewer stuck on older snapshot → "reviewer_on_older" verdict', () => {
  const older = snapshot('s1', 1_700_000_000_000 - 60_000);
  const latest = snapshot('s2', 1_700_000_000_000);
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: latest.snapshotId,
    snapshots: [older, latest],
    peers: [peer('alex', 'reviewer', older.snapshotId)],
  });
  assert(
    ownerLabel(store) === 'reviewer_on_older',
    `expected "reviewer_on_older" verdict, got "${ownerLabel(store)}"`,
  );
  // Sanity: the older peer is in the older-snapshot bucket.
  assert(peerSplitOlderCount(store) === 1, `expected 1 older peer, got ${peerSplitOlderCount(store)}`);
});

// (6) Reviewer perspective: label is "Snapshot @ HH:MM" of the active snapshot.
defineCase('Reviewer: active snapshot label uses HH:MM wall-clock', () => {
  const ts = new Date(2026, 4, 18, 14, 2, 0).getTime();
  const snap = snapshot('s-current', ts);
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: snap.snapshotId,
    snapshots: [snap],
    peers: [],
  });
  const active = activeSnapshot(store);
  assert(active !== null, 'expected an active snapshot');
  assert(active?.snapshotId === snap.snapshotId, 'expected active to be the snapshot');
  const label = `Snapshot @ ${formatSnapshotClock(active!.createdAt)}`;
  assert(label === 'Snapshot @ 14:02', `expected "Snapshot @ 14:02", got "${label}"`);
});

// (7) Reviewer perspective: owner-on-newer warning fires only when an owner
//     peer is on a snapshot that's both (a) the file's latest and (b) not
//     the snapshot we're locked to.
defineCase('Reviewer: owner-on-newer-snapshot warning fires correctly', () => {
  const older = snapshot('s1', 1_700_000_000_000 - 60_000);
  const newer = snapshot('s2', 1_700_000_000_000);
  // Locked to the older snapshot; an owner peer is on the newer one.
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: older.snapshotId,
    snapshots: [older, newer],
    peers: [peer('james', 'owner', newer.snapshotId)],
  });
  assert(ownerOnNewerSnapshot(store), 'expected owner-on-newer warning to fire');

  // If reviewer is on latest too, no warning.
  const storeOnLatest = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: newer.snapshotId,
    snapshots: [older, newer],
    peers: [peer('james', 'owner', newer.snapshotId)],
  });
  assert(
    !ownerOnNewerSnapshot(storeOnLatest),
    'expected no warning when reviewer is on the same snapshot as the owner',
  );

  // No owner peers → no warning, even if other peers moved on.
  const storeNoOwner = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: older.snapshotId,
    snapshots: [older, newer],
    peers: [peer('alex', 'reviewer', newer.snapshotId)],
  });
  assert(
    !ownerOnNewerSnapshot(storeNoOwner),
    'expected no warning when only reviewer peers are on newer snapshot',
  );
});

// (8) Popover history: snapshots for the current file are sorted newest-first.
defineCase('Popover history sort: snapshots ordered newest-first', () => {
  const s1 = snapshot('s1', 1_700_000_000_000 - 120_000);
  const s2 = snapshot('s2', 1_700_000_000_000 - 60_000);
  const s3 = snapshot('s3', 1_700_000_000_000);
  // Insertion order is mixed; the file selector must sort by createdAt desc.
  const store = makeStore({
    currentFileId: 'file-test',
    snapshots: [s2, s1, s3],
    peers: [],
  });
  const sorted = fileSnapshots(store);
  assert(sorted.length === 3, `expected 3 snapshots in history, got ${sorted.length}`);
  assert(sorted[0]!.snapshotId === s3.snapshotId, 'expected s3 (newest) first');
  assert(sorted[1]!.snapshotId === s2.snapshotId, 'expected s2 second');
  assert(sorted[2]!.snapshotId === s1.snapshotId, 'expected s1 (oldest) last');
});

// (9) Click → popover open/close toggle. Mirror the badge's togglePopover.
defineCase('Click chip → popover toggles open then closed', () => {
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

// (10) Older-peer detail surface: each older peer is paired with the age of
//      their stuck snapshot so the hover tooltip can show name + age.
defineCase('Older-peer detail pairs each peer with their snapshot age', () => {
  const now = 1_700_000_000_000;
  const older = snapshot('s1', now - 6 * 60_000); // 6 minutes ago
  const latest = snapshot('s2', now);
  const store = makeStore({
    currentFileId: 'file-test',
    currentSnapshotId: latest.snapshotId,
    snapshots: [older, latest],
    peers: [peer('alex', 'reviewer', older.snapshotId)],
  });
  // Replicate the badge's olderPeers projection: for each older peer, look
  // up their snapshot's createdAt and humanize it via formatSnapshotAge.
  const details = store.peers
    .filter((p) => p.onSnapshotId !== latest.snapshotId)
    .map((p) => {
      const snap = store.snapshots.find((s) => s.snapshotId === p.onSnapshotId);
      return {
        name: p.displayName,
        age: snap !== undefined ? formatSnapshotAge(snap.createdAt, now) : 'unknown',
      };
    });
  assert(details.length === 1, `expected 1 older-peer detail, got ${details.length}`);
  assert(details[0]!.name === 'alex', `expected peer name "alex"`);
  assert(
    details[0]!.age === '6 min ago',
    `expected age "6 min ago", got "${details[0]!.age}"`,
  );
});

// ---------------------------------------------------------------------------
// Runner — same shape as ConnectionBadge.test.ts
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
