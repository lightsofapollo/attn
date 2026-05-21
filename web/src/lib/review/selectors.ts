// Pure derived selectors over the review-event log + anchor-resolution map.
//
// These functions are intentionally framework-free so they can be exercised
// directly by raw `tsx` (which cannot evaluate Svelte 5 runes — see the
// header in `store.test.ts` for the constraint). The Svelte-side store in
// `store.svelte.ts` wires each of these into a `$derived` block so the right
// rail / margin / decoration plugin re-render reactively, but the same
// functions can be called from tests or non-component code without any
// runes runtime.
//
// Inputs are plain arrays / records, never the runes-backed store itself.
//
// Spec refs:
//   * planning/collab/data-model.md §Comment Events (thread/reply shape)
//   * planning/collab/data-model.md §Anchor Resolution (status verdicts)
//   * planning/collab/ui/review-panel-design.md §1-§3 (consumer requirements)

import type {
  Anchor,
  EventId,
  FileId,
  PositionAnchor,
  ResolvedAnchor,
  ResolvedAnchorCandidate,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewStatusPeer,
  RoomId,
  SnapshotId,
  Thread,
} from '../types';

// ---------------------------------------------------------------------------
// Public output shapes (kept narrow so consumers can destructure cleanly)
// ---------------------------------------------------------------------------

/**
 * Ambiguous-anchor row surfaced in the orphan tray. The selector flattens
 * the `ResolvedAnchor.ambiguous` variant into `(eventId, candidates)`.
 */
export interface AmbiguousAnchorEntry {
  eventId: EventId;
  candidates: ResolvedAnchorCandidate[];
  reason: string;
}

/**
 * Stale-anchor row surfaced in the orphan tray. The frontend doesn't need
 * candidates here — the card renders the manual-reanchor flow instead.
 */
export interface StaleAnchorEntry {
  eventId: EventId;
  reason: string;
}

/**
 * Peer split used by the connection-share strip. A peer is "on latest" iff
 * their `onSnapshotId` equals the active snapshot id supplied by the caller.
 * @see planning/collab/ui/connection-share.md
 */
export interface PeerSplit {
  onLatestSnapshot: ReviewStatusPeer[];
  onOlderSnapshot: ReviewStatusPeer[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Return the anchor authored on a thread-root event (`CommentCreated` or
 * `SuggestionCreated`), or `null` for any other body kind. Centralized so the
 * thread builder doesn't sprinkle discriminator checks throughout.
 */
function rootEventAnchor(event: ReviewEvent): Anchor | null {
  if (event.body.type === 'comment_created') return event.body.anchor;
  if (event.body.type === 'suggestion_created') return event.body.anchor;
  return null;
}

/**
 * Stable ascending sort key. `createdAt` is the primary key; `eventId` is
 * the deterministic tie-breaker so two events stamped in the same
 * millisecond don't flip order between calls.
 */
function compareEvents(a: ReviewEvent, b: ReviewEvent): number {
  if (a.meta.createdAt !== b.meta.createdAt) {
    return a.meta.createdAt - b.meta.createdAt;
  }
  return a.meta.eventId < b.meta.eventId ? -1 : a.meta.eventId > b.meta.eventId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Thread reconstruction
// ---------------------------------------------------------------------------

/**
 * Walk the append-only event log and group `CommentCreated` + `CommentResolved`
 * events into `Thread` records.
 *
 * Rules (mirrors planning/collab/data-model.md §Comment Events):
 *   * Threads are keyed by `CommentCreatedBody.threadId`.
 *   * The thread root is the earliest comment in the thread by
 *     `meta.createdAt` (with `eventId` as tie-breaker for determinism).
 *   * Replies are every other comment in the thread, ordered the same way.
 *   * Any `CommentResolved` event referencing the thread flips `resolved`
 *     to `true`. There is no un-resolve event in the spec today.
 *   * `anchor` is the anchor authored on the root event; `null` only if
 *     the log was somehow built without a root comment.
 *   * `resolvedAnchor` is the latest verdict for the root event's id,
 *     pulled from the resolver-update map passed in.
 *
 * Filtering by room / file / snapshot is the caller's job (see the
 * `threadsForCurrentFile` / `threadsForCurrentSnapshot` selectors below).
 */
export function reconstructThreads(
  events: ReviewEvent[],
  anchorResolutions: Record<EventId, ReviewAnchorResolutionUpdate>,
): Thread[] {
  // Bucket comments by threadId first, then collect resolution flips.
  const commentsByThread = new Map<string, ReviewEvent[]>();
  const resolvedThreadIds = new Set<string>();

  for (const event of events) {
    if (event.body.type === 'comment_created') {
      const list = commentsByThread.get(event.body.threadId);
      if (list === undefined) {
        commentsByThread.set(event.body.threadId, [event]);
      } else {
        list.push(event);
      }
    } else if (event.body.type === 'suggestion_created') {
      // A suggestion is a single-event thread keyed by its suggestionId. Without
      // this it never enters `threads` → never gets a margin card, so the owner
      // can't see (or accept) a reviewer's proposed edit. ReviewMargin.kindFor
      // already renders the suggestion branch once the thread reaches it.
      const list = commentsByThread.get(event.body.suggestionId);
      if (list === undefined) {
        commentsByThread.set(event.body.suggestionId, [event]);
      } else {
        list.push(event);
      }
    } else if (event.body.type === 'comment_resolved') {
      resolvedThreadIds.add(event.body.threadId);
    }
  }

  const threads: Thread[] = [];
  for (const [threadId, comments] of commentsByThread) {
    // Sort once; root is the head, replies are the tail.
    comments.sort(compareEvents);
    const rootEvent = comments[0]!;
    const replies = comments.slice(1);
    const resolution = anchorResolutions[rootEvent.meta.eventId];
    threads.push({
      id: threadId,
      rootEvent,
      replies,
      resolved: resolvedThreadIds.has(threadId),
      anchor: rootEventAnchor(rootEvent),
      resolvedAnchor: resolution !== undefined ? resolution.resolved : null,
    });
  }

  // Stable order: by root createdAt so panel scroll order matches log order.
  threads.sort((a, b) => compareEvents(a.rootEvent, b.rootEvent));
  return threads;
}

// ---------------------------------------------------------------------------
// File / snapshot scoped views
// ---------------------------------------------------------------------------

/**
 * Threads filtered to a specific room + file. Returns an empty array when
 * either id is `null` (panel hasn't been pointed at anything yet).
 *
 * Room match is on `rootEvent.meta.roomId`; file match is on the root
 * comment's anchor `fileId`. Threads whose root has no anchor (malformed
 * input) are dropped.
 */
export function threadsForFile(
  threads: Thread[],
  roomId: RoomId | null,
  fileId: FileId | null,
): Thread[] {
  if (roomId === null || fileId === null) return [];
  return threads.filter(
    (t) =>
      t.rootEvent.meta.roomId === roomId
      && t.anchor !== null
      && t.anchor.fileId === fileId,
  );
}

/**
 * Threads filtered to a specific snapshot within a file. Used when the
 * panel is scoped to a particular snapshot pick (a coarse cadence per
 * `planning/collab/amendments.md` Decision #11). Empty result when any of
 * the three ids is `null`.
 */
export function threadsForSnapshot(
  threads: Thread[],
  roomId: RoomId | null,
  fileId: FileId | null,
  snapshotId: SnapshotId | null,
): Thread[] {
  if (snapshotId === null) return [];
  return threadsForFile(threads, roomId, fileId).filter(
    (t) => t.anchor !== null && t.anchor.snapshotId === snapshotId,
  );
}

// ---------------------------------------------------------------------------
// Orphan-tray feeds (ambiguous + stale)
// ---------------------------------------------------------------------------

/**
 * Flatten the anchor-resolution map to the rows the orphan-tray ambiguous
 * picker renders. Only `status === 'ambiguous'` entries pass through.
 */
export function ambiguousAnchors(
  anchorResolutions: Record<EventId, ReviewAnchorResolutionUpdate>,
): AmbiguousAnchorEntry[] {
  const out: AmbiguousAnchorEntry[] = [];
  for (const update of Object.values(anchorResolutions)) {
    if (update.resolved.status === 'ambiguous') {
      out.push({
        eventId: update.eventId,
        candidates: update.resolved.candidates,
        reason: update.resolved.reason,
      });
    }
  }
  return out;
}

/**
 * Flatten the anchor-resolution map to the rows the orphan-tray stale
 * strip renders. Only `status === 'stale'` entries pass through.
 */
export function staleAnchors(
  anchorResolutions: Record<EventId, ReviewAnchorResolutionUpdate>,
): StaleAnchorEntry[] {
  const out: StaleAnchorEntry[] = [];
  for (const update of Object.values(anchorResolutions)) {
    if (update.resolved.status === 'stale') {
      out.push({
        eventId: update.eventId,
        reason: update.resolved.reason,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Header / peer-strip selectors
// ---------------------------------------------------------------------------

/**
 * Unresolved thread count badge for the panel header.
 */
export function unresolvedThreadCount(threads: Thread[]): number {
  let n = 0;
  for (const t of threads) if (!t.resolved) n += 1;
  return n;
}

/**
 * Split the peer roster into "on the latest snapshot" vs "on an older one"
 * for the peer strip. Peers without an `onSnapshotId` are treated as older
 * — they haven't pulled the current snapshot yet.
 *
 * When `latestSnapshotId` is `null` (no snapshot picked), everyone falls
 * into the "older" bucket; the strip will hide itself.
 */
export function partitionPeersBySnapshot(
  peers: ReviewStatusPeer[],
  latestSnapshotId: SnapshotId | null,
): PeerSplit {
  const onLatestSnapshot: ReviewStatusPeer[] = [];
  const onOlderSnapshot: ReviewStatusPeer[] = [];
  for (const peer of peers) {
    // A peer whose snapshot id we don't know yet (presence frames don't carry
    // it) is UNKNOWN — not "older". Counting unknown as older made the owner
    // badge perpetually warn "Reviewer on older snapshot" the instant anyone
    // joined. Only flag peers we KNOW are on a non-latest snapshot.
    if (peer.onSnapshotId === undefined) continue;
    if (latestSnapshotId !== null && peer.onSnapshotId === latestSnapshotId) {
      onLatestSnapshot.push(peer);
    } else {
      onOlderSnapshot.push(peer);
    }
  }
  return { onLatestSnapshot, onOlderSnapshot };
}

// ---------------------------------------------------------------------------
// Manual-reanchor helper (used by the ambiguous picker)
// ---------------------------------------------------------------------------

/**
 * Look up the `currentRange` from an ambiguous resolution's candidate list
 * by index. Returned `null` when the resolution isn't ambiguous or the
 * index is out of bounds. Pure helper so the picker doesn't have to
 * re-discriminate `ResolvedAnchor` itself.
 */
export function pickAmbiguousCandidate(
  resolved: ResolvedAnchor,
  candidateIndex: number,
): PositionAnchor | null {
  if (resolved.status !== 'ambiguous') return null;
  const candidate = resolved.candidates[candidateIndex];
  return candidate === undefined ? null : candidate.currentRange;
}
