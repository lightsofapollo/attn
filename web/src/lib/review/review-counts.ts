// Review counts for the desk (attn-n01r.34).
//
// The desk lists workspaces and shows none of the thing the product exists for.
// PRODUCT.md's positioning is "human comments and AI suggestions in a single
// end-to-end-encrypted thread", and the owner's home screen did not know either
// existed: WorkspaceSummary carried markdownCount, assetCount, lastEditedLabel,
// sharing, sizeLabel, backupLabel, openPath — and not one review fact.
//
// There is no cheap durable count to read. Review events live in the inbox and
// outbox stores as ENCRYPTED envelopes keyed by room, not workspace, so a count
// requires decrypting and projecting them — which is exactly what
// `replayReviewLogIntoStore` already does. This module supplies a minimal
// `ReviewStoreSink` that tallies instead of materialising, so the same replay
// can answer "what is waiting here?" without building the full store.
//
// Cost is bounded by only ever running it for workspaces that are actually
// shared: the review log no-ops without an active published share, so
// local-only rows cost nothing, and a desk typically has very few shared ones.

import type { FileId, ReviewEvent, ReviewSnapshot, RoomId, SnapshotId } from '../types';
import { compareEventKeys } from './selectors';

/** What the desk row needs to say "3 suggestions waiting". */
export interface WorkspaceReviewCounts {
  /** Comments created and not resolved. */
  openComments: number;
  /** Suggestions created and neither accepted nor rejected. */
  pendingSuggestions: number;
  /** Participant id of whoever last acted. Resolving that to human-vs-agent
   *  needs the room roster, which the caller has and this module does not —
   *  EventMeta carries authorId, not authorKind. */
  lastAuthorId: string | null;
  /** Wall clock of the most recent review event, for recency ordering. */
  lastActivityAt: number | null;
}

export const EMPTY_REVIEW_COUNTS: WorkspaceReviewCounts = {
  openComments: 0,
  pendingSuggestions: 0,
  lastAuthorId: null,
  lastActivityAt: null,
};

/** One lifecycle event, kept small: the fold outlives the events it reads. */
interface Mark {
  type: ReviewEvent['body']['type'];
  createdAt: number;
  eventId: string;
}

/**
 * A tallying stand-in for the runes review store.
 *
 * Structurally a `ReviewStoreSink` — the same interface `makeStubStore()` in
 * browser-session.test.ts implements — so it can be passed as `options.store`
 * to `replayReviewLogIntoStore` without pulling the `.svelte.ts` runes module.
 * Deliberately not typed as `ReviewStoreSink` here: importing that type drags
 * browser-session into the graph, and keeping the desk free of that graph is
 * the whole point of attn-n01r.41.
 */
export function createReviewCountingSink(): {
  counts: () => WorkspaceReviewCounts;
  currentRoomId: RoomId | null;
  currentFileId: FileId | null;
  currentSnapshotId: SnapshotId | null;
  applyEvent(event: ReviewEvent): void;
  applySnapshot(snapshot: ReviewSnapshot): void;
  setCurrentFile(fileId: FileId | null): void;
  setCurrentSnapshot(snapshotId: SnapshotId | null): void;
  leaveRoom(roomId: RoomId): void;
} {
  const seen = new Set<string>();
  // Thread ids by what ROOTED them. Both are collected as they arrive rather
  // than pre-passed: a fold that only sees a stream still classifies every id
  // correctly at the end, whichever order the roots and their lifecycle
  // events turned up in.
  const commentThreads = new Set<string>();
  const suggestionThreads = new Set<string>();
  // The winning lifecycle event per thread, by the same comparator that orders
  // the log for `reconstructThreads`. Folding in ARRIVAL order was the bug
  // (attn-e9r2.4): replay and live delivery interleave peers, so a newer
  // reopen applied before a delayed older resolve ended with the thread
  // closed here and open in the rail — the Desk badge disagreeing with the
  // surface it links to.
  //
  // Two winners, because the rail drops a `comment_reopened` naming a
  // SUGGESTION (accept and reject are terminal, attn-1l2f.1). `latest` decides
  // comment threads; `latestClosing` — the winner among everything except
  // reopens — decides suggestions, so a stray reopen cannot resurrect one.
  const lifecycle = new Map<string, { latest: Mark; latestClosing: Mark | null }>();
  let lastAuthorId: string | null = null;
  let lastActivityAt: number | null = null;

  function noteLifecycle(threadId: string, event: ReviewEvent, reopen: boolean): void {
    const mark: Mark = {
      type: event.body.type,
      createdAt: event.meta.createdAt,
      eventId: event.meta.eventId,
    };
    const fold = lifecycle.get(threadId);
    if (fold === undefined) {
      lifecycle.set(threadId, { latest: mark, latestClosing: reopen ? null : mark });
      return;
    }
    if (compareEventKeys(fold.latest, mark) < 0) fold.latest = mark;
    if (!reopen && (fold.latestClosing === null || compareEventKeys(fold.latestClosing, mark) < 0)) {
      fold.latestClosing = mark;
    }
  }

  return {
    currentRoomId: null,
    currentFileId: null,
    currentSnapshotId: null,

    counts(): WorkspaceReviewCounts {
      let openComments = 0;
      for (const threadId of commentThreads) {
        // Closed unless the winning lifecycle event was a reopen — the exact
        // rule `reconstructThreads` reads, so `resolved === false` there and
        // "open" here are the same threads.
        const fold = lifecycle.get(threadId);
        if (fold === undefined || fold.latest.type === 'comment_reopened') openComments += 1;
      }
      let pendingSuggestions = 0;
      for (const suggestionId of suggestionThreads) {
        // Any terminal event closes it; reopens are not terminal and never
        // reach `latestClosing`.
        if (lifecycle.get(suggestionId)?.latestClosing == null) pendingSuggestions += 1;
      }
      return { openComments, pendingSuggestions, lastAuthorId, lastActivityAt };
    },

    applyEvent(event: ReviewEvent): void {
      // The log is append-only and replay can overlap; dedup exactly as the
      // real store does, by eventId.
      const eventId = event.meta.eventId;
      if (seen.has(eventId)) return;
      seen.add(eventId);

      const body = event.body;
      switch (body.type) {
        case 'comment_created':
          commentThreads.add(body.threadId);
          break;
        case 'comment_resolved':
          noteLifecycle(body.threadId, event, false);
          break;
        case 'comment_reopened':
          noteLifecycle(body.threadId, event, true);
          break;
        case 'suggestion_created':
          suggestionThreads.add(body.suggestionId);
          break;
        case 'suggestion_accepted':
        case 'suggestion_rejected':
          noteLifecycle(body.suggestionId, event, false);
          break;
        default:
          // Room lifecycle, presence, snapshots: not review work, and counting
          // them would make the badge fire on someone merely opening the room.
          return;
      }

      // Only review work updates recency, for the same reason.
      const at = event.meta.createdAt;
      if (lastActivityAt === null || at > lastActivityAt) {
        lastActivityAt = at;
        lastAuthorId = event.meta.authorId;
      }
    },

    // The replay calls these; counting needs none of them.
    applySnapshot(): void {},
    setCurrentFile(): void {},
    setCurrentSnapshot(): void {},
    leaveRoom(): void {},
  };
}
