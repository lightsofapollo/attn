<!--
  Snapshot badge (attn-nnj.4.9, per planning/collab/data-model.md §UI/UX).

  Renders the snapshot control in the compact review dock. The older
  review-bar row used full text labels; this keeps those labels in aria/text
  for tests and screen readers, but only shows a small marker unless attention
  is needed.

  Owner perspective (kind === "owner"):
    - "Snapshot current"                    green   (file's latest snapshot)
    - "Snapshot superseded"                 grey, strikethrough + link to current
    - "Reviewer on older snapshot"          yellow  (one or more peers behind)
                                            hover → which reviewer + their snapshot age

  Reviewer perspective (kind !== "owner"):
    - "Snapshot @ 14:02"                    primary clock label of the snapshot
    - "(owner on newer snapshot)" pill      yellow, when peers indicate the owner
                                            has moved on to a newer snapshot

  Click → popover showing the full snapshot history (every snapshot for the
  active file, ordered newest-first), the role/kind splits across peers, and
  a manual snapshot-pick row that wires through `reviewStore.setCurrentSnapshot`.

  Owner-vs-reviewer detection: the parent passes the local participant's
  `kind` via the `localKind` prop (defaults to `"owner"` to match
  ReviewBar.svelte's defaulting). Falling back to owner is the safe default
  because the share/owner mint path is the only one calling 4.10 today; the
  reviewer wiring lands later in the Phase 2 sequence and will override
  explicitly.

  Visibility: collapses to nothing when there are no snapshots for the
  current file. The host row in 4.10 already does the outer `currentRoomId`
  visibility check.

  Self-contained popover (no bits-ui dependency): mirrors the approach used
  by ConnectionBadge.svelte — the host row is narrow and a portal-mounted
  popover would re-introduce z-index battles with the right-rail aside.
-->

<script lang="ts">
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import Camera from '@lucide/svelte/icons/camera';
  import History from '@lucide/svelte/icons/history';
  import {
    formatSnapshotAge,
    formatSnapshotClock,
  } from './snapshot-badge-format';
  import { reviewStore } from './review/store.svelte';
  import type { ReviewSnapshot, ReviewStatusPeer, SnapshotId } from './types';

  type LocalKind = 'owner' | 'reviewer' | 'agent';

  interface Props {
    /**
     * The kind of the local participant. Drives owner vs reviewer rendering.
     * Defaults to `"owner"` to match ReviewBar.svelte's existing default.
     */
    localKind?: LocalKind;
    /**
     * Optional clock injection (ms since epoch). Defaults to `Date.now()`.
     * Tests stub this for stable assertions.
     */
    now?: () => number;
  }

  let {
    localKind = 'owner',
    now = () => Date.now(),
  }: Props = $props();

  let popoverOpen = $state(false);

  // -------------------------------------------------------------------------
  // Snapshot selection
  // -------------------------------------------------------------------------

  // Snapshots for the currently-scoped file. The store keeps a flat list;
  // a more sophisticated index can come later. We filter by `currentFileId`
  // and sort newest-first by `createdAt`.
  const fileSnapshots: ReviewSnapshot[] = $derived(
    reviewStore.snapshots
      .filter((s) => s.fileId === reviewStore.currentFileId)
      .sort((a, b) => b.createdAt - a.createdAt),
  );

  // "Latest" (a.k.a. "current") snapshot is the newest one for the file
  // that itself isn't recorded as `supersedesSnapshotId` of a newer entry.
  // In practice the newest-by-createdAt usually wins, but we also build a
  // supersedes set so an explicit chain wins over wall-clock fudge.
  const supersededIds: Set<SnapshotId> = $derived.by(() => {
    const set = new Set<SnapshotId>();
    for (const s of reviewStore.snapshots) {
      if (s.supersedesSnapshotId !== undefined) set.add(s.supersedesSnapshotId);
    }
    return set;
  });

  const latestSnapshot: ReviewSnapshot | null = $derived.by(() => {
    for (const s of fileSnapshots) {
      if (!supersededIds.has(s.snapshotId)) return s;
    }
    return fileSnapshots[0] ?? null;
  });

  // The snapshot the local viewer is currently scoped to. `null` => caller
  // hasn't picked one; we fall back to the file's latest so the label always
  // reflects *something* coherent.
  const activeSnapshot: ReviewSnapshot | null = $derived.by(() => {
    const wanted = reviewStore.currentSnapshotId;
    if (wanted !== null) {
      return fileSnapshots.find((s) => s.snapshotId === wanted) ?? latestSnapshot;
    }
    return latestSnapshot;
  });

  // -------------------------------------------------------------------------
  // Perspective-aware label state
  // -------------------------------------------------------------------------

  type OwnerLabelKind = 'current' | 'superseded' | 'reviewer_on_older';

  /**
   * Owner-only verdict: green when on the latest snapshot, grey-strike when
   * the active snapshot was superseded, yellow when one or more reviewers
   * are stuck on a snapshot older than the latest.
   */
  const ownerLabel: OwnerLabelKind = $derived.by(() => {
    if (activeSnapshot === null || latestSnapshot === null) return 'current';
    const activeIsLatest =
      activeSnapshot.snapshotId === latestSnapshot.snapshotId;
    const activeWasSuperseded = supersededIds.has(activeSnapshot.snapshotId);
    if (activeWasSuperseded) return 'superseded';
    if (
      activeIsLatest
      && reviewStore.peerSplit.onOlderSnapshot.length > 0
    ) {
      return 'reviewer_on_older';
    }
    return 'current';
  });

  // Reviewers see the snapshot they're locked to as a clock label, plus a
  // small "(owner on newer snapshot)" warning when *any* peer (presumed
  // owner) is on a newer snapshot than the local one.
  const ownerOnNewerSnapshot: boolean = $derived.by(() => {
    if (activeSnapshot === null) return false;
    for (const peer of reviewStore.peers) {
      // Only flag if the peer is on the file's latest snapshot AND we're not.
      if (
        peer.kind === 'owner'
        && peer.onSnapshotId !== undefined
        && peer.onSnapshotId !== activeSnapshot.snapshotId
        && peer.onSnapshotId === latestSnapshot?.snapshotId
      ) {
        return true;
      }
    }
    return false;
  });

  // -------------------------------------------------------------------------
  // Hover detail for the owner "Reviewer on older snapshot" yellow chip
  // -------------------------------------------------------------------------

  /**
   * Older-snapshot reviewers, with a humanized age of *their* snapshot. Used
   * for the hover detail on the yellow owner warning.
   */
  interface OlderPeerDetail {
    peer: ReviewStatusPeer;
    snapshotAge: string;
  }

  const olderPeers: OlderPeerDetail[] = $derived.by(() => {
    const details: OlderPeerDetail[] = [];
    const t = now();
    for (const peer of reviewStore.peerSplit.onOlderSnapshot) {
      const snap = reviewStore.snapshots.find(
        (s) => s.snapshotId === peer.onSnapshotId,
      );
      const snapshotAge = snap !== undefined
        ? formatSnapshotAge(snap.createdAt, t)
        : 'unknown';
      details.push({ peer, snapshotAge });
    }
    return details;
  });

  // -------------------------------------------------------------------------
  // Click handlers (popover open/close, jump-to-latest link)
  // -------------------------------------------------------------------------

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

  function jumpToLatest(): void {
    if (latestSnapshot !== null) {
      reviewStore.setCurrentSnapshot(latestSnapshot.snapshotId);
    }
    closePopover();
  }

  function selectSnapshot(id: SnapshotId): void {
    reviewStore.setCurrentSnapshot(id);
    closePopover();
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if activeSnapshot !== null}
  <div
    class="snapshot-badge relative inline-flex shrink-0"
    data-slot="snapshot-badge"
    data-perspective={localKind === 'owner' ? 'owner' : 'reviewer'}
  >
    {#if localKind === 'owner'}
      <!--
        Owner view: three label states. Each chip is a button so clicking it
        opens the snapshot-history popover.
      -->
      {#if ownerLabel === 'current'}
        <button
          type="button"
          class="snapshot-chip inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/10 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-slot="snapshot-badge-chip"
          data-state="current"
          aria-label="Snapshot current"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          title="On the file's latest snapshot"
          onclick={togglePopover}
        >
          <Camera class="size-3 text-primary" aria-hidden="true" />
          <span class="sr-only">Snapshot current</span>
        </button>
      {:else if ownerLabel === 'superseded'}
        <!--
          Grey strikethrough chip with a sibling link that hops back to the
          latest snapshot. Sibling (not nested) because <button> in <button>
          is invalid HTML. The chip toggles the popover; the link jumps.
        -->
        <span
          class="snapshot-chip inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-muted/40 text-[11px] font-medium text-muted-foreground"
          data-slot="snapshot-badge-chip"
          data-state="superseded"
        >
          <button
            type="button"
            class="inline-flex h-full items-center gap-1.5 rounded-l-full px-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-slot="snapshot-badge-chip-button"
            aria-label="Snapshot superseded"
            aria-haspopup="dialog"
            aria-expanded={popoverOpen}
            title="This snapshot has been superseded — click to view current"
            onclick={togglePopover}
          >
            <Camera class="size-3 text-muted-foreground" aria-hidden="true" />
            <span class="line-through" data-slot="snapshot-badge-strike">
              Old
            </span>
            <span class="sr-only">
              Snapshot superseded
            </span>
          </button>
          <button
            type="button"
            class="snapshot-jump h-full rounded-r-full border-l border-border/60 bg-background/60 px-2 text-[10px] font-medium text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-slot="snapshot-badge-jump"
            aria-label="Jump to current snapshot"
            onclick={jumpToLatest}
          >
            current
          </button>
        </span>
      {:else}
        <!--
          Yellow warning: a reviewer is still on an older snapshot. Hover
          surfaces the per-reviewer detail (name + snapshot age) so the
          owner can decide whether to ping them.
        -->
        <button
          type="button"
          class="snapshot-chip inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-2 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-amber-300"
          data-slot="snapshot-badge-chip"
          data-state="reviewer_on_older"
          aria-label="Reviewer on older snapshot"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          title={olderPeers
            .map((d) => `${d.peer.displayName} · snapshot ${d.snapshotAge}`)
            .join(', ')}
          onclick={togglePopover}
        >
          <AlertTriangle
            class="size-3 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          <span>Older</span>
          <span class="sr-only">Reviewer on older snapshot</span>
        </button>
      {/if}
    {:else}
      <!--
        Reviewer view: "Snapshot @ HH:MM" primary label plus an optional
        warning pill when the owner has already moved on to a newer
        snapshot than the one we're locked to.
      -->
      <button
        type="button"
        class="snapshot-chip inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/35 bg-primary/10 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-slot="snapshot-badge-chip"
        data-state="reviewer_current"
        aria-label="Snapshot @ {formatSnapshotClock(activeSnapshot.createdAt)}"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        title="Reviewing snapshot · {formatSnapshotAge(activeSnapshot.createdAt, now())}"
        onclick={togglePopover}
      >
        <Camera class="size-3 text-primary" aria-hidden="true" />
        <span class="sr-only">Snapshot @ {formatSnapshotClock(activeSnapshot.createdAt)}</span>
      </button>
      {#if ownerOnNewerSnapshot}
        <span
          class="ml-1.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          data-slot="snapshot-badge-owner-newer"
          title="The owner is reviewing a newer snapshot than yours"
        >
          <AlertTriangle
            class="size-3 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          owner on newer snapshot
        </span>
      {/if}
    {/if}

    {#if popoverOpen}
      <!--
        Click-shield: dismisses the popover on any outside click. The same
        pattern used by ConnectionBadge — keeps the popover entirely local.
      -->
      <button
        type="button"
        class="fixed inset-0 z-40 cursor-default bg-transparent"
        data-slot="snapshot-badge-shield"
        aria-label="Close snapshot history"
        onclick={closePopover}
      ></button>

      <div
        class="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
        data-slot="snapshot-badge-popover"
        role="dialog"
        aria-label="Snapshot history"
      >
        <header class="mb-2 flex items-center gap-1.5">
          <History class="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span class="text-sm font-medium">Snapshot history</span>
        </header>

        {#if fileSnapshots.length === 0}
          <p class="text-[11px] text-muted-foreground">
            No snapshots yet for this file.
          </p>
        {:else}
          <ul
            class="flex flex-col gap-1 text-[11px]"
            data-slot="snapshot-badge-history"
          >
            {#each fileSnapshots as snap (snap.snapshotId)}
              {@const isActive = snap.snapshotId === activeSnapshot?.snapshotId}
              {@const isLatest = snap.snapshotId === latestSnapshot?.snapshotId}
              {@const isSuperseded = supersededIds.has(snap.snapshotId)}
              <li
                class="flex items-center justify-between gap-2 rounded px-1.5 py-1 transition-colors hover:bg-muted/60"
                data-slot="snapshot-badge-history-row"
                data-snapshot-id={snap.snapshotId}
                data-active={isActive ? 'true' : 'false'}
                data-latest={isLatest ? 'true' : 'false'}
                data-superseded={isSuperseded ? 'true' : 'false'}
              >
                <button
                  type="button"
                  class="flex flex-1 items-center gap-1.5 text-left"
                  data-slot="snapshot-badge-history-pick"
                  onclick={() => selectSnapshot(snap.snapshotId)}
                >
                  <span
                    class="font-mono text-[10px] text-muted-foreground"
                    data-slot="snapshot-badge-clock"
                  >
                    {formatSnapshotClock(snap.createdAt)}
                  </span>
                  <span
                    class="truncate font-medium"
                    class:line-through={isSuperseded}
                    data-slot="snapshot-badge-age"
                  >
                    {formatSnapshotAge(snap.createdAt, now())}
                  </span>
                </button>
                <span
                  class="shrink-0 text-[10px] text-muted-foreground"
                  data-slot="snapshot-badge-flag"
                >
                  {#if isLatest}
                    latest
                  {:else if isSuperseded}
                    superseded
                  {:else}
                    older
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if localKind === 'owner' && olderPeers.length > 0}
          <ul
            class="mt-2 flex flex-col gap-1 border-t border-border/50 pt-2 text-[11px]"
            data-slot="snapshot-badge-older-peers"
          >
            {#each olderPeers as detail (detail.peer.deviceId)}
              <li
                class="flex items-center justify-between gap-2"
                data-slot="snapshot-badge-older-peer"
              >
                <span class="truncate font-medium text-foreground">
                  {detail.peer.displayName}
                </span>
                <span class="shrink-0 text-muted-foreground">
                  on {detail.snapshotAge}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        <footer class="flex items-center justify-end gap-2 pt-2">
          {#if ownerLabel === 'superseded' && localKind === 'owner'}
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
              data-slot="snapshot-badge-jump-latest"
              onclick={jumpToLatest}
            >
              Jump to current
            </button>
          {/if}
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
            data-slot="snapshot-badge-dismiss"
            onclick={closePopover}
          >
            Close
          </button>
        </footer>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Stack the inner [current] link so it sits cleanly inside the chip with
     a faint border that won't fight the chip's rounded outline. */
  .snapshot-chip > .snapshot-jump {
    margin-left: 0.25rem;
  }
</style>
