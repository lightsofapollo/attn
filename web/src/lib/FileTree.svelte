<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import { openExternal } from './ipc';
  import {
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
  import { resolveFileIcon, resolveFolderIcon } from '$lib/icon-resolver';
  import { getIconPack, subscribeIconPack } from '$lib/icon-pack';

  interface Props {
    nodes: TreeNode[];
    activePath?: string;
    depth?: number;
    rootPath?: string;
    onNavigate?: (path: string, newTab: boolean) => void;
    onExpand?: (path: string) => void;
  }

  let { nodes, activePath = '', depth = 0, rootPath = '', onNavigate, onExpand }: Props = $props();

  let expanded: Record<string, boolean> = $state({});
  let iconPack = $state(getIconPack());

  $effect(() => {
    const unsubscribe = subscribeIconPack((next) => {
      iconPack = next;
    });
    return unsubscribe;
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
  $effect(() => {
    const normalizedActive = normalizePath(activePath);
    if (!normalizedActive) return;

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
    iconPack;
    return resolveFileIcon(node.name);
  }

  function getFolderIcon(name: string, path: string): string {
    iconPack;
    return resolveFolderIcon(name, isExpanded(path));
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
</script>

{#each nodes as node (node.path)}
  {#if node.isDir}
    {@const exp = isExpanded(node.path)}
    <Collapsible
      open={exp}
      onOpenChange={(v) => handleDirOpenChange(node.path, v)}
      class="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger>
          {#snippet child({ props: triggerProps })}
            <SidebarMenuButton
              {...triggerProps}
              size="sm"
              class="sidebar-tree-row sidebar-tree-row--dir"
              data-path={node.path}
              style={`--tree-depth: ${depth};`}
            >
              <ChevronRight class="sidebar-tree-chevron size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90" />
              <img src={getFolderIcon(node.name, node.path)} alt="" aria-hidden="true" class="sidebar-tree-icon-image size-3.5 shrink-0" />
              <span class="sidebar-tree-name truncate">{node.name}</span>
            </SidebarMenuButton>
          {/snippet}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {#if node.children}
            <div class="sidebar-tree-sub" style={`--tree-depth: ${depth};`}>
              <FileTree nodes={node.children} {activePath} depth={depth + 1} {rootPath} {onNavigate} {onExpand} />
            </div>
          {/if}
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  {:else}
    {@const icon = getFileIcon(node)}
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
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  {/if}
{/each}
