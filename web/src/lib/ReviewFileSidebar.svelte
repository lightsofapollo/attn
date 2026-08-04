<!--
  ReviewFileSidebar — desktop file rail for a folder-share review.

  A multi-file share used to render as a horizontal tab strip above the
  document, which read as a different product than the owner's workspace
  shell. This sidebar mirrors the workspace's left-rail grammar — a titled
  file list you are *inside of* — so joining a shared folder feels like
  standing in one of N workspaces that happens to be shared with you.

  Renders NOTHING for single-file shares (the document header names the doc).
  The phone layout keeps the compact `ReviewFileNav` strip; this rail is
  mounted by `BrowserReviewApp` only at the desktop breakpoint.

  Same store contract as ReviewFileNav: `deriveFileEntries` for the rows,
  `latestRenderableSnapshotId` for activation.
-->

<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
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
  <aside
    class="review-file-sidebar flex w-56 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/20"
    data-slot="review-file-sidebar"
    aria-label="Shared files"
  >
    <header class="shrink-0 px-3 pb-2 pt-3">
      <p class="font-sans text-sm font-semibold text-foreground">Shared with you</p>
      <p class="pt-0.5 text-[11px] text-muted-foreground">
        {files.length} files · end-to-end encrypted
      </p>
    </header>
    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
        {#each files as f (f.fileId)}
          <li>
            <button
              type="button"
              class="review-file-row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              class:active={f.fileId === reviewStore.currentFileId}
              data-file-id={f.fileId}
              aria-current={f.fileId === reviewStore.currentFileId ? 'true' : undefined}
              title={`${f.dir ? `${f.dir}/` : ''}${f.fileName ?? f.name}${f.fileName && f.name !== f.fileName ? ` — ${f.name}` : ''}`}
              onclick={() => selectFile(f.fileId)}
            >
              <FileText class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
              <!-- Filename is the identity and never truncates away; the
                   heading title tags along and gives way first when the rail
                   is tight (user ruling: file name + title when there is
                   room, just file name when there is not). -->
              <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span class="shrink-0 truncate" style="max-width: 100%;">
                  {#if f.dir}
                    <span class="text-muted-foreground/60">{f.dir}/</span>
                  {/if}{f.fileName ?? f.name}
                </span>
                {#if f.fileName && f.name !== f.fileName}
                  <span class="min-w-0 truncate text-[11px] text-muted-foreground/70">{f.name}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>
{/if}

<style>
  /* Active row matches the workspace sidebar's selected-file treatment. */
  .review-file-row.active {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    color: var(--primary);
    font-weight: 500;
  }
</style>
