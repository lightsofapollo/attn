<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import {
    SidebarMenuItem,
    SidebarMenuButton,
  } from '$lib/components/ui/sidebar';
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from '$lib/components/ui/collapsible';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileText from '@lucide/svelte/icons/file-text';
  import File from '@lucide/svelte/icons/file';
  import Image from '@lucide/svelte/icons/image';
  import Film from '@lucide/svelte/icons/film';
  import Music from '@lucide/svelte/icons/music';

  interface Props {
    nodes: TreeNode[];
    activePath?: string;
    depth?: number;
    onNavigate?: (path: string, newTab: boolean) => void;
  }

  let { nodes, activePath = '', depth = 0, onNavigate }: Props = $props();

  let expanded: Record<string, boolean> = $state({});

  function isExpanded(path: string): boolean {
    if (expanded[path] !== undefined) return expanded[path];
    return depth === 0;
  }

  function setExpanded(path: string, value: boolean): void {
    expanded[path] = value;
  }

  function handleFileClick(e: MouseEvent, node: TreeNode): void {
    if (node.isDir) return;
    const newTab = e.metaKey || e.ctrlKey || e.button === 1;
    if (onNavigate) {
      onNavigate(node.path, newTab);
    }
  }

  function handleFileKeydown(e: KeyboardEvent, node: TreeNode): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!node.isDir && onNavigate) {
        onNavigate(node.path, e.metaKey || e.ctrlKey);
      }
    }
  }

  function getFileIcon(node: TreeNode) {
    if (node.fileType === 'markdown') return FileText;
    if (node.fileType === 'image') return Image;
    if (node.fileType === 'video') return Film;
    if (node.fileType === 'audio') return Music;
    return File;
  }
</script>

{#each nodes as node (node.path)}
  {#if node.isDir}
    {@const exp = isExpanded(node.path)}
    <Collapsible
      open={exp}
      onOpenChange={(v) => setExpanded(node.path, v)}
      class="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger>
          {#snippet child({ props: triggerProps })}
            <SidebarMenuButton
              {...triggerProps}
              size="sm"
              class="sidebar-tree-row sidebar-tree-row--dir"
              style={`--tree-depth: ${depth};`}
            >
              <ChevronRight class="sidebar-tree-chevron size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90" />
              <span class="sidebar-tree-name truncate">{node.name}</span>
            </SidebarMenuButton>
          {/snippet}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {#if node.children}
            <div class="sidebar-tree-sub" style={`--tree-depth: ${depth};`}>
              <FileTree nodes={node.children} {activePath} depth={depth + 1} {onNavigate} />
            </div>
          {/if}
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  {:else}
    {@const Icon = getFileIcon(node)}
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={node.path === activePath}
        class="sidebar-tree-row sidebar-tree-row--file"
        onclick={(e: MouseEvent) => handleFileClick(e, node)}
        onauxclick={(e: MouseEvent) => handleFileClick(e, node)}
        onkeydown={(e: KeyboardEvent) => handleFileKeydown(e, node)}
        style={`--tree-depth: ${depth};`}
      >
        <Icon class="size-3.5 shrink-0 sidebar-tree-icon" />
        <span class="sidebar-tree-name truncate">{node.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  {/if}
{/each}
