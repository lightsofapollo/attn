<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import {
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuSub,
    SidebarMenuSubItem,
    SidebarMenuSubButton,
  } from '$lib/components/ui/sidebar';
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from '$lib/components/ui/collapsible';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

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
</script>

{#if depth === 0}
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
              >
                <ChevronRight class="sidebar-tree-chevron size-3 transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90" />
                <span class="truncate">{node.name}</span>
              </SidebarMenuButton>
            {/snippet}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {#if node.children}
              <SidebarMenuSub class="sidebar-tree-sub">
                <FileTree nodes={node.children} {activePath} depth={depth + 1} {onNavigate} />
              </SidebarMenuSub>
            {/if}
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    {:else}
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          isActive={node.path === activePath}
          class="sidebar-tree-row sidebar-tree-row--file"
          onclick={(e: MouseEvent) => handleFileClick(e, node)}
          onauxclick={(e: MouseEvent) => handleFileClick(e, node)}
          onkeydown={(e: KeyboardEvent) => handleFileKeydown(e, node)}
        >
          <span class="truncate">{node.name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    {/if}
  {/each}
{:else}
  {#each nodes as node (node.path)}
    {#if node.isDir}
      {@const exp = isExpanded(node.path)}
      <Collapsible
        open={exp}
        onOpenChange={(v) => setExpanded(node.path, v)}
        class="group/collapsible"
      >
        <SidebarMenuSubItem>
          <CollapsibleTrigger>
            {#snippet child({ props: triggerProps })}
              <SidebarMenuSubButton
                {...triggerProps}
                class="sidebar-tree-row sidebar-tree-row--dir sidebar-tree-row--nested cursor-pointer"
              >
                <ChevronRight class="sidebar-tree-chevron size-3 shrink-0 transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90" />
                <span class="truncate">{node.name}</span>
              </SidebarMenuSubButton>
            {/snippet}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {#if node.children}
              <SidebarMenuSub class="sidebar-tree-sub">
                <FileTree nodes={node.children} {activePath} depth={depth + 1} {onNavigate} />
              </SidebarMenuSub>
            {/if}
          </CollapsibleContent>
        </SidebarMenuSubItem>
      </Collapsible>
    {:else}
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          isActive={node.path === activePath}
          class="sidebar-tree-row sidebar-tree-row--file sidebar-tree-row--nested cursor-pointer"
          onclick={(e: MouseEvent) => handleFileClick(e, node)}
          onauxclick={(e: MouseEvent) => handleFileClick(e, node)}
          onkeydown={(e: KeyboardEvent) => handleFileKeydown(e, node)}
        >
          <span class="truncate">{node.name}</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    {/if}
  {/each}
{/if}
