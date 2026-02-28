<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import { dragWindow } from './ipc';
  import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarRail,
  } from '$lib/components/ui/sidebar';
  import { ScrollArea } from '$lib/components/ui/scroll-area';

  interface Props {
    entries: TreeNode[];
    activePath?: string;
    rootPath?: string;
    onNavigate?: (path: string, newTab: boolean) => void;
  }

  let { entries, activePath = '', rootPath = '', onNavigate }: Props = $props();

  function formatRootLabel(path: string): string {
    if (!path) return 'Workspace';
    const parts = path.split('/').filter(Boolean);
    return parts.at(-1) || path;
  }

  function formatRootPath(path: string): string {
    if (!path) return '';
    return path.replace(/^\/Users\/[^/]+/, '~');
  }

  let rootLabel = $derived(formatRootLabel(rootPath));
  let rootPathDisplay = $derived(formatRootPath(rootPath));
</script>

<Sidebar class="project-sidebar">
  <!-- Drag strip: clears traffic lights -->
  <div class="h-[46px] shrink-0" style="-webkit-user-select: none" onmousedown={dragWindow}></div>

  <div class="sidebar-header" style="-webkit-user-select: none">
    <p class="sidebar-root-name" title={rootPath || rootLabel}>{rootLabel}</p>
    {#if rootPathDisplay}
      <p class="sidebar-root-path" title={rootPath}>{rootPathDisplay}</p>
    {/if}
  </div>

  <SidebarContent class="pt-0.5">
    <ScrollArea class="min-h-0 flex-1" scrollbarYClasses="pr-1">
      <SidebarGroup class="pb-1">
        <SidebarGroupContent>
          <SidebarMenu class="sidebar-tree-menu">
            <FileTree nodes={entries} {activePath} {onNavigate} />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </ScrollArea>
  </SidebarContent>
  <SidebarRail />
</Sidebar>
