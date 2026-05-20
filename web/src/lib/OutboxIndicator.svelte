<!--
  Outbox indicator (attn-nnj.4.13).

  Shows a subtle, warning-toned pill at the right end of the review-bar row
  whenever the local participant has pending outbound envelopes that have not
  yet been acknowledged by the relay. Two visual layers:

    "3 pending"                  — always when outboxCount > 0
    "Owner offline — feedback    — reviewer side only, when the owner is not
     will be delivered later"     present in `reviewStore.peers` AND there is
                                  at least one queued envelope

  Click → popover with the queued entries (`envelopeId`, optional `kind`,
  `createdAt`) and a `[Retry now]` button that calls the `onRetry` prop.
  Today the parent owns the retry side-effect (there is no `reviewPull` IPC
  yet — issue 4.13 stops at the chrome contract). The popover and pill are
  self-contained: no `bits-ui` Popover dep, mirroring the same anchoring
  approach used by ConnectionBadge.svelte / SnapshotBadge.svelte so we don't
  re-introduce portal/z-index battles inside the 36 px row.

  Visibility: collapses to nothing when `reviewStore.outboxCount === 0` so the
  host row reflows without a reserved gap.

  Color story: `--destructive` would be too loud (these envelopes WILL deliver
  on reconnect; this is informational, not an error). We use the same
  `--muted-foreground` ramp + an `accent`-colored highlight when the owner-
  offline notice is active, matching the §5 colour brief in
  planning/collab/ui/connection-share.md (subtle warning, no new vars).
-->

<script lang="ts">
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import Inbox from '@lucide/svelte/icons/inbox';
  import RefreshCcw from '@lucide/svelte/icons/refresh-ccw';
  import { reviewStore } from './review/store.svelte';
  import type { ReviewStatusPeer } from './types';

  /**
   * Minimal shape we read off each outbox entry. The Rust side serialises
   * `MailboxEnvelope` (camelCase) so these fields match the wire layout.
   * `kind` is informational ("event" / "snapshot_blob" / "signal") and is
   * surfaced in the popover row label. The full envelope carries crypto
   * fields we never display.
   */
  interface OutboxEntryShape {
    envelopeId: string;
    kind?: string;
    createdAt?: number;
  }

  interface Props {
    /**
     * `true` when the local device is the room owner. Drives the reviewer-
     * only "owner offline" notice — the owner can never see themselves as
     * offline, so the notice is suppressed on the owner side.
     */
    isOwner?: boolean;
    /**
     * Optional retry handler invoked by the `[Retry now]` popover button.
     * 4.13 stops at the chrome contract; the parent wires the IPC (e.g. a
     * future `reviewPull(roomId)`) when it's available. Closing the
     * popover happens unconditionally so users see immediate feedback.
     */
    onRetry?: () => void;
  }

  let { isOwner = false, onRetry }: Props = $props();

  let popoverOpen = $state(false);

  // Pending count — sole gate for the indicator's visibility.
  const pending: number = $derived(reviewStore.outboxCount);

  // Treat the buffer as `OutboxEntryShape[]` for display. The store types
  // `pendingOutbox` as `unknown[]` because the Rust-side outbox-entry shape
  // is only nailed down once the bridge surfaces it — but we know it carries
  // at least `envelopeId` per `MailboxEnvelope` (see src/review/model.rs).
  const entries: OutboxEntryShape[] = $derived(
    reviewStore.pendingOutbox as OutboxEntryShape[],
  );

  // Owner roster lookup — the owner is the peer with `kind === 'owner'`.
  // We treat the owner as "offline" when they are absent from the peer
  // roster OR present with `online === false`. A reviewer-side device that
  // has never seen the owner (mailbox-only handshake) has the owner absent
  // entirely.
  const ownerPresent: boolean = $derived(
    reviewStore.peers.some(
      (p: ReviewStatusPeer) => p.kind === 'owner' && p.online,
    ),
  );

  /**
   * The "Owner offline — feedback will be delivered later" notice only fires
   * on the reviewer side, when the owner is not online AND there is at least
   * one queued envelope. The owner can never see themselves offline.
   */
  const showOwnerOfflineNotice: boolean = $derived(
    !isOwner && pending > 0 && !ownerPresent,
  );

  // Visibility — collapse entirely when nothing is queued. Slot collapse,
  // not visibility hide (matches the convention used in the rest of the
  // review-bar chrome).
  const visible: boolean = $derived(pending > 0);

  // Pill copy. Singular/plural matters because "1 pendings" looks broken.
  const pillLabel: string = $derived(
    pending === 1 ? '1 pending' : `${pending} pending`,
  );

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

  function handleRetry(): void {
    onRetry?.();
    closePopover();
  }

  // Render-only helper — never throws on a malformed entry. `unknown` widening
  // means we can't trust the shape, so guard each field. Keeps the popover
  // resilient if the bridge starts pushing entries we don't fully decode yet.
  function entryLabel(entry: OutboxEntryShape, index: number): string {
    const kind = typeof entry.kind === 'string' ? entry.kind : 'envelope';
    const idTail =
      typeof entry.envelopeId === 'string' && entry.envelopeId.length > 0
        ? entry.envelopeId.slice(-6)
        : String(index + 1);
    return `${kind} · ${idTail}`;
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if visible}
  <div
    class="outbox-indicator relative inline-flex flex-col items-end gap-1"
    data-slot="outbox-indicator"
    data-state={showOwnerOfflineNotice ? 'owner-offline' : 'pending'}
  >
    <button
      type="button"
      class="outbox-pill inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      data-slot="outbox-indicator-pill"
      aria-label={pillLabel}
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      title={pillLabel}
      onclick={togglePopover}
    >
      <Inbox class="size-3 text-muted-foreground" aria-hidden="true" />
      <span>{pillLabel}</span>
    </button>

    {#if showOwnerOfflineNotice}
      <!--
        Reviewer-only secondary notice. Sits below the pill to avoid
        widening the row (the row's height is fixed at 36 px). Subtle
        accent border keeps it informational, not alarming.
      -->
      <p
        class="owner-offline-notice inline-flex max-w-[18rem] items-center gap-1.5 rounded-md border border-border/60 bg-accent/30 px-2 py-1 text-[11px] text-muted-foreground"
        data-slot="outbox-indicator-owner-offline"
      >
        <CloudOff class="size-3 shrink-0" aria-hidden="true" />
        <span>Owner offline — feedback will be delivered later</span>
      </p>
    {/if}

    {#if popoverOpen}
      <!-- Click-shield: clicking outside dismisses (same pattern as
           ConnectionBadge.svelte / SnapshotBadge.svelte). -->
      <button
        type="button"
        class="fixed inset-0 z-40 cursor-default bg-transparent"
        data-slot="outbox-indicator-shield"
        aria-label="Close outbox details"
        onclick={closePopover}
      ></button>

      <div
        class="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
        data-slot="outbox-indicator-popover"
        role="dialog"
        aria-label="Pending outbox"
      >
        <header class="mb-2 flex items-center gap-1.5">
          <Inbox class="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span class="text-sm font-medium text-foreground">
            {pillLabel}
          </span>
        </header>

        <p
          class="mb-2 text-[11px] text-muted-foreground"
          data-slot="outbox-indicator-summary"
        >
          {#if showOwnerOfflineNotice}
            Owner offline — feedback will be delivered when they reconnect.
          {:else}
            Queued envelopes awaiting acknowledgement from the relay.
          {/if}
        </p>

        {#if entries.length > 0}
          <ul
            class="mb-2 flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-border/50 pt-2 text-[11px]"
            data-slot="outbox-indicator-list"
          >
            {#each entries as entry, i (entry.envelopeId ?? i)}
              <li
                class="flex items-center justify-between gap-2 truncate"
                data-slot="outbox-indicator-entry"
              >
                <span class="truncate font-mono text-muted-foreground">
                  {entryLabel(entry, i)}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        <footer class="flex items-center justify-end gap-2 pt-1">
          {#if onRetry}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
              data-slot="outbox-indicator-retry"
              onclick={handleRetry}
            >
              <RefreshCcw class="size-3" aria-hidden="true" />
              <span>Retry now</span>
            </button>
          {/if}
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
            data-slot="outbox-indicator-dismiss"
            onclick={closePopover}
          >
            Close
          </button>
        </footer>
      </div>
    {/if}
  </div>
{/if}
