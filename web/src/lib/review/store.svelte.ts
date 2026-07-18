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

import { reviewResolveAnchor } from '../ipc';
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
import { userProfile } from '../profile.svelte';
import { computeRailMode, type RailMode } from './rail-mode';
import { shouldActivateRoomStatus, shouldForgetRoomStatus } from './room-ui';
import {
  isHydratedReviewSnapshot,
  isRenderableReviewSnapshot,
} from './snapshot-kind';
import { isThreadActive } from './thread-visibility';
import type {
  EventId,
  FileId,
  ParticipantId,
  PositionAnchor,
  RequiresThreeWayVerdict,
  ReviewAnchorResolutionUpdate,
  ReviewErrorStatus,
  ReviewEvent,
  ReviewSnapshot,
  ReviewStatus,
  ReviewStatusPeer,
  RoomId,
  SnapshotId,
  Thread,
} from '../types';

/**
 * Identifies which stale comment card (by root event id) is currently
 * awaiting a manual re-anchor from the user. The PM editor enters
 * select-text-in-editor mode while this is non-null; on next confirmed
 * selection the store emits a `reviewResolveAnchor` IPC and clears.
 *
 * Carrying the `roomId` here avoids an extra lookup at confirm time —
 * the stale resolution carries the same roomId, so we cache it when the
 * user enters the flow.
 *
 * @see planning/collab/amendments.md Decision #15
 */
export interface ManualReanchorState {
  eventId: EventId;
  roomId: RoomId;
}

interface PeerLocation {
  locationFileId?: FileId;
  locationSnapshotId?: SnapshotId;
  locationPath?: string;
  lastLocationAt: number;
}

export interface ReviewRoomSummary {
  roomId: RoomId;
  status?: string;
  role: 'owner' | 'reviewer' | 'unknown';
  connection: ReviewStatus['connection'];
  peers: ReviewStatusPeer[];
  outboxPending: number;
  share?: {
    roomId: RoomId;
    inviteUrl: string;
    browserInviteUrl: string;
    viewInviteUrl: string;
    suggestInviteUrl: string;
    browserViewInviteUrl: string;
    browserSuggestInviteUrl: string;
    ownerSigningKey: string;
    ownerDisplayPath: string;
    mode: 'live' | 'async' | 'hybrid';
    expiresAt: number;
  };
  updatedAt: number;
}

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

  /** Effective local directory grant. Legacy v2 and owners default suggest. */
  localGrantTier = $state<'comment' | 'suggest'>('suggest');
  private localGrantTiers = $state<Record<string, 'comment' | 'suggest'>>({});

  setLocalGrantTier(roomId: RoomId, tier: 'comment' | 'suggest'): void {
    this.localGrantTiers = { ...this.localGrantTiers, [roomId]: tier };
    if (this.currentRoomId === roomId) this.localGrantTier = tier;
  }

  /**
   * Rooms known to this webview. Resumed rooms live here passively until the
   * user picks one, so a normal file open is never replaced by review mode.
   */
  rooms = $state<Record<string, ReviewRoomSummary>>({});

  /** Native-owned durable unread counts, keyed by room. */
  unreadByRoom = $state<Record<string, number>>({});

  /** Native-owned persisted mute preferences, keyed by room. */
  notificationMutedByRoom = $state<Record<string, boolean>>({});

  currentRoomUnread: number = $derived(
    this.currentRoomId === null ? 0 : (this.unreadByRoom[this.currentRoomId] ?? 0),
  );

  totalUnread: number = $derived(
    Object.values(this.unreadByRoom).reduce((sum, count) => sum + count, 0),
  );

  currentRoomNotificationMuted: boolean = $derived(
    this.currentRoomId === null ? false : (this.notificationMutedByRoom[this.currentRoomId] ?? false),
  );

  applyNotificationMute(payload: { roomId: RoomId; muted: boolean }): void {
    this.notificationMutedByRoom = {
      ...this.notificationMutedByRoom,
      [payload.roomId]: payload.muted,
    };
  }

  unreadForRoom(roomId: RoomId): number {
    return this.unreadByRoom[roomId] ?? 0;
  }

  applyUnread(payload: { roomId: RoomId; unreadCount: number }): void {
    const count = Math.max(0, Math.floor(payload.unreadCount));
    this.unreadByRoom = { ...this.unreadByRoom, [payload.roomId]: count };
    this.upsertRoom(payload.roomId, {});
  }

  roomsList: ReviewRoomSummary[] = $derived.by(() =>
    Object.values(this.rooms).sort((a, b) => b.updatedAt - a.updatedAt),
  );

  activeRoom: ReviewRoomSummary | null = $derived.by(() =>
    this.currentRoomId !== null ? (this.rooms[this.currentRoomId] ?? null) : null,
  );

  dismissedRoomIds = $state<Set<RoomId>>(new Set<RoomId>());

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

  /** Latest review command failure, used by transient surfaces like Share. */
  lastError = $state<(ReviewErrorStatus & { updatedAt: number }) | null>(null);

  /**
   * Live transport connection state for the connection badge. The
   * `RoomStatusChanged` wire variant only carries a status *string* (no
   * structured `connection` field), so the badge can't read it from
   * `status`. We drive this directly from the presence path instead: a
   * relay `hello`/`presence` frame is proof we're subscribed to the mailbox
   * transport. WebRTC upgrade (`live_direct`) lands with the live-channel
   * work; until then a connected room is `mailbox`.
   */
  connection = $state<ReviewStatus['connection']>('offline');

  /** Peer roster mirrored from `status.peers` for convenient binding. */
  peers = $state<ReviewStatusPeer[]>([]);

  /** Transient live-view locations learned from encrypted cursor signals. */
  peerLocations = $state<Record<string, PeerLocation>>({});

  /**
   * Active share for `currentRoomId` — the invite URL and verify-key fingerprint
   * input the ShareDialog renders. Populated by `applyShareReady` when the
   * daemon emits the rich post-share payload. Cleared if the room is closed.
   */
  currentShare = $state<{
    roomId: RoomId;
    inviteUrl: string;
    browserInviteUrl: string;
    viewInviteUrl: string;
    suggestInviteUrl: string;
    browserViewInviteUrl: string;
    browserSuggestInviteUrl: string;
    ownerSigningKey: string;
    ownerDisplayPath: string;
    mode: 'live' | 'async' | 'hybrid';
    expiresAt: number;
  } | null>(null);

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
   * Thread ids the user dismissed optimistically (Resolve clicked and the
   * `CommentResolved` echo not yet landed, or Reject which is UI-only).
   * Lives on the store — not in `ReviewMargin` — so `railMode` slims in
   * the same tick the last active card is dismissed. Same immutable-Set
   * pattern as `discardedStale`. Survives panel remounts for the session
   * (intended); cleared with the room in `forgetRoom`.
   */
  locallyDismissed = $state<Set<string>>(new Set<string>());

  /**
   * Resolved thread currently expanded to a full read-only card in the
   * margin (attn-d7y). One at a time, like `threeWayApply`. Forces
   * `railMode` to `full` while set.
   */
  expandedResolvedThreadId = $state<string | null>(null);

  /**
   * Self-healing view of `expandedResolvedThreadId`: a stale id (thread
   * gone, file switched, or thread no longer resolved) degrades to `null`
   * so downstream consumers never render an orphaned card.
   */
  expandedResolvedThread: Thread | null = $derived.by(() => {
    const id = this.expandedResolvedThreadId;
    if (id === null) return null;
    return this.threadsForCurrentFile.find((t) => t.id === id && t.resolved) ?? null;
  });

  /** Active (unresolved, not locally dismissed) threads in the margin. */
  marginActiveThreadCount: number = $derived(
    this.threadsForCurrentFile.filter((t) => isThreadActive(t, this.locallyDismissed)).length,
  );

  /** Resolved threads in the margin (rendered as chips). */
  marginResolvedThreadCount: number = $derived(
    this.threadsForCurrentFile.filter((t) => t.resolved).length,
  );

  /**
   * Rail display mode: `hidden` | `collapsed` | `expanded`. In a review
   * room the rail is always at least a collapsed gutter; `panelOpen`
   * (ReviewBar toggle / Cmd+J) expands it. `App.svelte` maps this to the
   * aside width; `ReviewMargin` maps it to the chip variant. See
   * `./rail-mode.ts` for the rule.
   */
  railMode: RailMode = $derived(computeRailMode({
    inReviewRoom: this.currentRoomId !== null,
    panelOpen: this.panelOpen,
  }));

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
   * The room owner's participantId, learned from the authoritative snapshot
   * author (the owner publishes the initial snapshot, so its author is the
   * owner). This is reliable on every participant — unlike the local room
   * record's `createdBy`, which the join flow doesn't populate with the
   * owner's id on a reviewer. `null` until the first snapshot arrives.
   */
  ownerParticipantId: ParticipantId | null = $derived.by(() => {
    let earliest: ReviewSnapshot | null = null;
    for (const snap of this.snapshots) {
      if (this.currentRoomId !== null && snap.roomId !== this.currentRoomId) continue;
      if (earliest === null || snap.createdAt < earliest.createdAt) {
        earliest = snap;
      }
    }
    return earliest?.createdBy ?? null;
  });

  /**
   * participantId → human display name, harvested from imported
   * `ParticipantJoined` events. This is the authoritative name source: relay
   * presence frames only carry the kind label ("Reviewer"/"Agent"), so comment
   * authors and carets must resolve here first to show the real name.
   */
  participantNames: Record<string, string> = $derived.by(() => {
    const names: Record<string, string> = {};
    // Latest by authored time, NOT array order: `events` is arrival-ordered,
    // and relay history replays after a reconnecting session's fresh
    // re-announce — array order would resurrect a stale name (attn-sur).
    const namedAt: Record<string, number> = {};
    for (const ev of this.events) {
      // Scope to the active room — without this, same-named ids from a
      // previous room in the buffer could bleed names across rooms.
      if (this.currentRoomId !== null && ev.meta.roomId !== this.currentRoomId) continue;
      if (ev.body.type === 'participant_joined') {
        const p = ev.body.participant;
        const name = p.displayName?.trim();
        if (name && (namedAt[p.participantId] ?? -1) <= ev.meta.createdAt) {
          names[p.participantId] = name;
          namedAt[p.participantId] = ev.meta.createdAt;
        }
      }
    }
    return names;
  });

  /**
   * participantId → kind, harvested from `ParticipantJoined` events
   * (room-scoped like `participantNames`). Memoized as a derived map —
   * `participantKindFor` is called several times per thread per layout
   * pass, so an O(events) scan per call would compound.
   */
  participantKinds: Record<string, 'owner' | 'reviewer' | 'agent'> = $derived.by(() => {
    const kinds: Record<string, 'owner' | 'reviewer' | 'agent'> = {};
    for (const ev of this.events) {
      if (this.currentRoomId !== null && ev.meta.roomId !== this.currentRoomId) continue;
      if (ev.body.type === 'participant_joined') {
        const p = ev.body.participant;
        kinds[p.participantId] = p.kind;
      }
    }
    return kinds;
  });

  /**
   * participantId → kind, from `ParticipantJoined` events first, then the
   * presence roster, with the snapshot-derived owner id always winning.
   * Drives the per-author card border color + avatar chips (attn-42y) via
   * the existing `--peer-avatar-bg-*` tokens, so cards match the caret
   * and peer-chip colors.
   */
  participantKindFor(participantId: string): 'owner' | 'reviewer' | 'agent' {
    if (participantId === this.ownerParticipantId) return 'owner';
    const fromEvents = this.participantKinds[participantId];
    if (fromEvents) return fromEvents;
    const peer = this.peersResolved.find((p) => p.participantId === participantId);
    return peer?.kind ?? 'reviewer';
  }

  /**
   * Best display name for a participant id: the real name from a
   * `ParticipantJoined` event, then the presence roster label, then —
   * for the owner — the local profile name or role label, then the raw id.
   */
  displayNameFor(participantId: string): string {
    const fromEvents = this.participantNames[participantId];
    if (fromEvents) return fromEvents;
    const peer = this.peers.find((p) => p.participantId === participantId);
    if (peer?.displayName) return peer.displayName;
    // Rooms shared before the owner self-announce landed (attn-42y) have
    // no ParticipantJoined for the owner, and presence excludes self — so
    // owner-authored threads used to degrade to the raw participant id.
    // On the owner's own window we know the profile name; elsewhere the
    // role label still beats an opaque id.
    if (participantId === this.ownerParticipantId) {
      return this.activeRoom?.role === 'owner' ? userProfile.effectiveName : 'Owner';
    }
    return participantId;
  }

  /**
   * Peer roster with the owner chip's role corrected from the snapshot
   * author. The Rust presence forwarder can't always tag the owner (it
   * derives from the unreliable local room record), so we promote the
   * matching peer to `owner` here — warm color + `O` monogram. Reactive:
   * re-runs when the snapshot arrives, re-coloring the chip live. PeerStrip
   * binds to this instead of the raw `peers`.
   */
  peersResolved: ReviewStatusPeer[] = $derived.by(() => {
    const owner = this.ownerParticipantId;
    return this.peers.map((peer) =>
      this.resolvePeerLocation(
        owner !== null && peer.participantId === owner && peer.kind !== 'owner'
          ? { ...peer, kind: 'owner', displayName: 'Owner' }
          : peer,
      ),
    );
  });

  /**
   * Unresolved-thread badge for the panel header (issue 4.3 chrome).
   */
  unresolvedThreadCount: number = $derived(
    unresolvedThreadCount(this.threadsForCurrentFile),
  );

  /**
   * Apply a transport/connection status payload pushed by Rust. Joined/Live
   * statuses activate the room; anything else only populates the switcher.
   * Daemon-resumed rooms arrive role-accurately as Live (we shared it) or
   * Joined (we joined it) so a restarted reviewer re-enters the shared-doc
   * view (attn-6dd); owners never flip regardless (role gate in room-ui).
   */
  applyStatus(status: ReviewStatus): void {
    const roomId = status.roomId;
    if (!roomId) return;
    const lifecycle = status.status;

    if (shouldForgetRoomStatus(lifecycle)) {
      this.forgetRoom(roomId);
      return;
    }
    if (shouldActivateRoomStatus(lifecycle)) {
      const nextDismissed = new Set(this.dismissedRoomIds);
      nextDismissed.delete(roomId);
      this.dismissedRoomIds = nextDismissed;
    } else if (this.dismissedRoomIds.has(roomId)) {
      return;
    }

    const existing = this.rooms[roomId];
    const role =
      lifecycle === 'Live'
        ? 'owner'
        : lifecycle === 'Joined'
          ? 'reviewer'
          : (existing?.role ?? 'unknown');
    const connection = status.connection ?? existing?.connection ?? 'offline';
    const peers = status.peers ?? existing?.peers ?? [];
    const outboxPending =
      status.outboxPending ?? status.pendingCount ?? existing?.outboxPending ?? 0;

    this.upsertRoom(roomId, {
      status: lifecycle ?? existing?.status,
      role,
      connection,
      peers,
      outboxPending,
    });

    if (shouldActivateRoomStatus(lifecycle)) {
      this.selectRoom(roomId);
      return;
    }

    if (this.currentRoomId === roomId) {
      this.status = status;
      this.connection = connection;
      this.peers = peers;
    }
  }

  applyError(error: ReviewErrorStatus): void {
    this.lastError = {
      ...error,
      updatedAt: Date.now(),
    };
  }

  clearLastError(): void {
    this.lastError = null;
  }

  /**
   * Apply a live presence delta pushed by Rust over `reviewPresence`.
   *
   * The daemon's event forwarder translates relay `hello` (full roster on
   * (re)connect) and `presence` (single join/leave) frames into this shape.
   * `replace=true` is authoritative — it overwrites the whole roster.
   * `replace=false` is a delta: an online peer is upserted (keyed by
   * `deviceId`), an offline peer (a leave) is dropped so its chip vanishes.
   */
  applyPresence(payload: {
    roomId: RoomId;
    peers: ReviewStatusPeer[];
    replace: boolean;
  }): void {
    const existingPeers = this.rooms[payload.roomId]?.peers ?? [];
    let nextPeers: ReviewStatusPeer[];
    if (payload.replace) {
      nextPeers = payload.peers;
    } else {
      const byDevice = new Map(existingPeers.map((p) => [p.deviceId, p]));
      for (const peer of payload.peers) {
        if (peer.online) {
          byDevice.set(peer.deviceId, peer);
        } else {
          byDevice.delete(peer.deviceId);
        }
      }
      nextPeers = [...byDevice.values()];
    }
    this.upsertRoom(payload.roomId, { peers: nextPeers });
    if (this.currentRoomId !== payload.roomId) return;

    this.peers = nextPeers;
    if (payload.replace) {
      const liveDevices = new Set(nextPeers.filter((p) => p.online).map((p) => p.deviceId));
      this.peerLocations = Object.fromEntries(
        Object.entries(this.peerLocations).filter(([deviceId]) => liveDevices.has(deviceId)),
      );
      return;
    }
    for (const peer of payload.peers) {
      if (!peer.online) {
        const { [peer.deviceId]: _removed, ...rest } = this.peerLocations;
        this.peerLocations = rest;
      }
    }
  }

  /**
   * Apply a live transport connection-state change pushed by Rust over
   * `reviewConnection`. The daemon emits `mailbox` when the relay socket
   * subscribes (a `hello` frame) and `offline` when it disconnects. Drives
   * the ShareChip. On going offline we also clear the peer roster —
   * we can't know who's still present once our socket is gone.
   */
  applyConnection(payload: {
    roomId: RoomId;
    connection: ReviewStatus['connection'];
  }): void {
    this.upsertRoom(payload.roomId, {
      connection: payload.connection,
      ...(payload.connection === 'offline' ? { peers: [] } : {}),
    });
    if (this.currentRoomId !== payload.roomId) return;

    this.connection = payload.connection;
    // Keep the active full-status object's connection in sync. The
    // ShareChip reads `status?.connection ?? connection`, and selectRoom
    // seeds `status.connection` from the room's connection at selection time —
    // typically 'offline', before any peer connects. Without this sync a later
    // mailbox/live_direct update lands on `this.connection` but the badge keeps
    // reading the stale `status.connection` and shows Offline forever even
    // though the WebRTC DataChannel is live (attn-j5m).
    if (this.status !== null) {
      this.status = { ...this.status, connection: payload.connection };
    }
    if (payload.connection === 'offline') {
      this.peers = [];
    }
  }

  /**
   * Hydrate the active-share view-state from the daemon's
   * `ReviewUpdate::ShareReady` payload. Sets `currentRoomId` so the
   * ReviewBar becomes visible and stores the invite + signing key so the
   * Share dialog can render the URL and fingerprint reactively.
   */
  applyShareReady(payload: {
    roomId: RoomId;
    inviteUrl: string;
    browserInviteUrl: string;
    viewInviteUrl: string;
    suggestInviteUrl: string;
    browserViewInviteUrl: string;
    browserSuggestInviteUrl: string;
    ownerDisplayPath: string;
    ownerSigningKey: string;
    mode: 'live' | 'async' | 'hybrid';
    expiresAt: number;
  }): void {
    this.clearLastError();
    const nextDismissed = new Set(this.dismissedRoomIds);
    nextDismissed.delete(payload.roomId);
    this.dismissedRoomIds = nextDismissed;
    // `ownerDisplayPath` is the path the daemon actually shared, carried on the
    // ShareReady payload — so the dialog's shareTargetMatches gate works for any
    // share (GUI or `attn review share`) without a frontend-captured intent.
    const share = {
      roomId: payload.roomId,
      inviteUrl: payload.inviteUrl,
      browserInviteUrl: payload.browserInviteUrl,
      viewInviteUrl: payload.viewInviteUrl,
      suggestInviteUrl: payload.suggestInviteUrl,
      browserViewInviteUrl: payload.browserViewInviteUrl,
      browserSuggestInviteUrl: payload.browserSuggestInviteUrl,
      ownerSigningKey: payload.ownerSigningKey,
      ownerDisplayPath: payload.ownerDisplayPath,
      mode: payload.mode,
      expiresAt: payload.expiresAt,
    };
    this.upsertRoom(payload.roomId, {
      status: 'Live',
      role: 'owner',
      share,
    });
    this.selectRoom(payload.roomId);
  }

  /**
   * Append an imported review event. Phase 2 4.2 builds derived thread views
   * over this list; the scaffold just stores them in arrival order.
   *
   * `SnapshotCreated` events carry the document bytes inline (the owner's
   * snapshot the reviewer needs to render). We mirror those into the
   * `snapshots` view here so the editor can pick up the markdown without a
   * separate `reviewSnapshot` callback — the daemon delivers snapshots as
   * regular events over the encrypted channel, not via a distinct IPC.
   */
  applyEvent(event: ReviewEvent): void {
    // De-dupe by eventId. The author of an event receives it TWICE — once as
    // the immediate local echo, and again when the relay broadcasts the
    // author's own posted envelope back over the websocket (a reconnect can
    // also replay it). The Rust side delivers the double on purpose and relies
    // on this frontend dedup (manager.rs / bootstrap.rs). Without it every owner
    // comment/reply duplicated into a phantom reply (== the root body).
    if (
      this.events.some(
        (e) => e.meta.roomId === event.meta.roomId && e.meta.eventId === event.meta.eventId,
      )
    ) {
      return;
    }
    this.events = [...this.events, event];
    this.upsertRoom(event.meta.roomId, {});

    if (event.body.type === 'snapshot_created') {
      const body = event.body;
      const inline = body.inlineSnapshot;
      const document = inline?.docType === 'markdown' || inline?.docType === 'html' ? inline : undefined;
      // BrowserSession authenticates inert payloads through applySnapshot.
      // Do not mirror inline assets/manifests from the event body here: a
      // manifest may be waiting for referenced R2 entries, and exposing it
      // now would bypass that binding gate. Content-less pointer events still
      // create the placeholder that a later authenticated blob replaces.
      if (inline != null && document === undefined) return;
      const snapshot: ReviewSnapshot = {
        roomId: event.meta.roomId,
        fileId: body.fileId,
        snapshotId: body.snapshotId,
        ownerDisplayPath: body.ownerDisplayPath,
        parentSnapshotId: body.parentSnapshotId,
        createdAt: event.meta.createdAt,
        createdBy: event.meta.authorId,
        baseHash: body.baseHash,
        byteLength: document ? new TextEncoder().encode(document.content).length : 0,
        docType: inline?.docType,
        content: document?.content,
        anchorIndex: document?.docType === 'markdown' ? document.anchorIndex : undefined,
        mediaType: inline?.docType === 'asset' ? inline.mediaType : undefined,
        workspaceManifest:
          inline?.docType === 'workspace_manifest' ? inline.manifest : undefined,
        encryptedBlobRef: body.encryptedBlobRef,
      };
      // De-dupe by snapshotId — the relay echoes the owner's own snapshot
      // back to them, and a reconnect can replay it.
      if (
        !this.snapshots.some(
          (s) => s.roomId === snapshot.roomId && s.snapshotId === snapshot.snapshotId,
        )
      ) {
        this.snapshots = [...this.snapshots, snapshot];
      }
      // Auto-focus the file the snapshot belongs to when nothing is
      // selected yet — this is what makes the reviewer's editor switch
      // from "their local files" to "the shared doc" on first snapshot.
      if (
        document !== undefined &&
        this.currentRoomId === event.meta.roomId &&
        this.currentFileId === null
      ) {
        this.currentFileId = body.fileId;
      }
    }
  }

  /**
   * Record a newly imported snapshot. Placeholder until Phase 2 4.2 ties
   * snapshots into the resolver / panel selection model.
   */
  applySnapshot(snapshot: ReviewSnapshot): void {
    const existingIndex = this.snapshots.findIndex(
      (item) => item.roomId === snapshot.roomId && item.snapshotId === snapshot.snapshotId,
    );
    if (existingIndex >= 0) {
      const existing = this.snapshots[existingIndex]!;
      // Pointer events intentionally create a content-less placeholder before
      // the separately delivered mailbox/R2 blob arrives. Replace only that
      // exact authenticated placeholder; ordinary duplicate replays stay
      // idempotent and conflicting snapshot identities are never merged.
      if (
        !isHydratedReviewSnapshot(existing) &&
        isHydratedReviewSnapshot(snapshot) &&
        existing.fileId === snapshot.fileId &&
        existing.baseHash === snapshot.baseHash
      ) {
        const next = [...this.snapshots];
        // The pointer event is the only carrier of presentation metadata like
        // ownerDisplayPath; a hydrated blob that omits it must not erase it.
        next[existingIndex] = {
          ...snapshot,
          ownerDisplayPath: snapshot.ownerDisplayPath ?? existing.ownerDisplayPath,
        };
        this.snapshots = next;
      }
      return;
    }
    this.snapshots = [...this.snapshots, snapshot];
    this.upsertRoom(snapshot.roomId, {});
    if (
      isRenderableReviewSnapshot(snapshot) &&
      this.currentRoomId === snapshot.roomId &&
      this.currentFileId === null
    ) {
      this.currentFileId = snapshot.fileId;
    }
  }

  notePeerLocation(
    deviceId: string,
    location: {
      fileId?: FileId;
      snapshotId?: SnapshotId;
      path?: string;
    },
  ): void {
    if (!deviceId) return;
    const path = location.path?.trim();
    this.peerLocations = {
      ...this.peerLocations,
      [deviceId]: {
        locationFileId: location.fileId,
        locationSnapshotId: location.snapshotId,
        locationPath: path && path.length > 0 ? path : undefined,
        lastLocationAt: Date.now(),
      },
    };
  }

  private resolvePeerLocation(peer: ReviewStatusPeer): ReviewStatusPeer {
    const location = this.peerLocations[peer.deviceId];
    if (location === undefined) return peer;
    return {
      ...peer,
      locationFileId: location.locationFileId,
      locationSnapshotId: location.locationSnapshotId,
      locationPath: location.locationPath,
      lastLocationAt: location.lastLocationAt,
      onSnapshotId: location.locationSnapshotId ?? peer.onSnapshotId,
    };
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
    if (!this.panelOpen) {
      // Collapsing the rail returns any expanded resolved card to its chip
      // and cancels an in-flight manual reanchor — both flows render their
      // UI only in the expanded rail, but their window-level capture key
      // handlers in ReviewMargin would otherwise stay armed invisibly
      // (Escape swallowed app-wide; Enter silently confirming a reanchor).
      this.expandedResolvedThreadId = null;
      this.manualReanchorState = null;
    }
  }

  /**
   * Point the panel at a different file. `null` clears the file scope and
   * collapses `threadsForCurrentFile` to an empty array. The snapshot
   * scope is cleared as a side-effect because snapshot ids are
   * file-relative.
   */
  setCurrentFile(fileId: FileId | null): void {
    if (fileId !== null && this.currentRoomId !== null) {
      const known = this.snapshots.filter(
        (snapshot) =>
          snapshot.roomId === this.currentRoomId && snapshot.fileId === fileId,
      );
      if (known.length > 0 && !known.some(isRenderableReviewSnapshot)) return;
    }
    this.currentFileId = fileId;
    this.currentSnapshotId = null;
    this.expandedResolvedThreadId = null;
  }

  /**
   * Optimistically hide a thread's margin card (Resolve clicked, or
   * UI-only Reject). The thread stays in the event log; this only drives
   * `isThreadActive` filtering and the `railMode` derivation.
   */
  dismissThreadLocally(threadId: string): void {
    if (this.locallyDismissed.has(threadId)) return;
    const next = new Set(this.locallyDismissed);
    next.add(threadId);
    this.locallyDismissed = next;
  }

  /** Expand a resolved thread's chip into its full read-only card. Also
   *  expands the rail itself — clicking a chip in the collapsed gutter
   *  must surface the card, not expand it into 48px of hidden space. */
  expandResolvedThread(threadId: string): void {
    this.expandedResolvedThreadId = threadId;
    this.panelOpen = true;
  }

  /** Collapse the expanded resolved card back to its chip. */
  collapseResolvedThread(): void {
    this.expandedResolvedThreadId = null;
  }

  /**
   * Lock the panel to a specific snapshot within the current file, or
   * `null` to show every snapshot. No-op when no file is active.
   */
  setCurrentSnapshot(snapshotId: SnapshotId | null): void {
    if (this.currentFileId === null) return;
    if (snapshotId !== null) {
      const known = this.snapshots.find(
        (snapshot) =>
          snapshot.roomId === this.currentRoomId && snapshot.snapshotId === snapshotId,
      );
      if (known !== undefined && !isRenderableReviewSnapshot(known)) return;
    }
    this.currentSnapshotId = snapshotId;
  }

  /** Select a locally known room. Returns false without mutation until room
   * hydration has upserted it (used by native notification deep links). */
  selectRoom(roomId: RoomId): boolean {
    const room = this.rooms[roomId];
    if (room === undefined) return false;
    this.currentRoomId = roomId;
    this.localGrantTier = this.localGrantTiers[roomId] ?? 'suggest';
    this.currentShare = room.share ?? null;
    this.connection = room.connection;
    this.peers = room.peers;
    this.status = {
      roomId,
      status: room.status,
      mode: room.share?.mode ?? 'live',
      connection: room.connection,
      peers: room.peers,
      outboxPending: room.outboxPending,
    };

    const currentFileStillExists =
      this.currentFileId !== null
      && this.snapshots.some(
        (s) =>
          s.roomId === roomId &&
          s.fileId === this.currentFileId &&
          isRenderableReviewSnapshot(s),
      );
    if (!currentFileStillExists) {
      let latest: ReviewSnapshot | null = null;
      for (const snapshot of this.snapshots) {
        if (snapshot.roomId !== roomId || !isRenderableReviewSnapshot(snapshot)) continue;
        if (latest === null || snapshot.createdAt > latest.createdAt) {
          latest = snapshot;
        }
      }
      this.currentFileId = latest?.fileId ?? null;
    }
    this.currentSnapshotId = null;
    this.expandedResolvedThreadId = null;
    return true;
  }

  /**
   * Stop presenting one room without forgetting its durable local state.
   * Owners call this when focus moves to an unshared file: rooms, snapshots,
   * events, and unread counts remain available for focus-following navigation.
   */
  clearRoomSelection(): void {
    if (this.currentRoomId === null) return;
    this.pendingOutbox = [];
    this.currentRoomId = null;
    this.localGrantTier = 'suggest';
    this.currentShare = null;
    this.currentFileId = null;
    this.currentSnapshotId = null;
    this.status = null;
    this.connection = 'offline';
    this.peers = [];
    this.peerLocations = {};
    this.focusEventId = null;
    this.hoveredEventId = null;
    this.panelOpen = false;
    this.locallyDismissed = new Set<string>();
    this.expandedResolvedThreadId = null;
  }

  leaveRoom(roomId: RoomId): void {
    this.forgetRoom(roomId);
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

  /**
   * The currently-open 3-way apply card (per 10.4 inline-expand). null when
   * no card is open. Setting this opens the overlay; clearing dismisses it.
   * Only one card may be open at a time across the margin.
   */
  activeThreeWayApply = $state<RequiresThreeWayVerdict | null>(null);

  openThreeWayApply(verdict: RequiresThreeWayVerdict): void {
    this.activeThreeWayApply = verdict;
  }

  clearThreeWayApply(): void {
    this.activeThreeWayApply = null;
  }

  /**
   * Identifies which stale comment is currently in "pick a new anchor"
   * mode. `null` means no stale card is awaiting a selection. Only one
   * stale card may be in flight at a time — entering the flow from a
   * second card replaces the first. See attn-nnj.4.8.
   */
  manualReanchorState = $state<ManualReanchorState | null>(null);

  /**
   * IDs of stale comments the user has chosen to discard (panel-only
   * dismissal — does not remove the underlying thread, just hides the
   * stale card from the orphan tray). Mirrors the `locallyDismissed`
   * UX-only pattern already used by ReviewMargin for reject/resolve.
   */
  discardedStale = $state<Set<EventId>>(new Set<EventId>());

  /**
   * Enter manual-reanchor mode for `eventId`. The caller is expected to
   * supply the room id from the stale resolution (the store doesn't
   * search for it). Replaces any in-flight reanchor state.
   */
  enterManualReanchor(eventId: EventId, roomId: RoomId): void {
    this.manualReanchorState = { eventId, roomId };
  }

  /**
   * Confirm the user-built anchor for the currently-active stale card.
   * Emits a `reviewResolveAnchor` IPC and clears the local state. The
   * resolver round-trip will flip the status away from `stale`, which
   * naturally removes the card from the orphan tray.
   *
   * No-op when no card is in flight.
   */
  confirmManualReanchor(positionAnchor: PositionAnchor): void {
    const state = this.manualReanchorState;
    if (!state) return;
    void reviewResolveAnchor(state.roomId, state.eventId, positionAnchor);
    this.manualReanchorState = null;
  }

  /**
   * Cancel manual-reanchor without emitting IPC. Used by Escape, by
   * clicking outside the editor selection target, or by switching to a
   * different stale card.
   */
  cancelManualReanchor(): void {
    this.manualReanchorState = null;
  }

  /**
   * Hide a stale card from the orphan tray without re-anchoring. The
   * card remains in the event log; this is purely a UX dismissal so the
   * tray doesn't grow unbounded with un-actionable stale rows.
   */
  discardStaleCard(eventId: EventId): void {
    if (this.discardedStale.has(eventId)) return;
    const next = new Set(this.discardedStale);
    next.add(eventId);
    this.discardedStale = next;
    // Clear any in-flight reanchor on the same card.
    if (this.manualReanchorState?.eventId === eventId) {
      this.manualReanchorState = null;
    }
  }

  private upsertRoom(
    roomId: RoomId,
    patch: Partial<Omit<ReviewRoomSummary, 'roomId' | 'updatedAt'>>,
  ): ReviewRoomSummary {
    if (this.dismissedRoomIds.has(roomId)) {
      return this.rooms[roomId] ?? {
        roomId,
        role: 'unknown',
        connection: 'offline',
        peers: [],
        outboxPending: 0,
        updatedAt: Date.now(),
      };
    }
    const existing = this.rooms[roomId];
    const next: ReviewRoomSummary = {
      roomId,
      status: existing?.status,
      role: existing?.role ?? 'unknown',
      connection: existing?.connection ?? 'offline',
      peers: existing?.peers ?? [],
      outboxPending: existing?.outboxPending ?? 0,
      share: existing?.share,
      ...patch,
      updatedAt: Date.now(),
    };
    this.rooms = {
      ...this.rooms,
      [roomId]: next,
    };
    return next;
  }

  private forgetRoom(roomId: RoomId): void {
    const dismissed = new Set(this.dismissedRoomIds);
    dismissed.add(roomId);
    this.dismissedRoomIds = dismissed;
    const { [roomId]: _removed, ...rest } = this.rooms;
    this.rooms = rest;
    const { [roomId]: _grant, ...remainingGrantTiers } = this.localGrantTiers;
    this.localGrantTiers = remainingGrantTiers;
    const { [roomId]: _unread, ...remainingUnread } = this.unreadByRoom;
    this.unreadByRoom = remainingUnread;
    this.events = this.events.filter((event) => event.meta.roomId !== roomId);
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.roomId !== roomId);
    this.anchorResolutions = Object.fromEntries(
      Object.entries(this.anchorResolutions).filter(([, update]) => update.roomId !== roomId),
    );
    if (this.currentRoomId !== roomId) return;
    this.clearRoomSelection();
  }
}

/**
 * Process-wide review store singleton. Import this directly from components
 * or bridge wiring rather than constructing a new `ReviewStore`.
 */
export const reviewStore = new ReviewStore();
