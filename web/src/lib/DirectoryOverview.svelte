<script lang="ts">
  import type { TreeNode } from './types';
  import { resolveFileIcon, resolveFolderIcon } from '$lib/icon-resolver';
  import { getIconPack, subscribeIconPack } from '$lib/icon-pack';

  interface Props {
    path: string;
    rootPath?: string;
    entries: TreeNode[];
    onOpen?: (path: string, fileType: TreeNode['fileType']) => void;
  }

  let { path, rootPath = '', entries, onOpen }: Props = $props();

  let iconPack = $state(getIconPack());

  $effect(() => {
    const unsubscribe = subscribeIconPack((next) => {
      iconPack = next;
    });
    return unsubscribe;
  });

  function normalizePath(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    if (normalized === '/') return '/';
    return normalized.replace(/\/+$/, '');
  }

  function findNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | null {
    const target = normalizePath(targetPath);
    for (const node of nodes) {
      if (normalizePath(node.path) === target) {
        return node;
      }
      if (node.children && node.children.length > 0) {
        const found = findNodeByPath(node.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  let directoryNodes = $derived.by((): TreeNode[] => {
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(rootPath);

    if (normalizedPath && normalizedRoot && normalizedPath === normalizedRoot) {
      return entries;
    }

    const matched = findNodeByPath(entries, path);
    if (!matched || !matched.isDir) return [];
    return matched.children ?? [];
  });

  let directories = $derived(
    directoryNodes.filter((n) => n.isDir).sort((a, b) => a.name.localeCompare(b.name))
  );

  let files = $derived(
    directoryNodes.filter((n) => !n.isDir).sort((a, b) => a.name.localeCompare(b.name))
  );

  let sortedChildren = $derived([...directories, ...files]);

  let markdownCount = $derived(files.filter((n) => n.fileType === 'markdown').length);
  let dirCount = $derived(directories.length);

  let summaryParts = $derived.by((): string[] => {
    const parts: string[] = [];
    if (markdownCount > 0) parts.push(`${markdownCount} markdown`);
    const imageCount = files.filter((n) => n.fileType === 'image').length;
    if (imageCount > 0) parts.push(`${imageCount} image`);
    const videoCount = files.filter((n) => n.fileType === 'video').length;
    if (videoCount > 0) parts.push(`${videoCount} video`);
    const audioCount = files.filter((n) => n.fileType === 'audio').length;
    if (audioCount > 0) parts.push(`${audioCount} audio`);
    const otherCount = files.filter((n) =>
      n.fileType !== 'markdown' && n.fileType !== 'image' && n.fileType !== 'video' && n.fileType !== 'audio'
    ).length;
    if (otherCount > 0) parts.push(`${otherCount} other`);
    if (dirCount > 0) parts.push(`${dirCount} subdirector${dirCount === 1 ? 'y' : 'ies'}`);
    return parts;
  });

  let label = $derived(path.split('/').filter(Boolean).at(-1) ?? path);

  function iconSrc(node: TreeNode): string | null {
    // Force reactivity on iconPack changes
    void iconPack;
    if (node.isDir) {
      return resolveFolderIcon(node.name, false);
    }
    return resolveFileIcon(node.name, { includeMarkdown: true });
  }
</script>

<div class="directory-overview">
  <header class="directory-overview__header">
    <p class="directory-overview__eyebrow">Directory</p>
    <h2 class="directory-overview__title">{label || 'Workspace'}</h2>
    <p class="directory-overview__path">{path}</p>
    {#if summaryParts.length > 0}
      <p class="directory-overview__summary">{summaryParts.join(' \u00b7 ')}</p>
    {/if}
  </header>

  {#if sortedChildren.length > 0}
    <section class="directory-overview__grid" aria-label="Directory contents">
      {#each sortedChildren as node (node.path)}
        {@const icon = iconSrc(node)}
        <button
          type="button"
          class="directory-overview__card"
          onclick={() => onOpen?.(node.path, node.fileType)}
        >
          {#if icon}
            <img class="directory-overview__card-icon" src={icon} alt="" />
          {:else}
            <span class="directory-overview__card-dot" aria-hidden="true">&middot;</span>
          {/if}
          <span class="directory-overview__card-name" title={node.name}>{node.name}</span>
        </button>
      {/each}
    </section>
  {:else}
    <div class="directory-overview__empty">
      <p class="directory-overview__empty-title">Empty directory</p>
      <p class="directory-overview__empty-copy">
        This directory has no files or subdirectories in the loaded tree.
      </p>
    </div>
  {/if}
</div>

<style>
  .directory-overview {
    margin: 0 auto;
    width: min(940px, 100%);
    padding: 28px 24px 56px;
    display: grid;
    gap: 18px;
  }

  .directory-overview__header {
    display: grid;
    gap: 4px;
  }

  .directory-overview__eyebrow {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in oklch, var(--foreground) 55%, transparent);
  }

  .directory-overview__title {
    margin: 0;
    font-size: clamp(1.2rem, 2.4vw, 1.8rem);
    line-height: 1.15;
  }

  .directory-overview__path {
    margin: 0;
    font-size: 0.8rem;
    color: color-mix(in oklch, var(--foreground) 60%, transparent);
    word-break: break-all;
  }

  .directory-overview__summary {
    margin: 4px 0 0;
    font-size: 0.78rem;
    color: color-mix(in oklch, var(--foreground) 64%, transparent);
  }

  .directory-overview__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }

  .directory-overview__card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 14px 10px 12px;
    border: 1px solid color-mix(in oklch, var(--foreground) 11%, transparent);
    border-radius: 12px;
    background: color-mix(in oklch, var(--background) 86%, white 14%);
    cursor: pointer;
    font: inherit;
    color: inherit;
    text-align: center;
    transition: background 0.12s ease;
  }

  .directory-overview__card:hover {
    background: color-mix(in oklch, var(--background) 78%, white 22%);
  }

  .directory-overview__card-icon {
    width: 22px;
    height: 22px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .directory-overview__card-dot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    font-size: 1.6rem;
    line-height: 1;
    color: color-mix(in oklch, var(--foreground) 40%, transparent);
    flex-shrink: 0;
  }

  .directory-overview__card-name {
    font-size: 0.76rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    color: color-mix(in oklch, var(--foreground) 88%, transparent);
  }

  .directory-overview__empty {
    display: grid;
    gap: 4px;
    border: 1px solid color-mix(in oklch, var(--foreground) 11%, transparent);
    border-radius: 14px;
    background: color-mix(in oklch, var(--background) 93%, white 7%);
    padding: 14px;
  }

  .directory-overview__empty-title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: color-mix(in oklch, var(--foreground) 90%, transparent);
  }

  .directory-overview__empty-copy {
    margin: 0;
    font-size: 0.78rem;
    color: color-mix(in oklch, var(--foreground) 64%, transparent);
  }
</style>
