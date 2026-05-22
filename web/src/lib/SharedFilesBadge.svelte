<!--
  SharedFilesBadge — names WHAT is currently shared, next to the Share pill.

  The bare "Sharing" icon reads as "everything is shared", which is wrong: a
  share is scoped to one file or one folder's *.md files. This badge surfaces
  that scope — the filename for a single-file share, or "N files" for a
  folder share — and a click reveals the full list (with subfolder paths) so
  the owner can see exactly what a reviewer can see.

  Reads the shared snapshots straight from the store (same source the reviewer
  navigation uses), so it stays correct as the owner adds files live. Renders
  nothing until at least one file has been published. No emoji, no
  window.confirm/alert (per CLAUDE.md).
-->

<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import { reviewStore } from './review/store.svelte';
  import { deriveSharedFiles } from './review/shared-tree';

  const files = $derived(deriveSharedFiles(reviewStore.snapshots, reviewStore.currentRoomId));
  const label = $derived(
    files.length === 1 ? files[0].name : `${files.length} files`,
  );

  let open = $state(false);
  function toggle(): void { open = !open; }
  function close(): void { open = false; }
  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if files.length > 0}
  <div class="shared-files-badge relative inline-flex shrink-0" data-slot="share-status">
    <button
      type="button"
      class="inline-flex h-7 max-w-[12rem] items-center gap-1 rounded-md border border-border/50 bg-background/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      data-slot="share-status-files"
      data-file-count={files.length}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={files.length === 1 ? `Sharing ${files[0].relPath}` : `Sharing ${files.length} files`}
      onclick={toggle}
    >
      <FileText class="size-3 shrink-0 opacity-70" aria-hidden="true" />
      <span class="truncate">{label}</span>
    </button>

    {#if open}
      <button
        type="button"
        class="fixed inset-0 z-50 cursor-default bg-transparent"
        data-slot="share-status-shield"
        aria-label="Close shared files"
        onclick={close}
      ></button>
      <div
        class="absolute right-0 top-full z-[60] mt-1 w-64 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
        data-slot="share-status-list"
        role="dialog"
        aria-label="Shared files"
      >
        <header class="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Sharing {files.length === 1 ? 'this file' : `these ${files.length} files`}
        </header>
        <ul class="flex max-h-64 flex-col gap-0.5 overflow-y-auto text-[11px]">
          {#each files as f (f.fileId)}
            <li
              class="flex items-center gap-1.5 rounded px-1.5 py-1 text-foreground"
              data-slot="share-status-row"
            >
              <FileText class="size-3 shrink-0 opacity-60" aria-hidden="true" />
              <span class="truncate font-mono text-[10px]" title={f.relPath}>{f.relPath}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
