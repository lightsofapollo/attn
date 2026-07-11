<!--
  Compact review dock.

  This started as a dedicated 36 px review-bar row. User feedback from the
  marketing hero pass made that feel too heavy: "Sharing / Connected /
  Snapshot current" was claiming a full strip of chrome before the document
  itself. The dock now overlays the breadcrumb line with the same testable
  slots, but the visible surface is icon + avatar driven.

  Owner asymmetry: the Share button is the owner-only slot. In this issue
  (4.10) the connection-badge and peer-strip slots are intentionally stubs —
  attn-nnj.4.11 owns the badge state machine and 4.12 owns the peer chips.
  Their host elements live here so layout / overflow rules ship in one place.

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
  import LogOut from '@lucide/svelte/icons/log-out';
  import Share2 from '@lucide/svelte/icons/share-2';
  import ConnectionBadge from './ConnectionBadge.svelte';
  import OutboxIndicator from './OutboxIndicator.svelte';
  import PeerStrip from './PeerStrip.svelte';
  import SharedFilesBadge from './SharedFilesBadge.svelte';
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
  import type { ParticipantId, RoomId } from './types';
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
     * The local participant's id, surfaced from the daemon's identity
     * bootstrap. Passed through to PeerStrip so the matching chip carries
     * a `(you)` label. `null` until the bridge populates it.
     */
    localParticipantId?: ParticipantId | null;
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
  }: Props = $props();

  // SnapshotBadge needs the local participant's kind to flip between owner
  // and reviewer perspectives. We map `isOwner` 1-to-1 because the parent
  // already encodes the same distinction; this keeps the badge a leaf.
  const localKind = $derived(isOwner ? 'owner' : 'reviewer');

  let roomMenuOpen = $state(false);

  const rooms = $derived(reviewStore.roomsList);
  const hasActiveRoom = $derived(reviewStore.currentRoomId !== null);

  // Visible whenever a room is active, a remembered room can be selected, or a
  // share is being initiated.
  const visible = $derived(hasActiveRoom || rooms.length > 0 || shareOpen);

  // Label for the share pill — post-mint it flips to "Sharing" per §8.
  const shareLabel = $derived(
    hasActiveRoom ? 'Sharing' : 'Share',
  );

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
    class="review-bar pointer-events-none absolute top-1.5 z-40 flex h-10 min-w-0 items-center justify-end overflow-visible text-xs"
    style={`right: ${rightOffsetPx}px;`}
    data-slot="review-bar"
    data-state={reviewStore.currentRoomId !== null ? 'active' : 'pending'}
  >
    <div
      class="review-bar-dock pointer-events-auto inline-flex h-8 max-w-[calc(100vw-1rem)] shrink-0 items-center justify-end gap-1.5 overflow-visible px-0"
      data-slot="review-bar-dock"
    >
      {#if rooms.length > 0}
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

      {#if (hasActiveRoom || shareOpen) && isOwner}
        <button
          type="button"
          class="share-pill inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/55 text-muted-foreground shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-slot="review-bar-share"
          data-state={reviewStore.currentRoomId !== null ? 'sharing' : 'idle'}
          aria-label={shareLabel}
          title={shareLabel}
          onclick={handleShareClick}
        >
          <Share2 class="size-3.5" aria-hidden="true" />
          <span class="sr-only">{shareLabel}</span>
        </button>
        <!-- Names WHAT is shared (file / "N files") so "Sharing" doesn't read
             as "everything is shared". Self-gates until a file is published. -->
        <SharedFilesBadge />
      {/if}

      {#if hasActiveRoom}
        <div
          class="review-bar-connection shrink-0"
          data-slot="review-bar-connection"
        >
          <ConnectionBadge {onReconnect} />
        </div>

        <span class="h-4 w-px shrink-0 bg-border/70" aria-hidden="true"></span>

        <div
          class="review-bar-peers min-w-0 shrink"
          data-slot="review-bar-peers"
        >
          <PeerStrip {localParticipantId} />
        </div>

        <div
          class="review-bar-snapshot shrink-0"
          data-slot="review-bar-snapshot"
        >
          <SnapshotBadge {localKind} />
        </div>

        <div
          class="review-bar-outbox shrink-0"
          data-slot="review-bar-outbox"
        >
          <OutboxIndicator {isOwner} onRetry={onOutboxRetry} />
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .room-menu-count {
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
