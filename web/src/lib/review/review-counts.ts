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
  applyEvent(event: ReviewEvent): void;
  applySnapshot(snapshot: ReviewSnapshot): void;
  setCurrentFile(fileId: FileId | null): void;
  setCurrentSnapshot(snapshotId: SnapshotId | null): void;
  leaveRoom(roomId: RoomId): void;
} {
  const seen = new Set<string>();
  const openThreads = new Set<string>();
  const pending = new Set<string>();
  let lastAuthorId: string | null = null;
  let lastActivityAt: number | null = null;

  return {
    currentRoomId: null,

    counts(): WorkspaceReviewCounts {
      return {
        openComments: openThreads.size,
        pendingSuggestions: pending.size,
        lastAuthorId,
        lastActivityAt,
      };
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
          openThreads.add(body.threadId);
          break;
        case 'comment_resolved':
          openThreads.delete(body.threadId);
          break;
        case 'suggestion_created':
          pending.add(body.suggestionId);
          break;
        case 'suggestion_accepted':
        case 'suggestion_rejected':
          pending.delete(body.suggestionId);
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
