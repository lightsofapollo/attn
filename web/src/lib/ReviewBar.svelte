<!--
  Compact review dock.

  This started as a dedicated 36 px review-bar row. User feedback from the
  marketing hero pass made that feel too heavy: "Sharing / Connected /
  Snapshot current" was claiming a full strip of chrome before the document
  itself. The dock now overlays the breadcrumb line with the same testable
  slots, but the visible surface is icon + avatar driven.

  Share status lives in a single control (ShareChip): what is shared, the
  connection state, the people here, and the management actions all hang off
  one chip + one popover. Owners get the "Sharing · scope" variant with a
  Manage action; reviewers get the status word.

  Visibility: the row mounts when a room is active, a remembered room can be
  selected, OR the share dialog is open (`shareOpen` prop, parent-controlled).
  The latter means "share is being initiated" — the row should appear so the
  user has spatial anchoring while the modal is up.

  Reviewer asymmetry (§4 of the design): rendering of the Share slot follows
  "slot collapse, not visibility hide" — when an `isOwner` prop is false the
  slot is omitted entirely so the row reflows without a reserved gap. The
  prop defaults to `true` because the only caller today is the owner-only
  share initiation path; reviewer wiring lands with the connection badge in
  4.11.
-->

<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import LogOut from '@lucide/svelte/icons/log-out';
  import OutboxIndicator from './OutboxIndicator.svelte';
  import PeerStrip from './PeerStrip.svelte';
  import ShareChip from './ShareChip.svelte';
  import SnapshotBadge from './SnapshotBadge.svelte';
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from '$lib/components/ui/dropdown-menu';
  import { roomDisplayName, shortRoomId } from './review/room-ui';
  import { reviewStore } from './review/store.svelte';
  import type { ParticipantId, ReviewStatusPeer, RoomId } from './types';
  import UnreadBadge from './UnreadBadge.svelte';

  interface Props {
    /** Whether the share dialog is currently open (forces the row visible). */
    shareOpen?: boolean;
    /** True when the current device is the room owner. Defaults true. */
    isOwner?: boolean;
    /** Click handler for the Share pill — opens ShareDialog (parent owned). */
    onShareClick?: () => void;
    /** Stop/leave the active room in the daemon. */
    onLeaveRoom?: (roomId: RoomId) => void;
    /**
     * Click handler for the connection badge's [retry direct] button. 4.13
     * wires this into a `reviewReconnect` IPC; today the parent owns the
     * side-effect so the chrome stays presentational.
     */
    onReconnect?: () => void;
    /**
     * Click handler for the outbox indicator's `[Retry now]` button. Will be
     * wired to a future `reviewPull` IPC; parent owns the side-effect today
     * so this component stays presentational. See attn-nnj.4.13.
     */
    onOutboxRetry?: () => void;
    /** CSS right offset in px. Negative values let the parent span side rails. */
    rightOffsetPx?: number;
    /**
     * Reports the dock's rendered width so the header can seat neighboring
     * chips flush against it instead of reserving a fixed worst-case inset
     * (the fixed 328px reservation left a gulf between the save chip and
     * the Sharing cluster — user report).
     */
    onDockWidth?: (px: number) => void;
    /**
     * The local participant's id, surfaced from the daemon's identity
     * bootstrap. Passed through to PeerStrip so the matching chip carries
     * a `(you)` label. `null` until the bridge populates it.
     */
    localParticipantId?: ParticipantId | null;
    /**
     * Jump the local user to a peer's location (attn-qs03), threaded through to
     * PeerStrip. When provided, an online peer's chip navigates to their file +
     * caret instead of opening the identity card. Owner surfaces wire this to
     * their file-switch + scroll path.
     */
    onJumpTo?: (peer: ReviewStatusPeer) => void;
    /**
     * Show the comments show/hide button in the dock (hosted owner surface).
     * The reviewer page carries the same affordance in its own header. Native
     * and hosted owner headers opt in so every surface uses the same control.
     */
    railToggle?: boolean;
    /**
     * Render in normal flow (inside a header bar) instead of the floating
     * absolute dock. The hosted owner header matches the reviewer page's
     * bar, so its chips sit in flex flow rather than floating over paper.
     */
    inline?: boolean;
    /**
     * Collapse the share control to a glyph. Opt-in per surface rather than
     * derived from `inline`: the hosted owner header is also inline but has a
     * full-width bar to spend, whereas the native 44px header does not.
     */
    compactShare?: boolean;
  }

  let {
    shareOpen = false,
    isOwner = true,
    onShareClick,
    onLeaveRoom,
    onReconnect,
    onOutboxRetry,
    rightOffsetPx = 16,
    localParticipantId = null,
    onJumpTo,
    railToggle = false,
    inline = false,
    compactShare = false,
    onDockWidth,
  }: Props = $props();

  let dockEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = dockEl;
    if (!el || !onDockWidth || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => onDockWidth(el.offsetWidth));
    observer.observe(el);
    onDockWidth(el.offsetWidth);
    return () => {
      observer.disconnect();
      onDockWidth(0);
    };
  });

  // SnapshotBadge needs the local participant's kind to flip between owner
  // and reviewer perspectives. We map `isOwner` 1-to-1 because the parent
  // already encodes the same distinction; this keeps the badge a leaf.
  const localKind = $derived(isOwner ? 'owner' : 'reviewer');

  let roomMenuOpen = $state(false);

  // Owners navigate files; only joined reviewer rooms remain in this temporary
  // menu until P2 promotes them into the sidebar project picker.
  const rooms = $derived(
    isOwner ? [] : reviewStore.roomsList.filter((room) => room.role === 'reviewer'),
  );
  const hasActiveRoom = $derived(reviewStore.currentRoomId !== null);

  // Visible for active per-document status, a joined reviewer room that can be
  // selected during P1, or a share being initiated. Passive owner rooms never
  // create their own navigation surface.
  const visible = $derived(hasActiveRoom || (!isOwner && rooms.length > 0) || shareOpen);

  /**
   * Does the comments toggle (and the divider that introduces it) render?
   *
   * Matched to the DOCK's own mount rule (`visible`, above) rather than to
   * `hasActiveRoom` alone. The dock appears as soon as a share is being
   * initiated, but the toggle inside it used to wait for the room to mint —
   * so it popped into a cluster the user was already looking at, shifting the
   * layout mid-task. Present from the moment the dock is, live once there is
   * a room (attn-64iy.4).
   *
   * Note the reported wording was "comments or in share mode", which reads as
   * a second arm for "this file has threads but no room". That arm is
   * unreachable: `threadsForFile` returns [] when `roomId` is null, and
   * `forgetRoom` clears `currentRoomId` and `currentFileId` together, so
   * threads cannot outlive their room in the current store model.
   */
  const showRailToggle = $derived(railToggle && (hasActiveRoom || shareOpen));

  function handleShareClick(): void {
    onShareClick?.();
  }

  function roomLabel(roomId: RoomId, status?: string): string {
    // Name the room after the file(s) it shares; fall back to the short id
    // until the first snapshot lands.
    const name = roomDisplayName(reviewStore.snapshots, roomId) ?? shortRoomId(roomId);
    const verb =
      status === 'Live' ? 'Hosting' : status === 'Joined' ? 'Joined' : 'Room';
    return `${verb}: ${name}`;
  }

  function handleLeaveRoom(): void {
    const roomId = reviewStore.currentRoomId;
    if (roomId === null) return;
    reviewStore.leaveRoom(roomId);
    onLeaveRoom?.(roomId);
  }
</script>

{#if visible}
  <div
    class={inline
      ? 'review-bar pointer-events-none relative flex h-full min-w-0 items-center justify-end overflow-visible text-xs'
      : 'review-bar pointer-events-none absolute top-1.5 z-40 flex h-10 min-w-0 items-center justify-end overflow-visible text-xs'}
    style={inline ? '' : `right: ${rightOffsetPx}px;`}
    data-slot="review-bar"
    data-state={reviewStore.currentRoomId !== null ? 'active' : 'pending'}
  >
    <div
      bind:this={dockEl}
      class="review-bar-dock pointer-events-auto inline-flex h-8 max-w-[calc(100vw-1rem)] shrink-0 items-center justify-end gap-1.5 overflow-visible px-0"
      data-slot="review-bar-dock"
    >
      {#if !isOwner && rooms.length > 0}
        <DropdownMenu bind:open={roomMenuOpen}>
          <DropdownMenuTrigger
            class="room-menu-trigger inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 bg-background/65 px-1.5 text-muted-foreground shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={reviewStore.totalUnread > 0
              ? `Review rooms, ${reviewStore.totalUnread} unread updates`
              : 'Review rooms'}
            aria-expanded={roomMenuOpen}
            title="Review rooms"
          >
            <ChevronsUpDown class="size-3.5" aria-hidden="true" />
            <span class="room-menu-count tabular-nums">{rooms.length}</span>
            <UnreadBadge count={reviewStore.totalUnread} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-64">
            <DropdownMenuLabel class="text-xs text-muted-foreground">
              Review rooms
            </DropdownMenuLabel>
            {#each rooms as room (room.roomId)}
              <DropdownMenuItem
                class="room-menu-item"
                onSelect={() => reviewStore.selectRoom(room.roomId)}
              >
                <Check
                  class={`size-3.5 ${reviewStore.currentRoomId === room.roomId ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate">{roomLabel(room.roomId, room.status)}</span>
                <UnreadBadge
                  count={reviewStore.unreadForRoom(room.roomId)}
                  label="unread updates in this room"
                />
                <span class="room-menu-status">{room.connection === 'offline' ? 'offline' : 'syncing'}</span>
              </DropdownMenuItem>
            {/each}
            {#if hasActiveRoom}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={handleLeaveRoom}
              >
                <LogOut class="size-3.5" aria-hidden="true" />
                Leave current room
              </DropdownMenuItem>
            {/if}
          </DropdownMenuContent>
        </DropdownMenu>
      {/if}

      <!-- The single share control: names WHAT is shared, carries the
           connection state, and opens the one popover with files, people,
           and management actions. Reviewers get the status-word variant. -->
      <div class="review-bar-share shrink-0" data-slot="review-bar-share">
        <ShareChip
          {isOwner}
          {shareOpen}
          compact={compactShare}
          onManageShare={isOwner ? handleShareClick : undefined}
          {onReconnect}
        />
      </div>

      <!-- Divider, gated on the same condition as the toggle (attn-64iy.3).
           It separates the share control from the cluster that follows, so it
           must not be drawn with nothing behind it. PeerStrip, SnapshotBadge
           and OutboxIndicator each decide their own presence from store state
           this component cannot cheaply re-derive, and duplicating those
           predicates here is precisely the drift that caused the bug this
           fixes. The rail toggle is the one following element ReviewBar
           renders unconditionally, so "the toggle is showing" is the only
           honest "something follows" signal available. -->
      {#if showRailToggle}
        <span class="h-4 w-px shrink-0 bg-border/70" aria-hidden="true"></span>
      {/if}

      {#if hasActiveRoom}
        <!-- NO WRAPPER DIVS around these three (attn-64iy.3).
             They used to sit in `review-bar-peers` / `-snapshot` / `-outbox`
             divs that rendered unconditionally. A wrapper whose child renders
             nothing is still a flex item of this `gap-1.5` row, so three empty
             wrappers silently ate ~18px — all of it landing between the share
             control and the comments toggle, which is the uneven spacing that
             was reported.

             Letting each component BE the flex item makes the collapse exact
             and self-maintaining: SnapshotBadge and OutboxIndicator render no
             element at all when idle, and PeerStrip's empty branch is
             `sr-only` (position: absolute), which generates no flex item
             either while still announcing "No peers" to assistive tech. The
             layout classes the wrappers carried now live on the components'
             own roots. -->
        <PeerStrip {localParticipantId} {onJumpTo} />

        <SnapshotBadge {localKind} />

        <OutboxIndicator {isOwner} onRetry={onOutboxRetry} />
      {/if}

      {#if showRailToggle}
        <!-- The rail's show/hide (attn-64iy.4).
             GLYPH: panel-right-close/open, not a speech bubble. This control
             does not create a comment — it opens and closes the rail that
             holds them — and WorkspaceEditorFrame's own copy of this toggle
             already uses exactly this pair for exactly this job. That copy is
             suppressed on surfaces where the header owns the affordance
             (`railToggleInHeader`), so the header inherits its vocabulary too;
             the two must never disagree about which glyph means which state.

             CHROME: the same resting-ghost convention as every other header
             icon (attn-11g4.6). It used to be a permanently bordered pill,
             which — once the ShareChip beside it was demoted to a ghost in
             attn-64iy.6 — would have left it the only outlined control in a
             row of ghosts, reproducing the inconsistency that was reported.
             Its surface is the rail, so the active pill maps to `panelOpen`,
             which `aria-pressed` already announces. -->
        <button
          type="button"
          class="relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {reviewStore.panelOpen
            ? 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/15'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'}"
          data-slot="review-bar-rail-toggle"
          data-active={reviewStore.panelOpen ? 'true' : 'false'}
          aria-pressed={reviewStore.panelOpen}
          aria-label={reviewStore.panelOpen ? 'Hide comments' : 'Show comments'}
          title="{reviewStore.panelOpen ? 'Hide comments' : 'Show comments'} (⌘J)"
          onclick={() => reviewStore.togglePanel()}
        >
          {#if reviewStore.panelOpen}
            <PanelRightClose class="size-3.5" aria-hidden="true" />
          {:else}
            <PanelRightOpen class="size-3.5" aria-hidden="true" />
          {/if}
          {#if reviewStore.roomActiveThreadCount > 0}
            <span class="rail-toggle-count tabular-nums">{reviewStore.roomActiveThreadCount}</span>
          {/if}
          <UnreadBadge
            count={reviewStore.currentRoomUnread}
            label="unread review updates"
            class="absolute -right-1.5 -top-1.5"
          />
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .room-menu-count,
  .rail-toggle-count {
    font-size: 0.6875rem;
    line-height: 1;
  }

  .room-menu-status {
    max-width: 4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: hsl(var(--muted-foreground));
    font-size: 0.6875rem;
  }

  @media (max-width: 720px) {
    .review-bar {
      right: 0.5rem;
    }

    .review-bar-dock {
      max-width: calc(100vw - 1rem);
    }
  }
</style>
