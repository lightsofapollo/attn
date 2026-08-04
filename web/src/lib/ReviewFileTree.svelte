<!--
  ReviewFileTree — the shared room's files as a navigable folder tree.

  Mounted in the sidebar when the local participant is a reviewer in a room
  (App passes the gate). A folder-share publishes one snapshot per *.md file
  across subfolders; this groups them back into a tree (see
  ./review/shared-tree.ts) so a reviewer can browse the shared project the way
  the owner sees it, not just the flat top strip.

  Files navigate by `fileId` (snapshots are decoupled from filesystem paths),
  so clicking calls `reviewStore.setCurrentFile(fileId)`. Renders nothing when
  there are no shared files. No emoji, no window.confirm/alert (per CLAUDE.md).
-->

<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileText from '@lucide/svelte/icons/file-text';
  import { reviewStore } from './review/store.svelte';
  import { deriveSharedTree, type SharedTreeNode } from './review/shared-tree';
  import UnreadBadge from './UnreadBadge.svelte';

  const tree = $derived(deriveSharedTree(reviewStore.snapshots, reviewStore.currentRoomId));
  // Folders are expanded by default; track the COLLAPSED set so new folders
  // appearing live (owner adds a file) start open.
  let collapsed = $state<Set<string>>(new Set());

  function toggle(path: string): void {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }
</script>

{#snippet nodes(list: SharedTreeNode[], depth: number)}
  {#each list as node (node.kind === 'folder' ? 'd:' + node.path : 'f:' + node.fileId)}
    {#if node.kind === 'folder'}
      <button
        type="button"
        class="review-tree-row review-tree-folder"
        style={`padding-left: ${depth * 0.75 + 0.5}rem;`}
        data-slot="shared-file-tree-folder"
        data-folder-path={node.path}
        aria-expanded={!collapsed.has(node.path)}
        onclick={() => toggle(node.path)}
      >
        <ChevronRight
          class="review-tree-chevron size-3.5 shrink-0 transition-transform {collapsed.has(node.path) ? '' : 'rotate-90'}"
          aria-hidden="true"
        />
        <span class="truncate">{node.name}</span>
      </button>
      {#if !collapsed.has(node.path)}
        {@render nodes(node.children, depth + 1)}
      {/if}
    {:else}
      <button
        type="button"
        class="review-tree-row review-tree-file"
        class:active={node.fileId === reviewStore.currentFileId}
        style={`padding-left: ${depth * 0.75 + 0.5}rem;`}
        data-slot="shared-file-tree-file"
        data-file-id={node.fileId}
        title={node.relPath}
        onclick={() => reviewStore.selectFileAsUser(node.fileId)}
      >
        <FileText class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{node.name}</span>
        {#if node.fileId === reviewStore.currentFileId}
          <UnreadBadge
            count={reviewStore.currentRoomUnread}
            label="unread updates for this shared room"
          />
        {/if}
      </button>
    {/if}
  {/each}
{/snippet}

{#if tree.length > 0}
  <nav class="review-file-tree" data-slot="shared-file-tree" aria-label="Shared files">
    {@render nodes(tree, 0)}
  </nav>
{/if}

<style>
  .review-file-tree {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0.25rem 0.35rem;
  }

  .review-tree-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    min-width: 0;
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
    padding-right: 0.5rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    line-height: 1.1;
    text-align: left;
    color: var(--muted-foreground);
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .review-tree-row:hover {
    background: var(--accent);
    color: var(--accent-foreground, inherit);
  }

  .review-tree-file.active {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
    font-weight: 500;
  }

  .review-tree-folder {
    font-weight: 500;
    color: var(--foreground, inherit);
  }
</style>
