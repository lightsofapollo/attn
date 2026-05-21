<!--
  Connection badge (per planning/collab/ui/connection-share.md §5, rewritten
  2026-05-19 for status-first UX).

  The Rust manager surfaces four transport states. We deliberately DO NOT show
  the transport mechanism ("mailbox", "DataChannel") to the user — that's
  internal plumbing. In the compact review dock the visible chip is icon-only
  so the document keeps priority; the status label remains in the DOM for
  accessibility and E2E assertions.

    live_direct   → "Live"       (instant, peer-to-peer)
    mailbox       → "Connected"  (syncing via the relay, ~1s)
    direct_failed → "Connected"  (relay fallback works — NOT an error to the
                    user; a faster direct link just wasn't available)
    offline       → "Offline"    (changes saved locally, will sync on reconnect)

  Click → popover with a plain-English status line, the people in the room, and
  (when not already Live) an optional "Try a faster connection" action wired
  through `onReconnect`. The popover is a self-contained absolutely-positioned
  card (no bits-ui Popover) because the chip lives in the overflow-prone
  review-bar row and a portal would fight the right-rail aside for z-index.

  Subscribes to `reviewStore.connection` (preferring a future full-status
  payload's `connection`). No status yet → Offline, so the row never renders
  an empty slot.
-->

<script lang="ts">
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import Wifi from '@lucide/svelte/icons/wifi';
  import Zap from '@lucide/svelte/icons/zap';
  import { reviewStore } from './review/store.svelte';
  import type { ReviewStatus, ReviewStatusPeer } from './types';

  type ConnectionState = ReviewStatus['connection'];

  interface Props {
    /**
     * Optional handler for the "Try a faster connection" button inside the
     * popover (attempts to upgrade to a direct peer-to-peer link). The parent
     * owns the side-effect so this component stays presentational.
     */
    onReconnect?: () => void;
  }

  let { onReconnect }: Props = $props();

  let popoverOpen = $state(false);

  // The badge mirrors the live transport state. `reviewStore.connection` is
  // driven directly by the daemon's `reviewConnection` callback (mailbox on
  // relay subscribe, offline on disconnect) — the `RoomStatusChanged` wire
  // variant only carries a status string, so `status.connection` is never
  // populated. We still prefer `status.connection` if a future full-status
  // payload sets it. §5 says Offline is the safe default.
  const connection: ConnectionState = $derived(
    reviewStore.status?.connection ?? reviewStore.connection,
  );

  const peers: ReviewStatusPeer[] = $derived(reviewStore.peersResolved);
  const outboxPending: number = $derived(
    reviewStore.status?.outboxPending ?? 0,
  );

  // Visual descriptor table — drives label, plain-English detail, color, icon,
  // and whether the "try a faster connection" action applies. Colocated with
  // the script so the state → presentation contract is greppable here.
  type IconKind = 'live' | 'connected' | 'offline';
  interface StateDescriptor {
    /** User-facing chip label — status, never the transport mechanism. */
    label: string;
    /** Plain-English popover line explaining what's happening. */
    detail: string;
    toneClass: string;
    iconClass: string;
    icon: IconKind;
    /** Offer "Try a faster connection" (only when connected but not live). */
    canTryFaster: boolean;
  }

  // "Connected" presentation is shared by `mailbox` and `direct_failed`: to the
  // user both mean "you're connected and syncing" — a failed direct-link
  // attempt is not an error because the relay path works. Only the detail line
  // differs.
  const CONNECTED_TONE =
    'text-primary border-primary/30 bg-primary/5 hover:bg-primary/10';

  const STATE_DESCRIPTORS: Record<ConnectionState, StateDescriptor> = {
    live_direct: {
      label: 'Live',
      detail: 'Connected live — changes appear instantly (peer-to-peer).',
      toneClass: 'text-primary border-primary/50 bg-primary/15 hover:bg-primary/20',
      iconClass: 'text-primary',
      icon: 'live',
      canTryFaster: false,
    },
    mailbox: {
      label: 'Connected',
      detail: 'Connected — changes sync through the encrypted relay, usually within a second.',
      toneClass: CONNECTED_TONE,
      iconClass: 'text-primary',
      icon: 'connected',
      canTryFaster: true,
    },
    direct_failed: {
      // Deliberately NOT an error state to the user — the relay path works.
      label: 'Connected',
      detail: 'Connected through the relay. A faster peer-to-peer link wasn’t available, so changes sync in about a second.',
      toneClass: CONNECTED_TONE,
      iconClass: 'text-primary',
      icon: 'connected',
      canTryFaster: true,
    },
    offline: {
      label: 'Offline',
      detail: 'Offline — your changes are saved and will sync automatically when you reconnect.',
      toneClass:
        'text-muted-foreground/70 border-border/60 bg-muted/20 hover:bg-muted/40 opacity-80',
      iconClass: 'text-muted-foreground/70',
      icon: 'offline',
      canTryFaster: false,
    },
  };

  const descriptor: StateDescriptor = $derived(STATE_DESCRIPTORS[connection]);

  function togglePopover(): void {
    popoverOpen = !popoverOpen;
  }

  function closePopover(): void {
    popoverOpen = false;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && popoverOpen) {
      event.preventDefault();
      closePopover();
    }
  }

  function handleReconnect(): void {
    onReconnect?.();
    closePopover();
  }

  // Plain presence label for the "people here" list — no transport jargon.
  function peerStatus(peer: ReviewStatusPeer): 'here' | 'away' {
    return peer.online ? 'here' : 'away';
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="connection-badge relative inline-flex" data-slot="connection-badge">
  <button
    type="button"
    class="chip inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {descriptor.toneClass}"
    data-slot="connection-badge-chip"
    data-state={connection}
    aria-label={descriptor.label}
    aria-haspopup="dialog"
    aria-expanded={popoverOpen}
    title={descriptor.detail}
    onclick={togglePopover}
  >
    {#if descriptor.icon === 'live'}
      <Zap class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {:else if descriptor.icon === 'connected'}
      <Wifi class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {:else}
      <CloudOff class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {/if}
    <span class="sr-only">{descriptor.label}</span>
  </button>

  {#if popoverOpen}
    <!-- Click-shield: clicking outside the popover dismisses it. The button
         above stops propagation by virtue of being inside the same
         positioning context. -->
    <button
      type="button"
      class="fixed inset-0 z-40 cursor-default bg-transparent"
      data-slot="connection-badge-shield"
      aria-label="Close connection details"
      onclick={closePopover}
    ></button>

    <div
      class="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
      data-slot="connection-badge-popover"
      role="dialog"
      aria-label="Connection details"
    >
      <header class="mb-2 flex items-center gap-1.5">
        {#if descriptor.icon === 'live'}
          <Zap class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {:else if descriptor.icon === 'connected'}
          <Wifi class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {:else}
          <CloudOff class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {/if}
        <span class="text-sm font-medium {descriptor.iconClass}">
          {descriptor.label}
        </span>
      </header>

      <p
        class="mb-2 text-xs text-muted-foreground"
        data-slot="connection-badge-tooltip-detail"
      >
        {descriptor.detail}
      </p>

      {#if outboxPending > 0}
        <p class="mb-2 text-[11px] text-muted-foreground" data-slot="connection-badge-outbox">
          {outboxPending} change{outboxPending === 1 ? '' : 's'} waiting to sync…
        </p>
      {/if}

      {#if peers.length > 0}
        <div class="mb-2 border-t border-border/50 pt-2">
          <div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            People here
            <span data-slot="connection-badge-peer-count" class="sr-only">{peers.length}</span>
          </div>
          <ul class="flex flex-col gap-1 text-[11px]" data-slot="connection-badge-peer-list">
            {#each peers as peer (peer.deviceId)}
              <li
                class="flex items-center justify-between gap-2"
                data-slot="connection-badge-peer"
                data-online={peer.online ? 'true' : 'false'}
              >
                <span class="flex items-center gap-1.5 truncate font-medium text-foreground">
                  <span
                    class="inline-block size-1.5 shrink-0 rounded-full"
                    class:bg-primary={peer.online}
                    class:bg-muted-foreground={!peer.online}
                    aria-hidden="true"
                  ></span>
                  {peer.displayName}
                </span>
                <span class="shrink-0 text-muted-foreground">
                  {peerStatus(peer) === 'here' ? 'here' : 'away'}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <footer class="flex items-center justify-end gap-2 pt-1">
        {#if descriptor.canTryFaster && onReconnect}
          <button
            type="button"
            class="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
            data-slot="connection-badge-reconnect"
            onclick={handleReconnect}
          >
            Try a faster connection
          </button>
        {/if}
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
          data-slot="connection-badge-dismiss"
          onclick={closePopover}
        >
          Close
        </button>
      </footer>
    </div>
  {/if}
</div>
