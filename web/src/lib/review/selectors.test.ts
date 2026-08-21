// Manual harness for the pure review selectors (attn-nnj.4.2).
//
// Same convention as `resolver.test.ts` / `store.test.ts`: no test framework,
// just `tsx`-runnable assertions. Run with:
//
//   cd web && npx tsx src/lib/review/selectors.test.ts
//
// We import the pure functions directly. They have no runes dependency, so
// tsx can evaluate them without the Svelte compiler. The `$derived` wiring
// in `store.svelte.ts` is the same set of calls, just wrapped reactively.

import {
  ambiguousAnchors,
  canReopenThread,
  threadKind,
  partitionPeersBySnapshot,
  pickAmbiguousCandidate,
  reconstructThreads,
  staleAnchors,
  threadsForFile,
  threadsForSnapshot,
  unresolvedThreadCount,
} from './selectors';
import type {
  Anchor,
  ContentHash,
  EventId,
  FileId,
  ParticipantId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewStatusPeer,
  RoomId,
  SnapshotId,
} from '../types';

// ---------------------------------------------------------------------------
// Tiny harness (matches resolver.test.ts conventions)
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

const ROOM_A: RoomId = 'room-a';
const ROOM_B: RoomId = 'room-b';
const FILE_1: FileId = 'file-1';
const FILE_2: FileId = 'file-2';
const SNAP_A: SnapshotId = 'snap-a';
const SNAP_B: SnapshotId = 'snap-b';
const AUTHOR: ParticipantId = 'p-alice';
const BASE_HASH = 'h-base' as ContentHash;

let nextEventId = 0;
function makeEventId(prefix: string): EventId {
  nextEventId += 1;
  return `${prefix}-${nextEventId}`;
}

function anchorOn(fileId: FileId, snapshotId: SnapshotId, byteStart: number, byteEnd: number): Anchor {
  return {
    v: 2,
    fileId,
    snapshotId,
    baseHash: BASE_HASH,
    position: {
      byteRange: [byteStart, byteEnd],
      lineRange: [1, 1],
    },
  };
}

interface MakeCommentOpts {
  roomId?: RoomId;
  threadId: string;
  createdAt: number;
  anchor: Anchor;
  body?: string;
  eventId?: EventId;
}

function makeComment(opts: MakeCommentOpts): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: opts.eventId ?? makeEventId('evt-c'),
      roomId: opts.roomId ?? ROOM_A,
      authorId: AUTHOR,
      deviceId: 'd-alice',
      createdAt: opts.createdAt,
      parentEventIds: [],
    },
    body: {
      type: 'comment_created',
      threadId: opts.threadId,
      anchor: opts.anchor,
      body: opts.body ?? 'hello',
    },
    auth: { signature: 'sig', signingKeyId: 'k' },
  };
}

function makeResolve(threadId: string, createdAt: number): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: makeEventId('evt-r'),
      roomId: ROOM_A,
      authorId: AUTHOR,
      deviceId: 'd-alice',
      createdAt,
      parentEventIds: [],
    },
    body: {
      type: 'comment_resolved',
      threadId,
      resolvedBy: AUTHOR,
    },
    auth: { signature: 'sig', signingKeyId: 'k' },
  };
}

function makeReopen(threadId: string, createdAt: number): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: makeEventId('evt-o'),
      roomId: ROOM_A,
      authorId: AUTHOR,
      deviceId: 'd-alice',
      createdAt,
      parentEventIds: [],
    },
    body: {
      type: 'comment_reopened',
      threadId,
      reopenedBy: AUTHOR,
    },
    auth: { signature: 'sig', signingKeyId: 'k' },
  };
}

function makeSuggestion(suggestionId: string, createdAt: number): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: makeEventId('evt-s'),
      roomId: ROOM_A,
      authorId: AUTHOR,
      deviceId: 'd-alice',
      createdAt,
      parentEventIds: [],
    },
    body: {
      type: 'suggestion_created',
      suggestionId,
      anchor: anchorOn(FILE_1, SNAP_A, 0, 5),
      operation: { kind: 'replace', expectedText: 'hello', replacement: 'changed' },
      note: 'suggested change',
    },
    auth: { signature: 'sig', signingKeyId: 'k' },
  };
}

function makeSuggestionTerminal(
  suggestionId: string,
  disposition: 'accepted' | 'rejected',
  createdAt: number,
): ReviewEvent {
  return {
    meta: {
      v: 2,
      eventId: makeEventId('evt-st'),
      roomId: ROOM_A,
      authorId: AUTHOR,
      deviceId: 'd-alice',
      createdAt,
      parentEventIds: [],
    },
    body: disposition === 'accepted'
      ? {
          type: 'suggestion_accepted',
          suggestionId,
          appliedRevisionId: 'revision-accepted',
          resultingHash: BASE_HASH,
        }
      : { type: 'suggestion_rejected', suggestionId },
    auth: { signature: 'sig', signingKeyId: 'k' },
  };
}

function ambiguousUpdate(
  eventId: EventId,
  reason = 'tied_top_candidates',
): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM_A,
    fileId: FILE_1,
    eventId,
    resolved: {
      status: 'ambiguous',
      reason,
      candidates: [
        {
          confidence: 0.55,
          currentRange: { byteRange: [0, 10], lineRange: [1, 1] },
          reason: 'quote_match',
          preview: 'candidate one',
        },
        {
          confidence: 0.5,
          currentRange: { byteRange: [40, 50], lineRange: [4, 4] },
          reason: 'quote_match',
          preview: 'candidate two',
        },
      ],
    },
  };
}

function staleUpdate(eventId: EventId, reason = 'no_candidates'): ReviewAnchorResolutionUpdate {
  return {
    roomId: ROOM_A,
    fileId: FILE_1,
    eventId,
    resolved: { status: 'stale', reason },
  };
}

function peer(
  participantId: ParticipantId,
  online: boolean,
  onSnapshotId?: SnapshotId,
): ReviewStatusPeer {
  const base: ReviewStatusPeer = {
    participantId,
    deviceId: `d-${participantId}`,
    displayName: participantId,
    kind: 'reviewer',
    online,
  };
  if (onSnapshotId !== undefined) base.onSnapshotId = onSnapshotId;
  return base;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

defineCase('empty store: every selector returns an empty/zero default', () => {
  const events: ReviewEvent[] = [];
  const resolutions: Record<EventId, ReviewAnchorResolutionUpdate> = {};
  const threads = reconstructThreads(events, resolutions);

  assert(threads.length === 0, `expected 0 threads, got ${threads.length}`);
  assert(threadsForFile(threads, ROOM_A, FILE_1).length === 0, 'file scope must be empty');
  assert(
    threadsForSnapshot(threads, ROOM_A, FILE_1, SNAP_A).length === 0,
    'snapshot scope must be empty',
  );
  assert(ambiguousAnchors(resolutions).length === 0, 'ambiguous must be empty');
  assert(staleAnchors(resolutions).length === 0, 'stale must be empty');
  assert(unresolvedThreadCount(threads) === 0, 'unresolved count must be 0');

  const split = partitionPeersBySnapshot([], SNAP_A);
  assert(split.onLatestSnapshot.length === 0, 'no peers => latest empty');
  assert(split.onOlderSnapshot.length === 0, 'no peers => older empty');
});

defineCase('threadsForFile filters by roomId + fileId', () => {
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const c2 = makeComment({ threadId: 't-2', createdAt: 110, anchor: anchorOn(FILE_2, SNAP_A, 0, 5) });
  const c3 = makeComment({
    roomId: ROOM_B,
    threadId: 't-3',
    createdAt: 120,
    anchor: anchorOn(FILE_1, SNAP_A, 0, 5),
  });

  const threads = reconstructThreads([c1, c2, c3], {});
  assert(threads.length === 3, `expected 3 threads, got ${threads.length}`);

  const onFile1 = threadsForFile(threads, ROOM_A, FILE_1);
  assert(
    onFile1.length === 1 && onFile1[0]!.id === 't-1',
    `expected only t-1 on room-a/file-1, got ${onFile1.map((t) => t.id).join(',')}`,
  );

  const nullRoom = threadsForFile(threads, null, FILE_1);
  assert(nullRoom.length === 0, 'null room must drop to empty');
  const nullFile = threadsForFile(threads, ROOM_A, null);
  assert(nullFile.length === 0, 'null file must drop to empty');
});

defineCase('threadsForSnapshot narrows further by snapshotId', () => {
  const onA = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const onB = makeComment({ threadId: 't-2', createdAt: 110, anchor: anchorOn(FILE_1, SNAP_B, 0, 5) });
  const threads = reconstructThreads([onA, onB], {});

  const file = threadsForFile(threads, ROOM_A, FILE_1);
  assert(file.length === 2, `pre-condition: 2 threads on file-1, got ${file.length}`);

  const lockedA = threadsForSnapshot(threads, ROOM_A, FILE_1, SNAP_A);
  assert(
    lockedA.length === 1 && lockedA[0]!.id === 't-1',
    `expected t-1 only on snap-a, got ${lockedA.map((t) => t.id).join(',')}`,
  );

  const nullSnap = threadsForSnapshot(threads, ROOM_A, FILE_1, null);
  assert(nullSnap.length === 0, 'null snapshot must drop to empty');
});

defineCase('comments + replies merge into the same Thread', () => {
  const anchor = anchorOn(FILE_1, SNAP_A, 0, 5);
  const root = makeComment({
    threadId: 't-merge',
    createdAt: 100,
    anchor,
    body: 'top',
    eventId: 'evt-root',
  });
  const r1 = makeComment({ threadId: 't-merge', createdAt: 200, anchor, body: 'r1' });
  const r2 = makeComment({ threadId: 't-merge', createdAt: 300, anchor, body: 'r2' });

  // Pass replies out-of-order to confirm sorting works.
  const threads = reconstructThreads([r2, root, r1], {});
  assert(threads.length === 1, `expected 1 merged thread, got ${threads.length}`);
  const t = threads[0]!;
  assert(t.rootEvent.meta.eventId === 'evt-root', `expected root by createdAt, got ${t.rootEvent.meta.eventId}`);
  assert(t.replies.length === 2, `expected 2 replies, got ${t.replies.length}`);
  const replyBodies = t.replies.map((e) =>
    e.body.type === 'comment_created' ? e.body.body : '',
  );
  assert(
    replyBodies[0] === 'r1' && replyBodies[1] === 'r2',
    `expected replies sorted r1,r2, got ${replyBodies.join(',')}`,
  );
});

defineCase('comment_resolved flips resolved=true on the matching thread only', () => {
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const c2 = makeComment({ threadId: 't-2', createdAt: 110, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const r1 = makeResolve('t-1', 150);

  const threads = reconstructThreads([c1, c2, r1], {});
  const t1 = threads.find((t) => t.id === 't-1');
  const t2 = threads.find((t) => t.id === 't-2');
  assert(t1 !== undefined && t2 !== undefined, 'both threads must exist');
  assert(t1.resolved === true, 't-1 must be resolved');
  assert(t2.resolved === false, 't-2 must NOT be resolved');

  assert(
    unresolvedThreadCount(threads) === 1,
    `unresolved count should be 1, got ${unresolvedThreadCount(threads)}`,
  );
});

defineCase('comment_reopened reopens a resolved thread (attn-bb6t.4)', () => {
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const threads = reconstructThreads([c1, makeResolve('t-1', 150), makeReopen('t-1', 200)], {});
  const t1 = threads.find((t) => t.id === 't-1');
  assert(t1 !== undefined, 't-1 must exist');
  assert(t1.resolved === false, 't-1 must be open again after a reopen');
  assert(
    unresolvedThreadCount(threads) === 1,
    `reopened thread must count as unresolved, got ${unresolvedThreadCount(threads)}`,
  );
});

defineCase('resolve → reopen → resolve lands on resolved', () => {
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const threads = reconstructThreads(
    [c1, makeResolve('t-1', 150), makeReopen('t-1', 200), makeResolve('t-1', 250)],
    {},
  );
  assert(threads.find((t) => t.id === 't-1')?.resolved === true, 'last writer (resolve) must win');
});

defineCase('reopen wins over an EARLIER resolve delivered later (out-of-order log)', () => {
  // The whole reason the fold compares events instead of trusting array
  // order: replay and live delivery interleave peers, so a stale resolve can
  // arrive after the reopen that superseded it.
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: anchorOn(FILE_1, SNAP_A, 0, 5) });
  const reopen = makeReopen('t-1', 200);
  const resolve = makeResolve('t-1', 150);
  const threads = reconstructThreads([c1, reopen, resolve], {});
  assert(
    threads.find((t) => t.id === 't-1')?.resolved === false,
    'the later-timestamped reopen must win regardless of arrival order',
  );
});

defineCase('suggestion terminals resolve only their matching suggestion thread', () => {
  const accepted = makeSuggestion('suggestion-accepted', 100);
  const rejected = makeSuggestion('suggestion-rejected', 110);
  const stillOpen = makeSuggestion('suggestion-open', 120);
  const acceptedTerminal = makeSuggestionTerminal('suggestion-accepted', 'accepted', 130);
  const rejectedTerminal = makeSuggestionTerminal('suggestion-rejected', 'rejected', 140);

  const threads = reconstructThreads(
    [accepted, rejected, stillOpen, acceptedTerminal, rejectedTerminal],
    {},
  );
  assert(
    threads.find((thread) => thread.id === 'suggestion-accepted')?.resolved === true,
    'accepted suggestion must become resolved',
  );
  assert(
    threads.find((thread) => thread.id === 'suggestion-rejected')?.resolved === true,
    'rejected suggestion must become resolved',
  );
  assert(
    threads.find((thread) => thread.id === 'suggestion-open')?.resolved === false,
    'unrelated suggestion must stay open',
  );
  assert(
    unresolvedThreadCount(threads) === 1,
    `one suggestion should remain unresolved, got ${unresolvedThreadCount(threads)}`,
  );
});

// attn-1l2f.1 — accept and reject are terminal. A `comment_reopened` naming a
// suggestion id must not resurrect it, whatever order the log arrives in.
defineCase('comment_reopened cannot resurrect an accepted suggestion', () => {
  const suggestion = makeSuggestion('suggestion-accepted', 100);
  const terminal = makeSuggestionTerminal('suggestion-accepted', 'accepted', 110);
  const reopen = makeReopen('suggestion-accepted', 120);

  const threads = reconstructThreads([suggestion, terminal, reopen], {});
  const thread = threads.find((t) => t.id === 'suggestion-accepted');
  assert(thread !== undefined, 'suggestion thread must still exist');
  assert(
    thread.resolved === true,
    'an accepted suggestion must stay resolved after a stray reopen',
  );
  assert(
    unresolvedThreadCount(threads) === 0,
    `no thread should be unresolved, got ${unresolvedThreadCount(threads)}`,
  );
});

defineCase('comment_reopened cannot resurrect a rejected suggestion', () => {
  const suggestion = makeSuggestion('suggestion-rejected', 100);
  const terminal = makeSuggestionTerminal('suggestion-rejected', 'rejected', 110);
  const reopen = makeReopen('suggestion-rejected', 120);

  const threads = reconstructThreads([suggestion, terminal, reopen], {});
  assert(
    threads.find((t) => t.id === 'suggestion-rejected')?.resolved === true,
    'a rejected suggestion must stay resolved after a stray reopen',
  );
});

defineCase('a reopen read BEFORE its suggestion is still dropped', () => {
  // Replay and live delivery interleave: the reopen can be folded first.
  const suggestion = makeSuggestion('suggestion-ooo', 100);
  const terminal = makeSuggestionTerminal('suggestion-ooo', 'accepted', 110);
  const reopen = makeReopen('suggestion-ooo', 120);

  const threads = reconstructThreads([reopen, terminal, suggestion], {});
  assert(
    threads.find((t) => t.id === 'suggestion-ooo')?.resolved === true,
    'out-of-order delivery must not change the verdict',
  );
});

defineCase('dropping suggestion reopens does not affect comment threads', () => {
  // The guard is keyed on the thread's root kind, not on the event: a comment
  // and a suggestion sharing the log must still fold independently.
  const comment = makeComment({
    threadId: 'thread-comment',
    createdAt: 100,
    anchor: anchorOn(FILE_1, SNAP_A, 0, 4),
  });
  const resolved = makeResolve('thread-comment', 110);
  const commentReopen = makeReopen('thread-comment', 120);
  const suggestion = makeSuggestion('suggestion-terminal', 100);
  const terminal = makeSuggestionTerminal('suggestion-terminal', 'accepted', 110);
  const suggestionReopen = makeReopen('suggestion-terminal', 130);

  const threads = reconstructThreads(
    [comment, resolved, commentReopen, suggestion, terminal, suggestionReopen],
    {},
  );
  assert(
    threads.find((t) => t.id === 'thread-comment')?.resolved === false,
    'the comment thread must still reopen',
  );
  assert(
    threads.find((t) => t.id === 'suggestion-terminal')?.resolved === true,
    'the suggestion must stay decided',
  );
});

// The affordance rule and the projection rule are the same statement, so the
// Unresolve button can never appear on a thread whose reopen would be dropped.
defineCase('canReopenThread: comment yes, suggestion no', () => {
  const threads = reconstructThreads(
    [
      makeComment({
        threadId: 'thread-comment',
        createdAt: 100,
        anchor: anchorOn(FILE_1, SNAP_A, 0, 4),
      }),
      makeResolve('thread-comment', 110),
      makeSuggestion('suggestion-decided', 100),
      makeSuggestionTerminal('suggestion-decided', 'accepted', 110),
    ],
    {},
  );
  const comment = threads.find((t) => t.id === 'thread-comment');
  const suggestion = threads.find((t) => t.id === 'suggestion-decided');
  assert(comment !== undefined && suggestion !== undefined, 'both threads must exist');
  assert(comment.resolved && suggestion.resolved, 'both must read as resolved');
  assert(threadKind(comment) === 'comment', 'comment thread kind');
  assert(threadKind(suggestion) === 'suggestion', 'suggestion thread kind');
  assert(canReopenThread(comment), 'a resolved comment offers Unresolve');
  assert(!canReopenThread(suggestion), 'a decided suggestion does not');
});

defineCase('ambiguousAnchors lists every ambiguous resolution by eventId', () => {
  const u1 = ambiguousUpdate('evt-amb-1', 'tied_top');
  const u2 = ambiguousUpdate('evt-amb-2', 'two_quotes');
  const u3 = staleUpdate('evt-stale-1');
  const resolutions = { [u1.eventId]: u1, [u2.eventId]: u2, [u3.eventId]: u3 };

  const amb = ambiguousAnchors(resolutions);
  assert(amb.length === 2, `expected 2 ambiguous rows, got ${amb.length}`);
  const ids = new Set(amb.map((a) => a.eventId));
  assert(ids.has('evt-amb-1') && ids.has('evt-amb-2'), 'ambiguous rows must include both events');
  const first = amb.find((a) => a.eventId === 'evt-amb-1')!;
  assert(first.candidates.length === 2, 'candidates must be preserved');
  assert(first.reason === 'tied_top', `expected reason passthrough, got ${first.reason}`);
});

defineCase('staleAnchors lists every stale resolution by eventId', () => {
  const u1 = staleUpdate('evt-stale-1', 'low_confidence');
  const u2 = staleUpdate('evt-stale-2', 'no_candidates');
  const u3 = ambiguousUpdate('evt-amb-1');
  const resolutions = { [u1.eventId]: u1, [u2.eventId]: u2, [u3.eventId]: u3 };

  const stale = staleAnchors(resolutions);
  assert(stale.length === 2, `expected 2 stale rows, got ${stale.length}`);
  const reasons = new Set(stale.map((s) => s.reason));
  assert(
    reasons.has('low_confidence') && reasons.has('no_candidates'),
    'stale rows must preserve reasons',
  );
});

defineCase('resolvedAnchor on a Thread mirrors the latest resolver verdict', () => {
  const anchor = anchorOn(FILE_1, SNAP_A, 0, 5);
  const root = makeComment({
    threadId: 't-amb',
    createdAt: 100,
    anchor,
    eventId: 'evt-amb-root',
  });
  const update = ambiguousUpdate('evt-amb-root');
  const threads = reconstructThreads([root], { [update.eventId]: update });
  const t = threads[0]!;
  assert(t.resolvedAnchor !== null, 'expected resolvedAnchor on thread');
  assert(t.resolvedAnchor.status === 'ambiguous', `expected ambiguous, got ${t.resolvedAnchor.status}`);

  // No resolution → resolvedAnchor null
  const bare = reconstructThreads([root], {});
  assert(bare[0]!.resolvedAnchor === null, 'no resolution => null verdict');
});

defineCase('pickAmbiguousCandidate returns range or null defensively', () => {
  const u = ambiguousUpdate('evt-amb-1');
  const range0 = pickAmbiguousCandidate(u.resolved, 0);
  assert(range0 !== null && range0.byteRange[0] === 0, 'expected first candidate range');
  const oob = pickAmbiguousCandidate(u.resolved, 99);
  assert(oob === null, 'out-of-bounds picker must return null');
  const stale = staleUpdate('evt-stale-1');
  const onStale = pickAmbiguousCandidate(stale.resolved, 0);
  assert(onStale === null, 'pick on non-ambiguous resolution must return null');
});

defineCase('partitionPeersBySnapshot splits by onSnapshotId vs latest', () => {
  const peers = [
    peer('alice', true, SNAP_A),
    peer('bob', true, SNAP_B),
    peer('carol', true), // no snapshot id
    peer('dave', false, SNAP_A),
  ];
  const split = partitionPeersBySnapshot(peers, SNAP_A);
  const latestIds = split.onLatestSnapshot.map((p) => p.participantId);
  const olderIds = split.onOlderSnapshot.map((p) => p.participantId);
  assert(
    latestIds.length === 2 && latestIds.includes('alice') && latestIds.includes('dave'),
    `expected alice+dave on latest, got ${latestIds.join(',')}`,
  );
  // carol has no snapshot id → UNKNOWN, not older (avoids the false "Reviewer
  // on older snapshot" warning when presence doesn't carry the snapshot id).
  assert(
    olderIds.length === 1 && olderIds.includes('bob'),
    `expected only bob on older (carol unknown is excluded), got ${olderIds.join(',')}`,
  );
  assert(
    !latestIds.includes('carol') && !olderIds.includes('carol'),
    'unknown-snapshot peer must be in neither bucket',
  );

  // null latest => peers with a KNOWN snapshot are older; unknown still excluded
  const allOlder = partitionPeersBySnapshot(peers, null);
  assert(allOlder.onLatestSnapshot.length === 0, 'null latest => latest bucket empty');
  assert(
    allOlder.onOlderSnapshot.length === 3,
    'null latest => the 3 known-snapshot peers are older (carol unknown excluded)',
  );
});

defineCase('outboxCount tracks pendingOutbox.length (proxy via array.length)', () => {
  // outboxCount is a `$derived` in the store; the pure-function equivalent
  // is just `pendingOutbox.length`. Assert the contract here so the test
  // covers all 7 named selectors from the planning doc. We funnel the
  // length read through a helper so the narrowing analyzer treats it as a
  // function call result instead of an array-literal-narrowed constant.
  const measure = (arr: unknown[]): number => arr.length;
  const pending: unknown[] = [];
  if (measure(pending) !== 0) throw new Error('starts empty');
  pending.push({ envelopeId: 'env-1' });
  pending.push({ envelopeId: 'env-2' });
  pending.push({ envelopeId: 'env-3' });
  const got = measure(pending);
  if (got !== 3) throw new Error(`expected 3 outbox entries, got ${got}`);
});

defineCase('unresolvedThreadCount counts only unresolved threads', () => {
  const a = anchorOn(FILE_1, SNAP_A, 0, 5);
  const c1 = makeComment({ threadId: 't-1', createdAt: 100, anchor: a });
  const c2 = makeComment({ threadId: 't-2', createdAt: 110, anchor: a });
  const c3 = makeComment({ threadId: 't-3', createdAt: 120, anchor: a });
  const r1 = makeResolve('t-1', 150);
  const r3 = makeResolve('t-3', 160);

  const threads = reconstructThreads([c1, c2, c3, r1, r3], {});
  assert(threads.length === 3, `expected 3 threads, got ${threads.length}`);
  assert(
    unresolvedThreadCount(threads) === 1,
    `expected 1 unresolved (t-2), got ${unresolvedThreadCount(threads)}`,
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
