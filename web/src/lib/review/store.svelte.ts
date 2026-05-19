// Review-domain global state holder.
//
// This file lives at `web/src/lib/review/store.svelte.ts` (not `.ts`) because
// Svelte 5 runes (`$state`, `$derived`) only compile outside components when
// the file extension is `.svelte.ts` (or `.svelte.js`). See
// `references/performance.md` of the svelte5-best-practices skill, and
// existing precedent in `web/src/lib/hooks/is-mobile.svelte.ts` and
// `web/src/lib/components/ui/sidebar/context.svelte.ts`.
//
// Phase 0c (12.10) seeded the connection / peer / event / snapshot /
// anchor-resolution buffers. Phase 2 (attn-nnj.4.2 — this layer) adds the
// typed derived selectors that drive the panel UI: comment-thread
// reconstruction, file/snapshot scoping, orphan-tray feeds, outbox count,
// and peer-strip splits. The selector bodies live in
// `./selectors.ts` as pure functions so they can be exercised by raw `tsx`
// without the runes runtime; `$derived` here is a thin reactive wrapper.

import {
  ambiguousAnchors,
  partitionPeersBySnapshot,
  reconstructThreads,
  staleAnchors,
  threadsForFile,
  threadsForSnapshot,
  unresolvedThreadCount,
  type AmbiguousAnchorEntry,
  type PeerSplit,
  type StaleAnchorEntry,
} from './selectors';
import type {
  EventId,
  FileId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewSnapshot,
  ReviewStatus,
  ReviewStatusPeer,
  RoomId,
  SnapshotId,
  Thread,
} from '../types';

/**
 * Reactive review-session store. One global singleton; mounted by the bridge
 * callbacks in `App.svelte` and read by the right-rail / review components.
 *
 * Phase 2 (issue 4.2) layers typed `$derived` selectors over the append-only
 * event log and the resolver-update map. The selector bodies live in
 * `./selectors.ts` as plain functions; the runes here just keep them
 * up to date.
 */
export class ReviewStore {
  /** Whether the right-rail review panel is open. Driven by Cmd+J / toggle. */
  panelOpen = $state(false);

  /** Currently-focused review room, if any. */
  currentRoomId = $state<RoomId | null>(null);

  /**
   * File the panel/margin is scoped to. Driven by the active editor tab
   * via `setCurrentFile`. Empty result selectors when `null`.
   */
  currentFileId = $state<FileId | null>(null);

  /**
   * Snapshot the panel is locked to, if any. `null` means "all snapshots
   * for the current file." Driven by snapshot-picker UI in issue 4.9.
   */
  currentSnapshotId = $state<SnapshotId | null>(null);

  /** Latest transport status payload for `currentRoomId`. */
  status = $state<ReviewStatus | null>(null);

  /** Peer roster mirrored from `status.peers` for convenient binding. */
  peers = $state<ReviewStatusPeer[]>([]);

  /**
   * Append-only buffer of imported review events. The thread selectors
   * below reconstruct typed `Thread[]` from this.
   */
  events = $state<ReviewEvent[]>([]);

  /**
   * Snapshots imported via the bridge. The snapshot-picker UI (issue 4.9)
   * reads this to populate the dropdown.
   */
  snapshots = $state<ReviewSnapshot[]>([]);

  /**
   * Latest anchor-resolution result per `eventId`. The `ambiguousAnchors`
   * and `staleAnchors` selectors derive their orphan-tray rows from this.
   */
  anchorResolutions = $state<Record<string, ReviewAnchorResolutionUpdate>>({});

  /**
   * Local outbox (events authored here, awaiting acknowledgement). Stays
   * `unknown[]` until the Rust-side outbox-entry shape is exposed over the
   * bridge (issue 4.13). `outboxCount` reads `.length` only.
   */
  pendingOutbox = $state<unknown[]>([]);

  /**
   * Currently focused review event (click target from editor inline mark or
   * panel card). The decorations plugin applies the `is-focused` pulse
   * class, and the panel scrolls/pulses the matching card. Invariant: one
   * focused event at a time — see
   * `planning/collab/ui/inline-decorations.md` §4.
   */
  focusEventId = $state<EventId | null>(null);

  /**
   * Currently hovered review event for cross-surface highlight (editor mark
   * ↔ panel card border). Distinct from `focusEventId` because hover is
   * transient and does not scroll either surface.
   */
  hoveredEventId = $state<EventId | null>(null);

  /** Tiny reactivity probe — kept for the existing scaffold tests. */
  hasAnyEvent = $derived(this.events.length > 0);

  /**
   * Every comment-rooted thread in the log, ordered by root `createdAt`.
   * The downstream file/snapshot selectors filter this list.
   * @see selectors.reconstructThreads
   */
  threads: Thread[] = $derived(
    reconstructThreads(this.events, this.anchorResolutions),
  );

  /**
   * Threads scoped to `currentRoomId` + `currentFileId`. Empty when either
   * is unset. Drives the ReviewMargin card column (issue 4.3).
   */
  threadsForCurrentFile: Thread[] = $derived(
    threadsForFile(this.threads, this.currentRoomId, this.currentFileId),
  );

  /**
   * Threads further scoped to `currentSnapshotId`. Drives the
   * snapshot-locked view (issue 4.9).
   */
  threadsForCurrentSnapshot: Thread[] = $derived(
    threadsForSnapshot(
      this.threads,
      this.currentRoomId,
      this.currentFileId,
      this.currentSnapshotId,
    ),
  );

  /**
   * Rows for the orphan-tray ambiguous picker (issue 4.7). Each entry
   * carries the resolver-supplied candidate list so the picker can render
   * the two-up choice without re-running the resolver.
   */
  ambiguousAnchors: AmbiguousAnchorEntry[] = $derived(
    ambiguousAnchors(this.anchorResolutions),
  );

  /**
   * Rows for the stale-anchor strip (issue 4.8). The card collapses the
   * thread body and offers manual reanchor.
   */
  staleAnchors: StaleAnchorEntry[] = $derived(
    staleAnchors(this.anchorResolutions),
  );

  /**
   * Pending-outbound envelope count for the connection badge (issue 4.11)
   * and the offline-owner reviewer indicator (issue 4.13).
   */
  outboxCount: number = $derived(this.pendingOutbox.length);

  /**
   * Peer roster split into "on the latest snapshot" vs "older." Drives the
   * peer-strip color coding (issue 4.12).
   */
  peerSplit: PeerSplit = $derived(
    partitionPeersBySnapshot(this.peers, this.currentSnapshotId),
  );

  /**
   * Peers locked to the active snapshot. Sugar around `peerSplit`.
   */
  peersOnLatestSnapshot: ReviewStatusPeer[] = $derived(
    this.peerSplit.onLatestSnapshot,
  );

  /**
   * Peers still on an older snapshot (or with no snapshot id at all).
   * Sugar around `peerSplit`.
   */
  peersOnOlderSnapshot: ReviewStatusPeer[] = $derived(
    this.peerSplit.onOlderSnapshot,
  );

  /**
   * Unresolved-thread badge for the panel header (issue 4.3 chrome).
   */
  unresolvedThreadCount: number = $derived(
    unresolvedThreadCount(this.threadsForCurrentFile),
  );

  /**
   * Apply a transport/connection status payload pushed by Rust. Replaces the
   * current room context and peer roster.
   */
  applyStatus(status: ReviewStatus): void {
    this.currentRoomId = status.roomId;
    this.status = status;
    this.peers = status.peers;
  }

  /**
   * Append an imported review event. Phase 2 4.2 builds derived thread views
   * over this list; the scaffold just stores them in arrival order.
   */
  applyEvent(event: ReviewEvent): void {
    this.events = [...this.events, event];
  }

  /**
   * Record a newly imported snapshot. Placeholder until Phase 2 4.2 ties
   * snapshots into the resolver / panel selection model.
   */
  applySnapshot(snapshot: ReviewSnapshot): void {
    this.snapshots = [...this.snapshots, snapshot];
  }

  /**
   * Record the latest anchor-resolution result for a single event. Phase 2
   * 4.2 surfaces ambiguous candidates and stale chips from this map.
   */
  applyAnchorResolution(update: ReviewAnchorResolutionUpdate): void {
    this.anchorResolutions = {
      ...this.anchorResolutions,
      [update.eventId]: update,
    };
  }

  /** Toggle the right-rail review panel open/closed. */
  togglePanel(): void {
    this.panelOpen = !this.panelOpen;
  }

  /**
   * Point the panel at a different file. `null` clears the file scope and
   * collapses `threadsForCurrentFile` to an empty array. The snapshot
   * scope is cleared as a side-effect because snapshot ids are
   * file-relative.
   */
  setCurrentFile(fileId: FileId | null): void {
    this.currentFileId = fileId;
    this.currentSnapshotId = null;
  }

  /**
   * Lock the panel to a specific snapshot within the current file, or
   * `null` to show every snapshot. No-op when no file is active.
   */
  setCurrentSnapshot(snapshotId: SnapshotId | null): void {
    if (this.currentFileId === null) return;
    this.currentSnapshotId = snapshotId;
  }

  /**
   * Set the focused event (cross-surface click target). Pass `null` to
   * clear. Per `planning/collab/ui/inline-decorations.md` §4, only one
   * event is focused at a time, so setting this clears any prior pulse.
   */
  setFocusEventId(eventId: EventId | null): void {
    this.focusEventId = eventId;
  }

  /**
   * Set the hovered event id (editor ↔ panel link). Pass `null` to clear.
   */
  setHoveredEventId(eventId: EventId | null): void {
    this.hoveredEventId = eventId;
  }
}

/**
 * Process-wide review store singleton. Import this directly from components
 * or bridge wiring rather than constructing a new `ReviewStore`.
 */
export const reviewStore = new ReviewStore();
