// Review-domain global state holder.
//
// This file lives at `web/src/lib/review/store.svelte.ts` (not `.ts`) because
// Svelte 5 runes (`$state`, `$derived`) only compile outside components when
// the file extension is `.svelte.ts` (or `.svelte.js`). See
// `references/performance.md` of the svelte5-best-practices skill, and
// existing precedent in `web/src/lib/hooks/is-mobile.svelte.ts` and
// `web/src/lib/components/ui/sidebar/context.svelte.ts`.
//
// Phase 0c scaffold only: holds connection status, peer roster, panel-open
// flag, and append-only buffers for events / snapshot / anchor resolutions.
// Phase 2 (attn-nnj.4.2) layers typed derived selectors on top
// (comments-on-current-snapshot, ambiguous list, outbox count, etc.). Do not
// expand the body-shape unknowns into typed thread views here.

import type {
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ReviewSnapshot,
  ReviewStatus,
  ReviewStatusPeer,
  RoomId,
} from '../types';

/**
 * Reactive review-session store. One global singleton; mounted by the bridge
 * callbacks in `App.svelte` and read by the right-rail / review components.
 *
 * Intentionally minimal: Phase 2 issue 4.2 introduces typed thread/outbox
 * views and the derived selectors that drive the panel UI.
 */
export class ReviewStore {
  /** Whether the right-rail review panel is open. Driven by Cmd+J / toggle. */
  panelOpen = $state(false);

  /** Currently-focused review room, if any. */
  currentRoomId = $state<RoomId | null>(null);

  /** Latest transport status payload for `currentRoomId`. */
  status = $state<ReviewStatus | null>(null);

  /** Peer roster mirrored from `status.peers` for convenient binding. */
  peers = $state<ReviewStatusPeer[]>([]);

  /**
   * Append-only buffer of imported review events. Phase 2 4.2 derives typed
   * `ThreadView[]` from this; for the scaffold we keep the wire payloads.
   */
  events = $state<ReviewEvent[]>([]);

  /**
   * Snapshots imported via the bridge. Phase 2 4.2 wires snapshot selection /
   * resolution against this list; scaffold just records the latest payloads.
   */
  snapshots = $state<ReviewSnapshot[]>([]);

  /**
   * Latest anchor-resolution result per `eventId`. Phase 2 4.2 will render
   * ambiguous candidates and stale chips out of this map.
   */
  anchorResolutions = $state<Record<string, ReviewAnchorResolutionUpdate>>({});

  /**
   * Local outbox (events authored here, awaiting acknowledgement). Phase 2
   * 4.2 tightens this from `unknown[]` to a typed `OutboxEntry[]`.
   */
  pendingOutbox = $state<unknown[]>([]);

  /**
   * Derived flag used as a tiny end-to-end reactivity probe. Phase 2 4.2
   * replaces this with rich selectors (comments-on-current-snapshot, etc.).
   */
  hasAnyEvent = $derived(this.events.length > 0);

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
}

/**
 * Process-wide review store singleton. Import this directly from components
 * or bridge wiring rather than constructing a new `ReviewStore`.
 */
export const reviewStore = new ReviewStore();
