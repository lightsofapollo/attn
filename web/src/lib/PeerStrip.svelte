<!--
  Peer strip (attn-nnj.4.12).

  Per planning/collab/ui/connection-share.md §7 and presence-identity.md
  (10.5 — chip taxonomy). A compact horizontal row of participant chips
  that sits between the connection badge and the snapshot label on the
  ReviewBar row.

  Chip shapes carry the human-vs-agent distinction so a 20 px chip survives
  color-blindness and small displays (§7):

    * Human (owner / reviewer): round chip, monogram of `displayName`.
      Owner uses `--peer-avatar-bg-owner` (warm), every other human uses
      `--peer-avatar-bg-reviewer` (cool).
    * Agent: hex/diamond chip, `⊳` glyph (geometric, not a letter, not
      emoji), `--peer-avatar-bg-agent` (violet).

  Overflow: more than 5 peers collapses to `MAX_VISIBLE_CHIPS=4` inline
  chips + a single "+N" overflow chip whose click reveals the full roster
  popover. 0-5 peers all render inline.

  Hover / click:
    * Hover any chip → presence-detail tooltip (last-seen, current snapshot).
    * Click any chip → identity-card popover (displayName, kind,
      12-char fingerprint per crypto-spec §400, signingKeyId, participantId).

  "You": the chip whose `participantId === localParticipantId` carries
  a `(you)` label and skips the identity-card affordance.

  Reactive contract: subscribes to `reviewStore.peers` and re-renders on
  changes. Empty roster collapses the strip to nothing (no border, no dot).
-->

<script lang="ts">
  import { reviewStore } from './review/store.svelte';
  import {
    AGENT_GLYPH,
    chipVisualFor,
    isYou,
    shortenParticipantId,
    splitForStrip,
    tail6,
    type ChipVisual,
  } from './peer-strip-format';
  import { ownerKeyFingerprint } from './review/fingerprint';
  import { defaultFormatLastSeen } from './connection-badge-format';
  import type { ParticipantId, ReviewStatusPeer } from './types';
  import UnreadBadge from './UnreadBadge.svelte';

  interface Props {
    /**
     * The local participant's id, if known. Drives the `(you)` chip label
     * and disables the identity-card click for self. `null` means the
     * caller hasn't surfaced local identity yet; no chip is tagged.
     */
    localParticipantId?: ParticipantId | null;
    /**
     * Optional clock injection (ms since epoch). Defaults to `Date.now()`.
     * Tests can stub this for stable relative-time strings.
     */
    now?: () => number;
    /**
     * Optional override for the "last seen" formatter. Defaults to the
     * same minimal helper the connection badge uses.
     */
    formatLastSeen?: (timestampMs: number, nowMs: number) => string;
  }

  let {
    localParticipantId = null,
    now = () => Date.now(),
    formatLastSeen = defaultFormatLastSeen,
  }: Props = $props();

  // Identity-card popover state. `null` = nothing open; otherwise the
  // peer whose card is up. Only one card open at a time across the strip.
  let openIdentityFor = $state<ReviewStatusPeer | null>(null);
  // Overflow popover (the "+N" chip).
  let overflowOpen = $state(false);
  // Cache for fingerprints — async hash, keyed by participantId. The
  // identity-card popover reads this; recompute is rare (peers change
  // sparingly) and the result is small.
  const fingerprintCache = $state<Record<string, string>>({});
  // Hover-presence tooltip state. We track the hovered peer id (not the
  // full peer object) so the same peer hovered twice doesn't re-trigger
  // the effect.
  let hoveredPeerId = $state<string | null>(null);

  const peers: ReviewStatusPeer[] = $derived(reviewStore.peersResolved);
  const split = $derived(splitForStrip(peers));
  const unreadCount = $derived(reviewStore.currentRoomUnread);

  // When a peer's chip is clicked, kick off the fingerprint hash if we
  // don't already have it. The hash key is `participantId` (stable per
  // room) so we don't recompute for repeat clicks.
  async function ensureFingerprint(peer: ReviewStatusPeer): Promise<void> {
    if (fingerprintCache[peer.participantId] !== undefined) return;
    // The fingerprint helper accepts any string identifier — in production
    // this is the public signing key. We pass `deviceId + participantId`
    // as a stand-in until the bridge surfaces the raw key on `peer`.
    // The contract (12 hex chars grouped 4-4-4) is preserved either way.
    const material = `${peer.participantId}:${peer.deviceId}`;
    const fp = await ownerKeyFingerprint(material);
    fingerprintCache[peer.participantId] = fp;
  }

  function openCardFor(peer: ReviewStatusPeer): void {
    overflowOpen = false;
    openIdentityFor = peer;
    void ensureFingerprint(peer);
  }

  function closeCard(): void {
    openIdentityFor = null;
  }

  function toggleOverflow(): void {
    openIdentityFor = null;
    overflowOpen = !overflowOpen;
  }

  function closeOverflow(): void {
    overflowOpen = false;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (openIdentityFor !== null) {
      event.preventDefault();
      closeCard();
    } else if (overflowOpen) {
      event.preventDefault();
      closeOverflow();
    }
  }

  // Presence summary string for the hover tooltip. The strip itself shows
  // a green/grey dot via CSS, but the tooltip surfaces the words.
  function presenceLabel(peer: ReviewStatusPeer, _nowMs: number): string {
    // The bridge does not yet surface a per-peer `lastSeenMs`, so we do NOT
    // fabricate a relative time (it used to always say "5m ago"). Report
    // online/offline honestly; `formatLastSeen` stays a prop so a future
    // bridge update can light up real "last seen" without an API change.
    return peer.online ? 'currently viewing' : 'offline';
  }

  function snapshotLabel(peer: ReviewStatusPeer): string {
    if (peer.onSnapshotId === undefined) return 'no snapshot';
    return `snapshot ${peer.onSnapshotId.slice(0, 8)}`;
  }

  // Inline-style binding for the chip's background. The CSS var is stored
  // on the visual descriptor; the template injects it as
  // `background-color: var(--<bgVar>)`. We keep the lookup pure (read from
  // the descriptor) so the test harness can assert the same string.
  function chipStyle(visual: ChipVisual): string {
    return `background-color: var(--${visual.bgVar});`;
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if peers.length === 0 && unreadCount === 0}
  <!-- Empty strip per §7 — no border, no chips. The host (ReviewBar) keeps
       its own divider so this collapses cleanly. -->
  <div
    class="peer-strip-empty sr-only"
    data-slot="peer-strip"
    data-state="empty"
    aria-label="No peers"
  >
    No peers
  </div>
{:else}
  <div
    class="peer-strip relative inline-flex h-7 items-center gap-1"
    data-slot="peer-strip"
    data-state="active"
    data-peer-count={peers.length}
  >
    <UnreadBadge count={unreadCount} label="unread updates in this room" />
    {#each split.inline as peer (peer.participantId + ':' + peer.deviceId)}
      {@const visual = chipVisualFor(peer)}
      {@const youHere = isYou(peer, localParticipantId)}
      <div
        class="peer-strip-chip-wrapper relative inline-flex flex-col items-center"
        data-slot="peer-strip-chip-wrapper"
        data-you={youHere ? 'true' : 'false'}
        onmouseenter={() => (hoveredPeerId = peer.participantId)}
        onmouseleave={() => (hoveredPeerId = null)}
        role="presentation"
      >
        <button
          type="button"
          class="peer-chip relative inline-flex size-6 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          class:peer-chip-round={visual.shape === 'round'}
          class:peer-chip-hex={visual.shape === 'hex'}
          class:peer-chip-you={youHere}
          data-slot="peer-chip"
          data-kind={peer.kind}
          data-shape={visual.shape}
          data-online={peer.online ? 'true' : 'false'}
          style={chipStyle(visual)}
          aria-label={`${peer.displayName}${youHere ? ' (you)' : ''} — ${peer.kind}`}
          title={`${peer.displayName} · ${peer.kind} · ${presenceLabel(peer, now())}`}
          onclick={() => openCardFor(peer)}
        >
          {#if visual.content.kind === 'monogram'}
            <span aria-hidden="true">{visual.content.letter}</span>
          {:else}
            <span aria-hidden="true" class="peer-chip-glyph">{visual.content.glyph}</span>
          {/if}
          <!-- Presence dot pinned to bottom-right (presence-identity.md §4).
               Online = primary (green); offline = muted dim dot. -->
          <span
            class="absolute -bottom-0.5 -right-0.5 inline-block size-1.5 rounded-full border border-background"
            data-slot="peer-chip-presence"
            data-online={peer.online ? 'true' : 'false'}
            class:bg-primary={peer.online}
            class:bg-muted-foreground={!peer.online}
            aria-hidden="true"
          ></span>
        </button>
        {#if youHere}
          <span
            class="sr-only"
            data-slot="peer-chip-you-label"
          >
            (you)
          </span>
        {/if}

        {#if hoveredPeerId === peer.participantId && openIdentityFor === null}
          <!-- Presence-detail tooltip on hover (§7). Anchored under the
               chip; rendered as a sibling so the strip's flex flow handles
               positioning. -->
          <div
            class="absolute right-0 top-full z-[60] mt-2 w-48 rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground shadow-md"
            data-slot="peer-presence-tooltip"
            role="tooltip"
          >
            <div class="font-medium text-foreground">
              {peer.displayName}{#if youHere}&nbsp;<span class="text-muted-foreground">(you)</span>{/if}
            </div>
            <div class="text-muted-foreground" data-slot="peer-presence-status">
              {presenceLabel(peer, now())}
            </div>
            <div class="text-muted-foreground" data-slot="peer-presence-snapshot">
              {snapshotLabel(peer)}
            </div>
          </div>
        {/if}
      </div>
    {/each}

    {#if split.overflowCount > 0}
      <button
        type="button"
        class="peer-chip peer-chip-overflow inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 text-[10px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-slot="peer-chip-overflow"
        data-overflow-count={split.overflowCount}
        aria-haspopup="dialog"
        aria-expanded={overflowOpen}
        aria-label={`${split.overflowCount} more peers`}
        title={`${split.overflowCount} more peers`}
        onclick={toggleOverflow}
      >
        +{split.overflowCount}
      </button>
    {/if}

    {#if overflowOpen}
      <!-- Click-shield: clicking outside dismisses the overflow popover. -->
      <button
        type="button"
        class="fixed inset-0 z-40 cursor-default bg-transparent"
        data-slot="peer-strip-shield"
        aria-label="Close overflow"
        onclick={closeOverflow}
      ></button>
      <div
        class="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground shadow-md"
        data-slot="peer-strip-overflow-popover"
        role="dialog"
        aria-label="All peers"
      >
        <header class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {peers.length} peers
        </header>
        <ul class="flex flex-col gap-1" data-slot="peer-strip-overflow-list">
          {#each peers as peer (peer.participantId + ':' + peer.deviceId)}
            {@const visual = chipVisualFor(peer)}
            {@const youHere = isYou(peer, localParticipantId)}
            <li class="flex items-center gap-2" data-slot="peer-strip-overflow-row">
              <span
                class="inline-flex size-5 shrink-0 items-center justify-center text-[9px] font-semibold text-white"
                class:peer-chip-round={visual.shape === 'round'}
                class:peer-chip-hex={visual.shape === 'hex'}
                data-shape={visual.shape}
                style={chipStyle(visual)}
                aria-hidden="true"
              >
                {#if visual.content.kind === 'monogram'}
                  {visual.content.letter}
                {:else}
                  {visual.content.glyph}
                {/if}
              </span>
              <button
                type="button"
                class="flex-1 truncate text-left text-foreground hover:underline"
                onclick={() => {
                  closeOverflow();
                  openCardFor(peer);
                }}
              >
                {peer.displayName}{#if youHere}&nbsp;<span class="text-muted-foreground">(you)</span>{/if}
              </button>
              <span class="text-muted-foreground">{peer.kind}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if openIdentityFor !== null}
      {@const peer = openIdentityFor}
      {@const visual = chipVisualFor(peer)}
      {@const fp = fingerprintCache[peer.participantId] ?? '—— —— ——'}
      <!-- Click-shield for the identity card. -->
      <button
        type="button"
        class="fixed inset-0 z-40 cursor-default bg-transparent"
        data-slot="peer-strip-card-shield"
        aria-label="Close identity card"
        onclick={closeCard}
      ></button>
      <div
        class="absolute right-0 top-full z-[60] mt-1 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
        data-slot="peer-strip-identity-card"
        role="dialog"
        aria-label="Identity"
      >
        <header class="mb-2 flex items-start gap-2">
          <span
            class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center text-[12px] font-semibold text-white"
            class:peer-chip-round={visual.shape === 'round'}
            class:peer-chip-hex={visual.shape === 'hex'}
            data-shape={visual.shape}
            style={chipStyle(visual)}
            aria-hidden="true"
          >
            {#if visual.content.kind === 'monogram'}
              {visual.content.letter}
            {:else}
              {visual.content.glyph}
            {/if}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <span class="truncate" data-slot="identity-card-name">
                {peer.displayName}
              </span>
              <span
                class="rounded border border-border bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                data-slot="identity-card-kind"
              >
                {peer.kind}
              </span>
            </div>
            <div
              class="font-mono text-[10px] text-muted-foreground"
              data-slot="identity-card-tail6"
            >
              tail · {tail6(fp)}
            </div>
          </div>
        </header>

        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt class="text-muted-foreground">Fingerprint</dt>
          <dd class="font-mono" data-slot="identity-card-fingerprint">{fp}</dd>
          <dt class="text-muted-foreground">participantId</dt>
          <dd class="font-mono" data-slot="identity-card-participant-id">
            {shortenParticipantId(peer.participantId)}
          </dd>
          <dt class="text-muted-foreground">signingKeyId</dt>
          <dd class="font-mono" data-slot="identity-card-signing-key-id">
            {peer.deviceId.slice(0, 12)}
          </dd>
          <dt class="text-muted-foreground">Online</dt>
          <dd data-slot="identity-card-online">
            {peer.online ? 'currently viewing' : 'offline'}
          </dd>
        </dl>

        <footer class="mt-2 flex items-center justify-end">
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
            data-slot="identity-card-close"
            onclick={closeCard}
          >
            Close
          </button>
        </footer>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Round chip — humans (owner / reviewer). */
  :global(.peer-chip-round) {
    border-radius: 9999px;
  }

  /* Hex/diamond chip — agents. We use clip-path for a 6-sided polygon so
     the shape distinction survives at 20 px. Color comes from the inline
     `--peer-avatar-bg-agent` style; the path is shape-only. */
  :global(.peer-chip-hex) {
    border-radius: 6px;
    clip-path: polygon(
      25% 0%,
      75% 0%,
      100% 50%,
      75% 100%,
      25% 100%,
      0% 50%
    );
  }

  /* Self chip emphasis — 2 px inner ring per presence-identity.md open
     question 1 ("yes — a border is robust to narrow-width collapse"). */
  :global(.peer-chip-you) {
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  /* Agent glyph keeps the same baseline as letter monograms despite being
     a different character class. */
  :global(.peer-chip-glyph) {
    font-size: 0.85rem;
    line-height: 1;
  }
</style>
