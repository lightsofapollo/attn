<!--
  Connection badge (attn-nnj.4.11, per planning/collab/ui/connection-share.md
  §5). Renders the four transport states surfaced by the Rust review manager:

    Live direct   — DataChannel up, realtime traffic
    Mailbox       — async via relay (push/pull)
    Offline       — no transport bound, events queue locally
    Direct failed — policy.mode == "live" but DataChannel could not connect;
                    visually louder than the others (--destructive)

  Colors reuse existing CSS vars only (per §5):
    Live direct   → --primary
    Mailbox       → --muted-foreground (neutral)
    Offline       → --muted-foreground @ reduced opacity (dim)
    Direct failed → --destructive (red, slightly louder)

  Click → popover showing per-peer transport, last-seen times, outbox depth,
  and a [retry direct] action wired through the optional `onReconnect`
  callback. The popover is a self-contained absolutely-positioned card; we
  reach for no bits-ui Popover primitive because:
    1. The chip lives inside the review-bar row which already overflows; the
       popover anchors to the chip's right edge with native CSS.
    2. The host is a 36 px row with limited width — a portal-mounted popover
       would re-introduce z-index battles with the right-rail aside.

  The component subscribes to `reviewStore.status` (ReviewStatus shape:
  { roomId, mode, connection, peers, outboxPending, ... }). When no status
  payload has landed yet (`reviewStore.status === null`), the badge collapses
  to the Offline state so the host row never renders an empty slot.
-->

<script lang="ts">
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Wifi from '@lucide/svelte/icons/wifi';
  import { defaultFormatLastSeen } from './connection-badge-format';
  import { reviewStore } from './review/store.svelte';
  import type { ReviewStatus, ReviewStatusPeer } from './types';

  type ConnectionState = ReviewStatus['connection'];

  interface Props {
    /**
     * Optional click handler for the [retry direct] button inside the popover.
     * Wires through to a `reviewReconnect` IPC in 4.13; today the parent owns
     * the side-effect so this component stays presentational.
     */
    onReconnect?: () => void;
    /**
     * Optional override for the "last seen" string formatter. Defaults to a
     * minimal relative time. Tests can stub this for stable assertions.
     */
    formatLastSeen?: (timestampMs: number, nowMs: number) => string;
    /** Optional clock injection (ms since epoch). Defaults to `Date.now()`. */
    now?: () => number;
  }

  let {
    onReconnect,
    formatLastSeen = defaultFormatLastSeen,
    now = () => Date.now(),
  }: Props = $props();

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

  // Visual descriptor table — drives label, tooltip, color class, and icon.
  // Keeping this colocated with the script (not in a sibling .ts) so the
  // contract (state → presentation) is greppable from the component file.
  interface StateDescriptor {
    label: string;
    tooltip: string;
    toneClass: string;
    iconClass: string;
  }

  const STATE_DESCRIPTORS: Record<ConnectionState, StateDescriptor> = {
    live_direct: {
      label: 'Live direct',
      tooltip: 'Realtime via DataChannel',
      // --primary text + thin outline using --primary at low alpha.
      toneClass:
        'text-primary border-primary/40 bg-primary/10 hover:bg-primary/15',
      iconClass: 'text-primary',
    },
    mailbox: {
      label: 'Mailbox',
      tooltip: 'Async via relay',
      toneClass:
        'text-muted-foreground border-border bg-muted/40 hover:bg-muted/60',
      iconClass: 'text-muted-foreground',
    },
    offline: {
      label: 'Offline',
      // Dim per §5: "No transport; queueing N"
      tooltip: 'No transport — events queue locally',
      toneClass:
        'text-muted-foreground/70 border-border/60 bg-muted/20 hover:bg-muted/40 opacity-80',
      iconClass: 'text-muted-foreground/70',
    },
    direct_failed: {
      // §5: "louder than the others (warning)" — --destructive, heavier border.
      label: 'Direct failed',
      tooltip:
        'Live mode requested, DataChannel could not connect',
      toneClass:
        'text-destructive border-destructive/60 bg-destructive/10 hover:bg-destructive/20 ring-1 ring-destructive/30',
      iconClass: 'text-destructive',
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

  // Per-peer transport label. The Rust side will surface this on each peer
  // in a later pass (4.13); today we infer from the room-level connection
  // plus the peer's `online` flag — direct when room is live and peer
  // online, mailbox when room is mailbox/hybrid, offline otherwise.
  function peerTransport(peer: ReviewStatusPeer): 'direct' | 'mailbox' | 'offline' {
    if (!peer.online) return 'offline';
    if (connection === 'live_direct') return 'direct';
    if (connection === 'mailbox') return 'mailbox';
    if (connection === 'direct_failed') return 'mailbox';
    return 'offline';
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="connection-badge relative inline-flex" data-slot="connection-badge">
  <button
    type="button"
    class="chip inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {descriptor.toneClass}"
    data-slot="connection-badge-chip"
    data-state={connection}
    aria-label={descriptor.label}
    aria-haspopup="dialog"
    aria-expanded={popoverOpen}
    title={descriptor.tooltip}
    onclick={togglePopover}
  >
    {#if connection === 'live_direct'}
      <Wifi class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {:else if connection === 'mailbox'}
      <Inbox class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {:else if connection === 'offline'}
      <CloudOff class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {:else}
      <AlertTriangle class="size-3 {descriptor.iconClass}" aria-hidden="true" />
    {/if}
    <span>{descriptor.label}</span>
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
        {#if connection === 'live_direct'}
          <Wifi class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {:else if connection === 'mailbox'}
          <Inbox class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {:else if connection === 'offline'}
          <CloudOff class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {:else}
          <AlertTriangle class="size-3.5 {descriptor.iconClass}" aria-hidden="true" />
        {/if}
        <span class="text-sm font-medium {descriptor.iconClass}">
          {descriptor.label}
        </span>
      </header>

      <p
        class="mb-2 text-xs text-muted-foreground"
        data-slot="connection-badge-tooltip-detail"
      >
        {descriptor.tooltip}
      </p>

      <dl
        class="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]"
        data-slot="connection-badge-meta"
      >
        <dt class="text-muted-foreground">Transport</dt>
        <dd class="font-mono">{descriptor.label.toLowerCase()}</dd>
        <dt class="text-muted-foreground">Peers</dt>
        <dd data-slot="connection-badge-peer-count">{peers.length}</dd>
        {#if outboxPending > 0}
          <dt class="text-muted-foreground">Outbox</dt>
          <dd data-slot="connection-badge-outbox">{outboxPending} pending</dd>
        {/if}
        {#if reviewStore.status?.lastImportedSeq !== undefined}
          <dt class="text-muted-foreground">Last seq</dt>
          <dd class="font-mono">#{reviewStore.status.lastImportedSeq}</dd>
        {/if}
      </dl>

      {#if peers.length > 0}
        <ul
          class="mb-2 flex flex-col gap-1 border-t border-border/50 pt-2 text-[11px]"
          data-slot="connection-badge-peer-list"
        >
          {#each peers as peer (peer.deviceId)}
            <li
              class="flex items-center justify-between gap-2"
              data-slot="connection-badge-peer"
              data-online={peer.online ? 'true' : 'false'}
            >
              <span class="truncate font-medium text-foreground">
                {peer.displayName}
              </span>
              <span class="shrink-0 text-muted-foreground">
                {peerTransport(peer)}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if connection === 'direct_failed'}
        <div
          class="mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
          data-slot="connection-badge-error"
        >
          Live connection failed. Switch to Mailbox or retry direct.
        </div>
      {/if}

      {#if reviewStore.status?.expiresAt !== undefined}
        <p
          class="mb-2 text-[11px] text-muted-foreground"
          data-slot="connection-badge-expires"
        >
          Expires: {formatLastSeen(reviewStore.status.expiresAt, now())}
        </p>
      {/if}

      <footer class="flex items-center justify-end gap-2 pt-1">
        {#if connection === 'direct_failed' || connection === 'mailbox'}
          <button
            type="button"
            class="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
            data-slot="connection-badge-reconnect"
            onclick={handleReconnect}
          >
            Retry direct
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

