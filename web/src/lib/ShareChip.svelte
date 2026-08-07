<!--
  ShareChip — the single share-status control in the review dock.

  Replaces the former three-widget cluster (icon-only share pill +
  SharedFilesBadge + ConnectionBadge): one chip that says what is shared and
  whether it's syncing, and one popover that answers every share question in
  place — status in plain English, the exact files a reviewer can see, who is
  here (including your own identity), and the management actions.

  Owner chip:    [·] Sharing · plan.md      (dot carries connection state)
  Reviewer chip: [·] Connected              (scope lives in the popover)

  The popover is a self-contained absolutely-positioned card (no bits-ui
  Popover) because the chip lives in the overflow-prone review-bar row and a
  portal would fight the right-rail aside for z-index. Transport states map to
  user-facing status via share-chip-model.ts — mailbox and direct_failed both
  read "Connected" by design (the relay path works; not an error).
-->

<script lang="ts">
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import FileText from '@lucide/svelte/icons/file-text';
  import Share2 from '@lucide/svelte/icons/share-2';
  import Wifi from '@lucide/svelte/icons/wifi';
  import Zap from '@lucide/svelte/icons/zap';
  import { reviewStore } from './review/store.svelte';
  import { userProfile } from './profile.svelte';
  import { deriveSharedFiles } from './review/shared-tree';
  import {
    SHARE_CHIP_DESCRIPTORS,
    peerPresenceLabel,
    resolveConnection,
    shareChipLabel,
  } from './share-chip-model';
  import type { ReviewStatusPeer } from './types';

  interface Props {
    /** True when the current device is the room owner. */
    isOwner?: boolean;
    /** Whether the share sheet/dialog is open (anchors the chip pre-mint). */
    shareOpen?: boolean;
    /** Opens the share sheet / dialog — the management surface. */
    onManageShare?: () => void;
    /** Attempts to upgrade to a direct peer-to-peer link (parent-owned). */
    onReconnect?: () => void;
    /**
     * Collapse the chip to a single glyph sized like its neighbouring header
     * buttons. The native header is a 44px strip that also has to hold the
     * document name, the snapshot badge, the comments toggle and settings —
     * "Sharing · some-long-file.md" was taking a third of it to say something
     * that rarely changes. The connection glyph still distinguishes the three
     * states without colour, and the full label, the status word and the file
     * count all stay in the accessible name / `title` / sr-only slots, so the
     * standing disclosure survives the collapse. Text surfaces (hosted owner
     * header) leave this off.
     */
    compact?: boolean;
  }

  let {
    isOwner = true,
    shareOpen = false,
    onManageShare,
    onReconnect,
    compact = false,
  }: Props = $props();

  let popoverOpen = $state(false);

  const hasActiveRoom = $derived(reviewStore.currentRoomId !== null);
  const connection = $derived(resolveConnection(reviewStore.status, reviewStore.connection));
  const descriptor = $derived(SHARE_CHIP_DESCRIPTORS[connection]);
  const files = $derived(deriveSharedFiles(reviewStore.snapshots, reviewStore.currentRoomId));
  const peers: ReviewStatusPeer[] = $derived(reviewStore.peersResolved);
  const outboxPending = $derived(reviewStore.status?.outboxPending ?? 0);
  const label = $derived(shareChipLabel(isOwner, descriptor, files, hasActiveRoom));
  /** Named separately from the prop so the markup reads as a layout mode. */
  const iconOnly = $derived(compact);

  function toggle(): void {
    // Pre-mint (sheet open, no room yet) the chip is a spatial anchor that
    // routes back to the management surface instead of an empty popover.
    if (!hasActiveRoom) {
      onManageShare?.();
      return;
    }
    popoverOpen = !popoverOpen;
  }

  function close(): void {
    popoverOpen = false;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && popoverOpen) {
      event.preventDefault();
      close();
    }
  }

  function handleManage(): void {
    close();
    onManageShare?.();
  }

  function handleReconnect(): void {
    onReconnect?.();
    close();
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if hasActiveRoom || (isOwner && shareOpen)}
  <div class="share-chip relative inline-flex shrink-0" data-slot="share-chip-root">
    <button
      type="button"
      class="chip inline-flex h-7 shrink-0 items-center rounded-full border font-sans text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
        {iconOnly ? 'w-7 justify-center' : 'max-w-[15rem] gap-1.5 px-2.5'}
        {connection === 'offline' && hasActiveRoom
          ? 'border-border/60 bg-muted/20 text-muted-foreground/80 hover:bg-muted/40'
          : 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'}"
      data-slot="share-chip"
      data-state={connection}
      data-active={hasActiveRoom}
      data-compact={iconOnly}
      data-file-count={files.length}
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      aria-label={hasActiveRoom ? `${label} — ${descriptor.label}` : 'Share for review'}
      title={hasActiveRoom ? `${label} — ${descriptor.detail}` : 'Share for review'}
      onclick={toggle}
    >
      {#if !hasActiveRoom}
        <!-- 14px collapsed, matching both the state glyphs below and the
             header's own share button; 12px stays the inline-with-text size. -->
        <Share2 class={`shrink-0 ${iconOnly ? 'size-3.5' : 'size-3'}`} aria-hidden="true" />
      {:else if iconOnly}
        <!-- The glyph carries the state that the dot + word used to split
             between colour and text, and matches the popover header so the
             chip and the panel it opens agree at a glance. -->
        {#if descriptor.icon === 'live'}
          <Zap class="size-3.5 shrink-0" aria-hidden="true" />
        {:else if descriptor.icon === 'connected'}
          <Wifi class="size-3.5 shrink-0" aria-hidden="true" />
        {:else}
          <CloudOff class="size-3.5 shrink-0" aria-hidden="true" />
        {/if}
      {:else}
        <span
          class="size-1.5 shrink-0 rounded-full
            {descriptor.tone === 'offline' ? 'bg-muted-foreground/70' : 'bg-primary'}
            {descriptor.tone === 'live' ? 'share-chip-dot-live' : ''}"
          aria-hidden="true"
        ></span>
      {/if}
      <!-- Never dropped, only hidden: automation and assistive tech read the
           label from the same node on every surface. -->
      <span class={iconOnly ? 'sr-only' : 'truncate'} data-slot="share-chip-label">{label}</span>
      {#if hasActiveRoom && files.length > 0}
        <span class="sr-only" data-slot="share-chip-files">{files.length}</span>
      {/if}
      <span class="sr-only" data-slot="share-chip-status">{descriptor.label}</span>
    </button>

    {#if popoverOpen}
      <button
        type="button"
        class="fixed inset-0 z-50 cursor-default bg-transparent"
        data-slot="share-chip-shield"
        aria-label="Close share details"
        onclick={close}
      ></button>

      <div
        class="absolute right-0 top-full z-[60] mt-1 w-80 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
        data-slot="share-chip-popover"
        role="dialog"
        aria-label="Share details"
      >
        <header class="flex items-start gap-2 px-3 pb-2.5 pt-3">
          {#if descriptor.icon === 'live'}
            <Zap class="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {:else if descriptor.icon === 'connected'}
            <Wifi class="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {:else}
            <CloudOff class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {/if}
          <div class="min-w-0">
            <p class="text-sm font-medium {descriptor.tone === 'offline' ? 'text-muted-foreground' : 'text-primary'}">
              {descriptor.label}
            </p>
            <p class="pt-0.5 text-xs text-muted-foreground" data-slot="share-chip-detail">
              {descriptor.detail}
            </p>
            {#if outboxPending > 0}
              <p class="pt-1 text-[11px] text-muted-foreground" data-slot="share-chip-outbox">
                {outboxPending} change{outboxPending === 1 ? '' : 's'} waiting to sync…
              </p>
            {/if}
          </div>
        </header>

        {#if files.length > 0}
          <section class="border-t border-border/50 px-3 py-2.5" aria-label="Shared files">
            <h3 class="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {isOwner
                ? `Reviewers can see ${files.length === 1 ? 'this file' : `these ${files.length} files`}`
                : `Shared with you · ${files.length === 1 ? '1 file' : `${files.length} files`}`}
            </h3>
            <ul class="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0">
              {#each files as f (f.fileId)}
                <li class="flex items-start gap-1.5" data-slot="share-chip-file-row">
                  <FileText class="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden="true" />
                  <div class="min-w-0">
                    <div class="truncate text-xs text-foreground" title={f.name}>{f.name}</div>
                    {#if f.relPath && f.relPath !== f.name}
                      <div
                        class="truncate font-mono text-[10px] text-muted-foreground"
                        title={f.relPath}
                      >
                        {f.relPath}
                      </div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="border-t border-border/50 px-3 py-2.5" aria-label="People">
          <div class="flex items-center justify-between gap-2" data-slot="share-chip-identity">
            <span class="min-w-0 truncate text-[11px] text-muted-foreground">
              You:
              <span class="font-medium text-foreground" data-slot="share-chip-self-name">
                {userProfile.effectiveName}
              </span>
            </span>
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
              data-slot="share-chip-edit-name"
              onclick={() => {
                userProfile.requestEdit();
                close();
              }}
            >
              Edit
            </button>
          </div>
          {#if peers.length === 0}
            <p class="pt-1.5 text-[11px] text-muted-foreground" data-slot="share-chip-no-peers">
              No one else is here right now.
            </p>
          {:else}
            <ul class="m-0 flex list-none flex-col gap-1 p-0 pt-1.5 text-[11px]" data-slot="share-chip-peer-list">
              {#each peers as peer (peer.deviceId)}
                <li
                  class="flex items-center justify-between gap-2"
                  data-slot="share-chip-peer"
                  data-online={peer.online ? 'true' : 'false'}
                >
                  <span class="flex min-w-0 items-center gap-1.5 truncate font-medium text-foreground">
                    <span
                      class="inline-block size-1.5 shrink-0 rounded-full"
                      class:bg-primary={peer.online}
                      class:bg-muted-foreground={!peer.online}
                      aria-hidden="true"
                    ></span>
                    <span class="truncate">{peer.displayName}</span>
                  </span>
                  <span class="shrink-0 text-muted-foreground">{peerPresenceLabel(peer.online)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if (descriptor.canTryFaster && onReconnect) || (isOwner && onManageShare)}
          <footer class="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-2">
            <div>
              {#if descriptor.canTryFaster && onReconnect}
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                  data-slot="share-chip-reconnect"
                  onclick={handleReconnect}
                >
                  Try a faster connection
                </button>
              {/if}
            </div>
            {#if isOwner && onManageShare}
              <button
                type="button"
                class="rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                data-slot="share-chip-manage"
                onclick={handleManage}
              >
                Manage sharing
              </button>
            {/if}
          </footer>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Live = instant peer-to-peer: a single soft ring on entry conveys the
     state change without ambient animation. */
  .share-chip-dot-live {
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary, currentColor) 20%, transparent);
  }
</style>
