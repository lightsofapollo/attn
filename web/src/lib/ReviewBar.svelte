<!--
  Review-bar row (attn-nnj.4.10, per planning/collab/ui/connection-share.md §8).

  A dedicated 36 px header row that appears ONLY when a review session is bound
  to the active file. Otherwise the viewer chrome is byte-identical to today.

  Left-to-right order (§8 recommendation):

    [Share]  →  connection badge  →  peer strip  →  snapshot label

  Owner asymmetry: the Share button is the owner-only slot. In this issue
  (4.10) the connection-badge and peer-strip slots are intentionally stubs —
  attn-nnj.4.11 owns the badge state machine and 4.12 owns the peer chips.
  Their host elements live here so layout / overflow rules ship in one place.

  Visibility: the row mounts when `reviewStore.currentRoomId !== null` OR when
  the share dialog is open (`shareOpen` prop, parent-controlled). The latter
  means "share is being initiated" — the row should appear so the user has
  spatial anchoring while the modal is up.

  Reviewer asymmetry (§4 of the design): rendering of the Share slot follows
  "slot collapse, not visibility hide" — when an `isOwner` prop is false the
  slot is omitted entirely so the row reflows without a reserved gap. The
  prop defaults to `true` because the only caller today is the owner-only
  share initiation path; reviewer wiring lands with the connection badge in
  4.11.
-->

<script lang="ts">
  import Share2 from '@lucide/svelte/icons/share-2';
  import { reviewStore } from './review/store.svelte';

  interface Props {
    /** Whether the share dialog is currently open (forces the row visible). */
    shareOpen?: boolean;
    /** True when the current device is the room owner. Defaults true. */
    isOwner?: boolean;
    /** Click handler for the Share pill — opens ShareDialog (parent owned). */
    onShareClick?: () => void;
  }

  let {
    shareOpen = false,
    isOwner = true,
    onShareClick,
  }: Props = $props();

  // Visible whenever a room is bound OR a share is being initiated.
  const visible = $derived(reviewStore.currentRoomId !== null || shareOpen);

  // Label for the share pill — post-mint it flips to "Sharing" per §8.
  const shareLabel = $derived(
    reviewStore.currentRoomId !== null ? 'Sharing' : 'Share',
  );

  function handleShareClick(): void {
    onShareClick?.();
  }
</script>

{#if visible}
  <div
    class="review-bar flex h-9 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-3 text-xs"
    data-slot="review-bar"
    data-state={reviewStore.currentRoomId !== null ? 'active' : 'pending'}
  >
    {#if isOwner}
      <button
        type="button"
        class="share-pill inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-slot="review-bar-share"
        data-state={reviewStore.currentRoomId !== null ? 'sharing' : 'idle'}
        aria-label={shareLabel}
        onclick={handleShareClick}
      >
        <Share2 class="size-3.5" aria-hidden="true" />
        <span>{shareLabel}</span>
      </button>
    {/if}

    <!--
      Connection-badge slot (attn-nnj.4.11 fills this). Render an inert
      placeholder so the layout matches the §8 mock once the badge ships.
    -->
    <div
      class="review-bar-connection text-muted-foreground"
      data-slot="review-bar-connection"
      aria-hidden="true"
    >
      <span class="inline-flex items-center gap-1.5">
        <span
          class="size-2 rounded-full bg-muted-foreground/50"
          aria-hidden="true"
        ></span>
        <span class="text-[11px]">{reviewStore.status?.connection ?? 'pending'}</span>
      </span>
    </div>

    <span class="text-muted-foreground/60" aria-hidden="true">·</span>

    <!--
      Peer-strip slot (attn-nnj.4.12 fills this). Today we render a tight
      summary count so the row has a visible non-empty area pre-4.12.
    -->
    <div
      class="review-bar-peers min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
      data-slot="review-bar-peers"
    >
      {#if reviewStore.peers.length > 0}
        {reviewStore.peers.length} peer{reviewStore.peers.length === 1 ? '' : 's'}
      {:else}
        no peers yet
      {/if}
    </div>

    <!--
      Snapshot label sits at the right end (attn-nnj.4.9 owns the snapshot
      badge proper). Show a minimal age-style stub when a snapshot is active.
    -->
    {#if reviewStore.currentSnapshotId}
      <div
        class="review-bar-snapshot shrink-0 text-[11px] text-muted-foreground"
        data-slot="review-bar-snapshot"
      >
        snapshot {reviewStore.currentSnapshotId.slice(0, 8)}
      </div>
    {/if}
  </div>
{/if}
