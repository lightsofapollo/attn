<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import { openExternal } from './ipc';
  import {
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
  } from '$lib/components/ui/sidebar';
  import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
  } from '$lib/components/ui/context-menu';
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from '$lib/components/ui/collapsible';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Share2 from '@lucide/svelte/icons/share-2';
  import UnreadBadge from './UnreadBadge.svelte';
  import type { FileIconResolver } from './file-icon-resolver';
  import {
    sidebarPresenceBadgeForNode,
    type SidebarPresenceLocation,
  } from './sidebar-presence';

  interface Props {
    nodes: TreeNode[];
    activePath?: string;
    depth?: number;
    rootPath?: string;
    onNavigate?: (path: string, newTab: boolean) => void;
    onExpand?: (path: string) => void;
    onShare?: (path: string, isDir?: boolean) => void;
    onRename?: (path: string) => void;
    onDelete?: (path: string) => void;
    sharedPaths?: Set<string>;
    unreadByPath?: Readonly<Record<string, number>>;
    collaboratorLocations?: SidebarPresenceLocation[];
    /** Supplied by the native or hosted shell so this shared tree never owns
     *  an icon asset registry. */
    iconResolver?: FileIconResolver;
  }

  let {
    nodes,
    activePath = '',
    depth = 0,
    rootPath = '',
    onNavigate,
    onExpand,
    onShare,
    onRename,
    onDelete,
    sharedPaths = new Set<string>(),
    unreadByPath = {},
    collaboratorLocations = [],
    iconResolver,
  }: Props = $props();

  let expanded: Record<string, boolean> = $state({});
  let iconRevision = $state(0);

  $effect(() => {
    if (!iconResolver) return;
    return iconResolver.subscribe(() => {
      iconRevision += 1;
    });
  });

  function isExpanded(path: string): boolean {
    if (expanded[path] !== undefined) return expanded[path];
    return depth === 0;
  }

  function setExpanded(path: string, value: boolean): void {
    expanded[path] = value;
  }

  function handleDirOpenChange(path: string, value: boolean): void {
    setExpanded(path, value);
    if (value) {
      onExpand?.(path);
    }
  }

  $effect(() => {
    for (const node of nodes) {
      if (!node.isDir) continue;
      if (!isExpanded(node.path)) continue;
      onExpand?.(node.path);
    }
  });

  // Keep the tree aligned with external navigation (e.g. Cmd/Ctrl+P).
  // When activePath changes, expand all ancestor directories so the active file is visible.
  // Only runs when activePath actually changes — not when expanded state changes — so
  // users can manually collapse a folder even if it contains the active file.
  let lastExpandedForPath = $state('');

  $effect(() => {
    const normalizedActive = normalizePath(activePath);
    if (!normalizedActive || normalizedActive === lastExpandedForPath) return;
    lastExpandedForPath = normalizedActive;

    for (const node of nodes) {
      if (!node.isDir) continue;
      const normalizedNode = normalizePath(node.path);
      const isAncestor = normalizedActive === normalizedNode
        || normalizedActive.startsWith(`${normalizedNode}/`);
      if (!isAncestor || isExpanded(node.path)) continue;
      setExpanded(node.path, true);
      onExpand?.(node.path);
    }
  });

  function handleFileClick(e: MouseEvent, node: TreeNode): void {
    if (node.isDir) return;
    const newTab = e.metaKey || e.ctrlKey;
    if (onNavigate) {
      onNavigate(node.path, newTab);
    }
  }

  function handleFileAuxClick(e: MouseEvent, node: TreeNode): void {
    if (node.isDir || e.button !== 1) return;
    e.preventDefault();
    onNavigate?.(node.path, true);
  }

  function handleFileKeydown(e: KeyboardEvent, node: TreeNode): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!node.isDir && onNavigate) {
        onNavigate(node.path, e.metaKey || e.ctrlKey);
      }
    }
  }

  function getFileIcon(node: TreeNode): string | null {
    void iconRevision;
    return iconResolver?.resolveFileIcon(node.name) ?? null;
  }

  function getFolderIcon(name: string, path: string): string | null {
    void iconRevision;
    return iconResolver?.resolveFolderIcon(name, isExpanded(path)) ?? null;
  }

  function normalizePath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    if (normalized === '/') return '/';
    return normalized.replace(/\/+$/, '');
  }

  function toRelativePath(path: string, basePath: string): string {
    const normalizedPath = normalizePath(path);
    const normalizedBase = normalizePath(basePath);
    if (!normalizedBase) return normalizedPath;
    if (normalizedBase === '/') {
      if (normalizedPath === '/') return '.';
      return normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
    }
    if (normalizedPath === normalizedBase) return '.';
    const prefix = `${normalizedBase}/`;
    if (normalizedPath.startsWith(prefix)) {
      return normalizedPath.slice(prefix.length);
    }
    return normalizedPath;
  }

  async function copyText(value: string): Promise<void> {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // Fall back to document.execCommand below.
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function handleContextOpen(path: string, newTab: boolean): void {
    onNavigate?.(path, newTab);
  }

  function handleCopyRelativePath(path: string): void {
    void copyText(toRelativePath(path, rootPath));
  }

  function handleCopyAbsolutePath(path: string): void {
    void copyText(path);
  }

  function handleOpenExternal(path: string): void {
    openExternal(path);
  }

  function handleShare(path: string, isDir = false): void {
    onShare?.(path, isDir);
  }

  function presenceBadgeFor(node: TreeNode, expandedForNode: boolean) {
    return sidebarPresenceBadgeForNode(node, collaboratorLocations, expandedForNode);
  }

  // A file is shared when its own path is in a room; a folder is shared when it
  // contains any shared file (folder shares surface as one snapshot per file).
  function isPathShared(node: TreeNode): boolean {
    if (sharedPaths.size === 0) return false;
    const target = normalizePath(node.path);
    if (!node.isDir) {
      return sharedPaths.has(node.path) || sharedPaths.has(target);
    }
    const prefix = `${target}/`;
    for (const shared of sharedPaths) {
      const s = normalizePath(shared);
      if (s === target || s.startsWith(prefix)) return true;
    }
    return false;
  }

  function unreadForPath(path: string): number {
    return unreadByPath[path] ?? unreadByPath[normalizePath(path)] ?? 0;
  }
</script>

{#each nodes as node (node.path)}
  {#if node.isDir}
    {@const exp = isExpanded(node.path)}
    {@const presenceBadge = presenceBadgeFor(node, exp)}
    {@const folderShared = isPathShared(node)}
    {@const folderUnread = unreadForPath(node.path)}
    {@const folderIcon = getFolderIcon(node.name, node.path)}
    <SidebarMenuItem>
      <Collapsible
        open={exp}
        onOpenChange={(v) => handleDirOpenChange(node.path, v)}
        class="group/collapsible"
      >
        <ContextMenu>
          <ContextMenuTrigger>
            {#snippet child({ props: ctxProps })}
              <CollapsibleTrigger>
                {#snippet child({ props: triggerProps })}
                  <SidebarMenuButton
                    {...ctxProps}
                    {...triggerProps}
                    size="sm"
                    class="sidebar-tree-row sidebar-tree-row--dir"
                    data-path={node.path}
                    style={`--tree-depth: ${depth};`}
                  >
                    <ChevronRight class="sidebar-tree-chevron size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90" />
                    {#if folderIcon}
                      <img src={folderIcon} alt="" aria-hidden="true" class="sidebar-tree-icon-image size-3.5 shrink-0" />
                    {:else}
                      <span aria-hidden="true" class="sidebar-tree-markdown-marker">·</span>
                    {/if}
                    <span class="sidebar-tree-name truncate">{node.name}</span>
                    {#if presenceBadge}
                      <span
                        class:sidebar-collab-badge--inherited={presenceBadge.inherited}
                        class="sidebar-collab-badge"
                        title={`${presenceBadge.count} collaborator${presenceBadge.count === 1 ? '' : 's'} viewing ${presenceBadge.inherited ? 'inside this folder' : 'this folder'}`}
                        aria-label={`${presenceBadge.count} collaborator${presenceBadge.count === 1 ? '' : 's'} viewing ${presenceBadge.inherited ? 'inside this folder' : 'this folder'}`}
                      >
                        {#if presenceBadge.count > 1}{presenceBadge.count}{/if}
                      </span>
                    {/if}
                    {#if folderShared}
                      <span class="sidebar-shared-badge" title="Shared for review" aria-label="Shared for review">
                        <Share2 class="size-3" aria-hidden="true" />
                      </span>
                    {/if}
                    <UnreadBadge
                      count={folderUnread}
                      label={`unread review updates for ${node.name}`}
                    />
                  </SidebarMenuButton>
                {/snippet}
              </CollapsibleTrigger>
            {/snippet}
          </ContextMenuTrigger>
          <ContextMenuContent class="w-56">
            <ContextMenuItem
              disabled={!onShare}
              onSelect={() => handleShare(node.path, true)}
            >
              <Share2 class="size-4" aria-hidden="true" />
              Share folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => handleCopyRelativePath(node.path)}>
              Copy relative path
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handleCopyAbsolutePath(node.path)}>
              Copy absolute path
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => handleOpenExternal(node.path)}>
              Open in external (open)
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent>
          {#if node.children}
            <SidebarMenu class="sidebar-tree-sub" style={`--tree-depth: ${depth};`}>
              <FileTree nodes={node.children} {activePath} depth={depth + 1} {rootPath} {onNavigate} {onExpand} {onShare} {onRename} {onDelete} {sharedPaths} {unreadByPath} {collaboratorLocations} {iconResolver} />
            </SidebarMenu>
          {/if}
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  {:else}
    {@const icon = getFileIcon(node)}
    {@const presenceBadge = presenceBadgeFor(node, false)}
    {@const fileShared = isPathShared(node)}
    {@const fileUnread = unreadForPath(node.path)}
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger>
          {#snippet child({ props: triggerProps })}
            <SidebarMenuButton
              {...triggerProps}
              size="sm"
              isActive={node.path === activePath}
              class={`sidebar-tree-row sidebar-tree-row--file${icon ? '' : ' sidebar-tree-row--file-no-icon'}`}
              data-path={node.path}
              onclick={(e: MouseEvent) => handleFileClick(e, node)}
              onauxclick={(e: MouseEvent) => handleFileAuxClick(e, node)}
              onkeydown={(e: KeyboardEvent) => handleFileKeydown(e, node)}
              style={`--tree-depth: ${depth};`}
            >
              {#if icon}
                <img
                  src={icon}
                  alt=""
                  aria-hidden="true"
                  class={`sidebar-tree-icon-image size-3.5 shrink-0${node.name.toLowerCase() === 'agents.md' ? ' sidebar-tree-icon-image--invert-paper' : ''}`}
                />
              {:else}
                <span aria-hidden="true" class="sidebar-tree-markdown-marker">·</span>
              {/if}
              <span class="sidebar-tree-name truncate">{node.name}</span>
              {#if presenceBadge}
                <span
                  class:sidebar-collab-badge--inherited={presenceBadge.inherited}
                  class="sidebar-collab-badge"
                  title={`${presenceBadge.count} collaborator${presenceBadge.count === 1 ? '' : 's'} viewing this file`}
                  aria-label={`${presenceBadge.count} collaborator${presenceBadge.count === 1 ? '' : 's'} viewing this file`}
                >
                  {#if presenceBadge.count > 1}{presenceBadge.count}{/if}
                </span>
              {/if}
              {#if fileShared}
                <span class="sidebar-shared-badge" title="Shared for review" aria-label="Shared for review">
                  <Share2 class="size-3" aria-hidden="true" />
                </span>
              {/if}
              <UnreadBadge
                count={fileUnread}
                label={`unread review updates for ${node.name}`}
              />
            </SidebarMenuButton>
          {/snippet}
        </ContextMenuTrigger>
        <ContextMenuContent class="w-56">
          <ContextMenuItem onSelect={() => handleContextOpen(node.path, false)}>
            Open
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleContextOpen(node.path, true)}>
            Open in new tab
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleCopyRelativePath(node.path)}>
            Copy relative path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleCopyAbsolutePath(node.path)}>
            Copy absolute path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleOpenExternal(node.path)}>
            Open in external (open)
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={(node.fileType !== 'markdown' && node.fileType !== 'html') || !onShare}
            onSelect={() => handleShare(node.path)}
          >
            <Share2 class="size-4" aria-hidden="true" />
            Share
          </ContextMenuItem>
          {#if onRename || onDelete}
            <ContextMenuSeparator />
            {#if onRename}
              <!-- Ellipsis = opens a follow-up input (macOS menu convention);
                   the hosted a11y/authoring gates assert these exact labels. -->
              <ContextMenuItem onSelect={() => onRename?.(node.path)}>
                Rename…
              </ContextMenuItem>
            {/if}
            {#if onDelete}
              <ContextMenuItem class="text-destructive" onSelect={() => onDelete?.(node.path)}>
                Delete…
              </ContextMenuItem>
            {/if}
          {/if}
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  {/if}
{/each}
