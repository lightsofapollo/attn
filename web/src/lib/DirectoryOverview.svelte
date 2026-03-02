<script lang="ts">
  import type { TreeNode } from './types';

  interface Props {
    path: string;
    rootPath?: string;
    entries: TreeNode[];
    onOpen?: (path: string) => void;
  }

  let { path, rootPath = '', entries, onOpen }: Props = $props();

  type OverviewStats = {
    markdown: number;
    image: number;
    video: number;
    audio: number;
    directories: number;
  };

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

  function collectStats(nodes: TreeNode[]): OverviewStats {
    const stats: OverviewStats = {
      markdown: 0,
      image: 0,
      video: 0,
      audio: 0,
      directories: 0,
    };

    for (const node of nodes) {
      if (node.isDir) {
        stats.directories += 1;
        if (node.children && node.children.length > 0) {
          const childStats = collectStats(node.children);
          stats.markdown += childStats.markdown;
          stats.image += childStats.image;
          stats.video += childStats.video;
          stats.audio += childStats.audio;
          stats.directories += childStats.directories;
        }
        continue;
      }

      if (node.fileType === 'markdown') stats.markdown += 1;
      if (node.fileType === 'image') stats.image += 1;
      if (node.fileType === 'video') stats.video += 1;
      if (node.fileType === 'audio') stats.audio += 1;
    }

    return stats;
  }

  function findFirstPreviewable(nodes: TreeNode[]): string | null {
    for (const node of nodes) {
      if (node.isDir && node.children && node.children.length > 0) {
        const nested = findFirstPreviewable(node.children);
        if (nested) return nested;
      } else if (!node.isDir && node.fileType !== 'unsupported' && node.fileType !== 'directory') {
        return node.path;
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

  let stats = $derived(collectStats(directoryNodes));
  let firstPreviewablePath = $derived(findFirstPreviewable(directoryNodes));
  let previewableCount = $derived(stats.markdown + stats.image + stats.video + stats.audio);
  let label = $derived(path.split('/').filter(Boolean).at(-1) ?? path);
</script>

<div class="directory-overview">
  <header class="directory-overview__header">
    <p class="directory-overview__eyebrow">Directory</p>
    <h2 class="directory-overview__title">{label || 'Workspace'}</h2>
    <p class="directory-overview__path">{path}</p>
  </header>

  <section class="directory-overview__stats" aria-label="Directory statistics">
    <article class="directory-overview__stat-card">
      <p class="directory-overview__stat-label">Markdown</p>
      <p class="directory-overview__stat-value">{stats.markdown}</p>
    </article>
    <article class="directory-overview__stat-card">
      <p class="directory-overview__stat-label">Images</p>
      <p class="directory-overview__stat-value">{stats.image}</p>
    </article>
    <article class="directory-overview__stat-card">
      <p class="directory-overview__stat-label">Video</p>
      <p class="directory-overview__stat-value">{stats.video}</p>
    </article>
    <article class="directory-overview__stat-card">
      <p class="directory-overview__stat-label">Audio</p>
      <p class="directory-overview__stat-value">{stats.audio}</p>
    </article>
    <article class="directory-overview__stat-card">
      <p class="directory-overview__stat-label">Subdirectories</p>
      <p class="directory-overview__stat-value">{stats.directories}</p>
    </article>
  </section>

  <section class="directory-overview__actions" aria-label="Directory actions">
    {#if firstPreviewablePath}
      <button
        type="button"
        class="directory-overview__open-first"
        onclick={() => onOpen?.(firstPreviewablePath)}
      >
        Open first previewable file
      </button>
      <p class="directory-overview__hint">First match: {firstPreviewablePath}</p>
    {:else}
      <div class="directory-overview__empty">
        <p class="directory-overview__empty-title">No previewable files yet</p>
        <p class="directory-overview__empty-copy">
          This directory currently has no markdown, image, video, or audio files in the loaded tree.
        </p>
      </div>
    {/if}
  </section>

  {#if previewableCount > 0}
    <p class="directory-overview__loaded-note">
      Summary is based on currently loaded tree data.
    </p>
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

  .directory-overview__stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }

  .directory-overview__stat-card {
    border: 1px solid color-mix(in oklch, var(--foreground) 11%, transparent);
    border-radius: 12px;
    background: color-mix(in oklch, var(--background) 86%, white 14%);
    padding: 12px;
    display: grid;
    gap: 2px;
  }

  .directory-overview__stat-label {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: color-mix(in oklch, var(--foreground) 62%, transparent);
  }

  .directory-overview__stat-value {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 640;
    color: color-mix(in oklch, var(--foreground) 95%, transparent);
  }

  .directory-overview__actions {
    border: 1px solid color-mix(in oklch, var(--foreground) 11%, transparent);
    border-radius: 14px;
    background: color-mix(in oklch, var(--background) 93%, white 7%);
    padding: 14px;
    display: grid;
    gap: 10px;
  }

  .directory-overview__open-first {
    width: fit-content;
    border: 1px solid color-mix(in oklch, var(--foreground) 18%, transparent);
    background: color-mix(in oklch, var(--accent) 62%, var(--background) 38%);
    color: color-mix(in oklch, var(--foreground) 98%, transparent);
    border-radius: 10px;
    padding: 7px 10px;
    font-size: 0.82rem;
    font-weight: 580;
    cursor: pointer;
  }

  .directory-overview__open-first:hover {
    background: color-mix(in oklch, var(--accent) 72%, var(--background) 28%);
  }

  .directory-overview__hint,
  .directory-overview__loaded-note,
  .directory-overview__empty-copy {
    margin: 0;
    font-size: 0.78rem;
    color: color-mix(in oklch, var(--foreground) 64%, transparent);
    word-break: break-word;
  }

  .directory-overview__empty {
    display: grid;
    gap: 4px;
  }

  .directory-overview__empty-title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: color-mix(in oklch, var(--foreground) 90%, transparent);
  }

  .directory-overview__loaded-note {
    margin-top: -2px;
  }
</style>
