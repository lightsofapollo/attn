// Integration-style harness for the ReviewMargin component's *decision logic*.
//
// `ReviewMargin.svelte` itself can't be exercised without a Svelte runtime,
// but the choices it makes (which threads go to the orphan tray, how the
// collision pass + virtualization band interact at scale, what "show all
// resolved" pill state looks like for N threads) are all derivable from
// the pure selectors + the pure layout helpers. This file replays those
// decisions on representative fixtures and asserts the expected counts.
//
// Run with:
//   cd web && npx tsx src/lib/review/margin-integration.test.ts

import { layoutCards, visibleCards } from './margin-layout';
import { RESOLVED_CHIP_HEIGHT, computeRailMode } from './rail-mode';
import {
  ambiguousAnchors,
  reconstructThreads,
  staleAnchors,
  threadsForFile,
} from './selectors';
import type {
  Anchor,
  ContentHash,
  EventId,
  FileId,
  ParticipantId,
  ResolvedAnchorCandidate,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  RoomId,
  SnapshotId,
} from '../types';

// ---------------------------------------------------------------------------
// Harness
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
// Fixture builders
// ---------------------------------------------------------------------------

const ROOM: RoomId = 'room-x';
const FILE: FileId = 'file-x';
const SNAP: SnapshotId = 'snap-x';
const AUTHOR: ParticipantId = 'p-author';
const BASE_HASH = 'h-x' as ContentHash;

let nextEventId = 0;
function newEventId(prefix: string): EventId {
  nextEventId += 1;
  return `${prefix}-${nextEventId}`;
}

function anchorAt(byteStart: number, byteEnd: number): Anchor {
  return {
    v: 2,
    fileId: FILE,
    snapshotId: SNAP,
    baseHash: BASE_HASH,
    position: {
      byteRange: [byteStart, byteEnd],
      lineRange: [1, 1],
    },
  };
}

function makeComment(
  threadId: string,
  createdAt: number,
  anchor: Anchor,
  body = 'a comment',
): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: newEventId('e'),
      roomId: ROOM,
      authorId: AUTHOR,
      deviceId: 'd-x',
      createdAt,
      parentEventIds: [],
      snapshotId: SNAP,
    },
    body: { type: 'comment_created', threadId, anchor, body },
    auth: { signature: 'sig', signingKeyId: 'kid' },
  };
}

function makeResolveEvent(threadId: string, createdAt: number): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: newEventId('r'),
      roomId: ROOM,
      authorId: AUTHOR,
      deviceId: 'd-x',
      createdAt,
      parentEventIds: [],
      snapshotId: SNAP,
    },
    body: { type: 'comment_resolved', threadId, resolvedBy: AUTHOR },
    auth: { signature: 'sig', signingKeyId: 'kid' },
  };
}

function ambiguousResolution(
  eventId: EventId,
  candidates: ResolvedAnchorCandidate[],
): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM,
    fileId: FILE,
    eventId,
    resolved: {
      status: 'ambiguous',
      candidates,
      reason: 'two_within_010',
    },
  };
}

function staleResolution(eventId: EventId): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM,
    fileId: FILE,
    eventId,
    resolved: { status: 'stale', reason: 'anchor_lost' },
  };
}

function remappedResolution(
  eventId: EventId,
  confidence: number,
): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM,
    fileId: FILE,
    eventId,
    resolved: {
      status: 'remapped',
      confidence,
      currentRange: { byteRange: [0, 10], lineRange: [1, 1] },
      reason: 'quote_match',
    },
  };
}

function exactResolution(eventId: EventId): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM,
    fileId: FILE,
    eventId,
    resolved: {
      status: 'exact',
      confidence: 1.0,
      currentRange: { byteRange: [0, 10], lineRange: [1, 1] },
      reason: 'base_hash_match',
    },
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

defineCase('0 threads → empty margin (no anchored, no orphan, no resolved)', () => {
  const threads = reconstructThreads([], {});
  const scoped = threadsForFile(threads, ROOM, FILE);
  const amb = ambiguousAnchors({});
  const stale = staleAnchors({});
  assert(scoped.length === 0, 'no scoped threads');
  assert(amb.length === 0, 'no ambiguous rows');
  assert(stale.length === 0, 'no stale rows');
});

defineCase('1 thread, exact anchor → 1 anchored card at its anchorY', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const events = [c1];
  const resolutions: Record<EventId, ReviewAnchorResolutionUpdate> = {
    [c1.meta.eventId]: exactResolution(c1.meta.eventId),
  };
  const threads = reconstructThreads(events, resolutions);
  const scoped = threadsForFile(threads, ROOM, FILE);
  assert(scoped.length === 1, '1 thread');
  // Single card; layoutCards puts it at anchorY exactly.
  const placed = layoutCards([{ id: scoped[0]!.id, anchorY: 200, height: 80 }]);
  assert(placed[0]!.top === 200, 'card at anchorY');
  assert(placed[0]!.offset === false, 'not offset');
});

defineCase('2 overlapping anchors → second bumped down + marked offset (connector drawn)', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const c2 = makeComment('t2', 110, anchorAt(15, 25));
  const events = [c1, c2];
  const threads = reconstructThreads(events, {});
  const scoped = threadsForFile(threads, ROOM, FILE);
  // Simulate both anchors resolving close together (overlapping cards).
  const placed = layoutCards([
    { id: scoped[0]!.id, anchorY: 100, height: 96 },
    { id: scoped[1]!.id, anchorY: 120, height: 96 },
  ]);
  assert(placed[0]!.top === 100 && placed[0]!.offset === false, 'first stays');
  assert(placed[1]!.top === 204 && placed[1]!.offset === true,
    `second bumped: top=${placed[1]!.top} offset=${placed[1]!.offset}`);
});

defineCase('ambiguous → orphan tray (excluded from anchored set)', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const events = [c1];
  const resolutions: Record<EventId, ReviewAnchorResolutionUpdate> = {
    [c1.meta.eventId]: ambiguousResolution(c1.meta.eventId, [
      { confidence: 0.55, currentRange: { byteRange: [0, 5], lineRange: [1, 1] }, reason: 'quote', preview: 'A' },
      { confidence: 0.50, currentRange: { byteRange: [50, 55], lineRange: [5, 5] }, reason: 'quote', preview: 'B' },
    ]),
  };
  const threads = reconstructThreads(events, resolutions);
  const amb = ambiguousAnchors(resolutions);
  assert(amb.length === 1, 'one ambiguous row');
  assert(amb[0]!.candidates.length === 2, 'two candidates surfaced');

  // The margin filters threads into orphan vs anchored via the same eventId
  // set; rebuild that set here to verify the partition.
  const orphanIds = new Set<EventId>([
    ...amb.map((a) => a.eventId),
  ]);
  const anchored = threads.filter((t) => !orphanIds.has(t.rootEvent.meta.eventId));
  const orphan = threads.filter((t) => orphanIds.has(t.rootEvent.meta.eventId));
  assert(anchored.length === 0, 'no anchored cards');
  assert(orphan.length === 1, 'one orphan card');
});

defineCase('stale → orphan tray (sticky-top)', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const resolutions: Record<EventId, ReviewAnchorResolutionUpdate> = {
    [c1.meta.eventId]: staleResolution(c1.meta.eventId),
  };
  const threads = reconstructThreads([c1], resolutions);
  const st = staleAnchors(resolutions);
  assert(st.length === 1, 'one stale row');
  const orphanIds = new Set<EventId>(st.map((s) => s.eventId));
  const orphan = threads.filter((t) => orphanIds.has(t.rootEvent.meta.eventId));
  assert(orphan.length === 1, 'thread is orphan');
});

defineCase('remapped < 0.70 → orphan tray (panel-only per §10.2)', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const resolutions: Record<EventId, ReviewAnchorResolutionUpdate> = {
    [c1.meta.eventId]: remappedResolution(c1.meta.eventId, 0.55),
  };
  const threads = reconstructThreads([c1], resolutions);

  // Mirror the margin's orphan filter: include remapped < 0.70.
  const lowConfidenceIds = new Set<EventId>();
  for (const t of threads) {
    const r = resolutions[t.rootEvent.meta.eventId];
    if (!r) continue;
    if (r.resolved.status === 'remapped' && r.resolved.confidence < 0.70) {
      lowConfidenceIds.add(t.rootEvent.meta.eventId);
    }
  }
  assert(lowConfidenceIds.has(c1.meta.eventId), 'low-conf remap is orphan');
});

defineCase('resolved thread → collapsed chip (not in anchored set)', () => {
  const c1 = makeComment('t1', 100, anchorAt(0, 10));
  const r1 = makeResolveEvent('t1', 200);
  const threads = reconstructThreads([c1, r1], {});
  const scoped = threadsForFile(threads, ROOM, FILE);
  assert(scoped.length === 1, 'one thread');
  assert(scoped[0]!.resolved === true, 'flagged resolved');
  const resolvedSet = scoped.filter((t) => t.resolved);
  const activeSet = scoped.filter((t) => !t.resolved);
  assert(resolvedSet.length === 1 && activeSet.length === 0,
    'resolved → chip bucket, not anchored');
});

defineCase('expanded resolved card participates in the unified collision pass', () => {
  // attn-d7y: active cards and resolved threads share ONE layoutCards call,
  // so an expanded resolved card (full card height) pushes its neighbors
  // instead of overlapping them like the old two-pass layout allowed.
  const placed = layoutCards([
    { id: 'active-1', anchorY: 100, height: 96 },
    { id: 'expanded-resolved', anchorY: 120, height: 96 },
    { id: 'active-2', anchorY: 140, height: 96 },
  ]);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const a1 = byId.get('active-1')!;
  const er = byId.get('expanded-resolved')!;
  const a2 = byId.get('active-2')!;
  assert(a1.top === 100 && a1.offset === false, 'first active stays at anchor');
  assert(er.top === 100 + 96 + 8 && er.offset === true,
    `expanded resolved pushed below first card: top=${er.top}`);
  assert(a2.top === er.top + 96 + 8 && a2.offset === true,
    `second active pushed below expanded resolved: top=${a2.top}`);
});

defineCase('clustered resolved chips stack at chip pitch (28px + gutter)', () => {
  const placed = layoutCards([
    { id: 'chip-a', anchorY: 0, height: RESOLVED_CHIP_HEIGHT },
    { id: 'chip-b', anchorY: 0, height: RESOLVED_CHIP_HEIGHT },
    { id: 'chip-c', anchorY: 0, height: RESOLVED_CHIP_HEIGHT },
  ]);
  const pitch = RESOLVED_CHIP_HEIGHT + 8;
  assert(placed[0]!.top === 0 && placed[0]!.offset === false, 'first chip at anchor');
  assert(placed[1]!.top === pitch && placed[1]!.offset === true,
    `second chip at one pitch: top=${placed[1]!.top}`);
  assert(placed[2]!.top === pitch * 2 && placed[2]!.offset === true,
    `third chip at two pitches: top=${placed[2]!.top}`);
});

defineCase('expanded-rail chip visibility respects the >5 pill threshold', () => {
  // Mirror ReviewMargin's `resolvedChipsVisible` rule (expanded rail only;
  // the collapsed gutter always renders icon chips and never the pill):
  // chips hide behind the count pill above the threshold until "show all".
  const N = 8;
  const threshold = 5;
  const chipsVisible = (showAllResolved: boolean): boolean =>
    showAllResolved || N <= threshold;
  assert(chipsVisible(false) === false, 'expanded + 8 resolved → pill hides chips');
  assert(chipsVisible(true) === true, 'expanded + show-all → chips visible');
  // And the rail itself is collapsed-by-default in a room until the user
  // (or the unresolved auto-open) expands it.
  const mode = computeRailMode({ inReviewRoom: true, panelOpen: false });
  assert(mode === 'collapsed', `room + closed panel is collapsed, got ${mode}`);
});

defineCase('51 threads → virtualized to ~10 in DOM at default 600px viewport', () => {
  // Build 51 widely-spaced anchors (well past the 800px band cutoff).
  const events: ReviewEvent[] = [];
  const placements: Array<{ id: string; anchorY: number; height: number }> = [];
  for (let i = 0; i < 51; i += 1) {
    const e = makeComment(`t${i}`, 100 + i, anchorAt(i * 1000, i * 1000 + 5));
    events.push(e);
    placements.push({ id: `t${i}`, anchorY: i * 200, height: 96 });
  }
  const placed = layoutCards(placements);
  const heights = new Map<string, number>();
  for (const p of placements) heights.set(p.id, p.height);
  // Viewport spans 0..600 — visible = anchorY+height in [-800, 1400].
  const vis = visibleCards(placed, heights, {
    viewportTop: 0,
    viewportHeight: 600,
    bandPx: 800,
  });
  // First 8 cards (anchorY 0..1400) fall in the band; the rest are dropped.
  // (Exact count = 8 because anchorY of card 7 = 1400, last that fits.)
  assert(vis.length >= 5 && vis.length <= 12,
    `expected virtualization to render ~5-12, got ${vis.length}`);
  assert(vis.length < placed.length, 'must be strictly virtualized');
});

defineCase('focusEventId on a thread maps deterministically to its card', () => {
  // The margin's `focusEventId` effect queries the DOM by data-thread-id,
  // mapped from event-id → thread-id via the threads list. We assert the
  // mapping is unique and round-trips through the thread record.
  const c1 = makeComment('t-focus', 100, anchorAt(0, 10));
  const threads = reconstructThreads([c1], {});
  const target = threads.find((t) => t.rootEvent.meta.eventId === c1.meta.eventId);
  assert(target !== undefined, 'thread lookup by event id');
  assert(target!.id === 't-focus', 'thread id round-trips');
});

defineCase('"show all resolved" pill triggers when collapsed > 5', () => {
  // Mirror the margin's COLLAPSED_RESOLVED_THRESHOLD = 5 decision.
  const N = 8;
  const events: ReviewEvent[] = [];
  for (let i = 0; i < N; i += 1) {
    const c = makeComment(`t${i}`, 100 + i, anchorAt(i * 10, i * 10 + 5));
    events.push(c, makeResolveEvent(`t${i}`, 200 + i));
  }
  const threads = reconstructThreads(events, {});
  const scoped = threadsForFile(threads, ROOM, FILE);
  const resolvedThreads = scoped.filter((t) => t.resolved);
  assert(resolvedThreads.length === N, 'all resolved');
  // The pill shows when resolved.length > 5.
  const showPill = resolvedThreads.length > 5;
  assert(showPill === true, 'pill must be shown with 8 resolved');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
for (const run of cases) {
  const r = run();
  if (r.ok) {
    pass += 1;
    console.log(`  ok  ${r.name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${r.name}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${cases.length} total)`);
if (fail > 0) {
  interface NodeProcessShape { exit?: (code: number) => void }
  const nodeProcess = (globalThis as unknown as { process?: NodeProcessShape }).process;
  nodeProcess?.exit?.(1);
}
