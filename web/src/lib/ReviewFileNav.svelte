<!--
  ReviewFileNav — reviewer's per-file switcher for a folder-share room.

  A folder-share publishes one snapshot per *.md file into a single review
  room (and republishes on create/edit), so a reviewer's `reviewStore` can
  hold snapshots spanning many files. Without this nav a reviewer only ever
  sees the auto-selected first file. This renders a compact horizontal strip
  of buttons — one per file — that calls `reviewStore.setCurrentFile(fileId)`.

  Renders NOTHING when there are fewer than two files (single-file shares look
  exactly as they did before). All grouping / naming logic lives in the pure
  `deriveFileEntries` helper so it is unit-tested without the runes store.

  No emoji, no window.confirm/alert (per CLAUDE.md).
-->

<script lang="ts">
  import { reviewStore } from './review/store.svelte';
  import { deriveFileEntries, latestRenderableSnapshotId } from './review/file-nav';

  const files = $derived(deriveFileEntries(reviewStore.snapshots, reviewStore.currentRoomId));

  function selectFile(fileId: (typeof files)[number]['fileId']): void {
    reviewStore.selectFileAsUser(fileId);
    reviewStore.setCurrentSnapshot(
      latestRenderableSnapshotId(reviewStore.snapshots, reviewStore.currentRoomId, fileId),
    );
  }
</script>

{#if files.length >= 2}
  <nav
    class="review-file-nav flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5"
    data-slot="review-file-nav"
    aria-label="Shared files"
  >
    {#each files as f (f.fileId)}
      <button
        type="button"
        class="review-file-tab inline-flex h-6 max-w-[16rem] items-center gap-1 truncate rounded-full border border-transparent px-2.5 text-micro font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        class:active={f.fileId === reviewStore.currentFileId}
        data-file-id={f.fileId}
        title={f.dir ? `${f.dir}/${f.name}` : f.name}
        onclick={() => selectFile(f.fileId)}
      >
        {#if f.dir}
          <span class="review-file-dir text-muted-foreground/60" data-slot="review-file-dir">{f.dir}/</span>
        {/if}
        <span class="truncate">{f.name}</span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  /* Active tab gets the app's primary accent treatment, matching the
     snapshot/peer chips elsewhere in the review chrome. */
  .review-file-tab.active {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
  }

  @media (pointer: coarse) {
    .review-file-tab {
      min-height: 44px;
    }
  }
</style>
