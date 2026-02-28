<script lang="ts">
  import type { TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import { dragWindow } from './ipc';
  import FolderTree from '@lucide/svelte/icons/folder-tree';
  import TextQuote from '@lucide/svelte/icons/text-quote';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import {
    Sidebar,
    SidebarContent,
    SidebarMenu,
    SidebarRail,
  } from '$lib/components/ui/sidebar';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
  } from '$lib/components/ui/dropdown-menu';
  import * as Command from '$lib/components/ui/command';

  interface Props {
    entries: TreeNode[];
    activePath?: string;
    rootPath?: string;
    knownProjects?: string[];
    activeProjectPath?: string;
    onProjectSwitch?: (path: string) => void;
    onNavigate?: (path: string, newTab: boolean) => void;
    outline?: { id: string; text: string; level: number; line: number }[];
    activeOutlineId?: string;
    onOutlineNavigate?: (id: string) => void;
  }

  let {
    entries,
    activePath = '',
    rootPath = '',
    knownProjects = [],
    activeProjectPath = '',
    onProjectSwitch,
    onNavigate,
    outline = [],
    activeOutlineId = '',
    onOutlineNavigate,
  }: Props = $props();
  let sidebarView: 'files' | 'outline' = $state('files');
  let query = $state('');

  function formatRootLabel(path: string): string {
    if (!path) return 'Workspace';
    const parts = path.split('/').filter(Boolean);
    return parts.at(-1) || path;
  }

  let projectOptions = $derived(
    knownProjects.length > 0 ? knownProjects : rootPath ? [rootPath] : [],
  );
  let selectedProject = $derived(
    activeProjectPath || rootPath || projectOptions[0] || '',
  );
  let markdownFileCount = $derived(entries.length ? countMarkdownFiles(entries) : 0);
  let totalFileCount = $derived(entries.length ? countFiles(entries) : 0);
  let outlineCount = $derived(outline.length);
  let filteredEntries = $derived(filterTree(entries, query));
  let filteredOutline = $derived(filterOutline(outline, query));
  let projectPickerOpen = $state(false);

  function countFiles(nodes: TreeNode[]): number {
    let count = 0;
    for (const node of nodes) {
      if (node.isDir && node.children) {
        count += countFiles(node.children);
      } else if (!node.isDir) {
        count += 1;
      }
    }
    return count;
  }

  function countMarkdownFiles(nodes: TreeNode[]): number {
    let count = 0;
    for (const node of nodes) {
      if (node.isDir && node.children) {
        count += countMarkdownFiles(node.children);
      } else if (node.fileType === 'markdown') {
        count += 1;
      }
    }
    return count;
  }

  function filterTree(nodes: TreeNode[], term: string): TreeNode[] {
    const q = term.trim().toLowerCase();
    if (!q) return nodes;
    const out: TreeNode[] = [];
    for (const node of nodes) {
      const selfMatch = node.name.toLowerCase().includes(q);
      if (node.isDir) {
        const kids = filterTree(node.children ?? [], q);
        if (selfMatch || kids.length > 0) {
          out.push({ ...node, children: kids });
        }
      } else if (selfMatch) {
        out.push(node);
      }
    }
    return out;
  }

  function filterOutline(
    headings: { id: string; text: string; level: number; line: number }[],
    term: string,
  ): { id: string; text: string; level: number; line: number }[] {
    const q = term.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter((heading) => heading.text.toLowerCase().includes(q));
  }
</script>

<Sidebar class="project-sidebar">
  <!-- Drag strip: clears traffic lights -->
  <div class="h-[46px] shrink-0" style="-webkit-user-select: none" onmousedown={dragWindow}></div>

  <div class="sidebar-header" style="-webkit-user-select: none">
    <div class="sidebar-project-picker">
      <DropdownMenu bind:open={projectPickerOpen}>
        <DropdownMenuTrigger
          class="sidebar-project-select"
          aria-label="Project picker"
          role="combobox"
          aria-expanded={projectPickerOpen}
        >
          <span class="sidebar-project-select-label" title={selectedProject}>
            {formatRootLabel(selectedProject)}
          </span>
          <ChevronsUpDown class="sidebar-project-switch-icon size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="sidebar-project-menu p-0">
          <Command.Root class="sidebar-project-command">
            <Command.Input placeholder="Search projects..." />
            <Command.List class="max-h-[240px]">
              <Command.Empty class="px-3 py-5 text-xs text-muted-foreground">
                No projects found.
              </Command.Empty>
              <Command.Group>
                {#each projectOptions as projectPath (projectPath)}
                  <Command.Item
                    value={`${formatRootLabel(projectPath)} ${projectPath}`}
                    class="sidebar-project-menu-item"
                    onSelect={() => {
                      projectPickerOpen = false;
                      if (projectPath !== selectedProject) {
                        onProjectSwitch?.(projectPath);
                      }
                    }}
                  >
                    {formatRootLabel(projectPath)}
                  </Command.Item>
                {/each}
              </Command.Group>
            </Command.List>
          </Command.Root>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div class="sidebar-mode-toggle" aria-label="Sidebar views">
      <button
        type="button"
        class="sidebar-mode-button"
        class:sidebar-mode-button--active={sidebarView === 'files'}
        aria-label="Files"
        title="Files"
        onclick={() => { sidebarView = 'files'; }}
      >
        <FolderTree class="size-3.5" />
      </button>
      <button
        type="button"
        class="sidebar-mode-button"
        class:sidebar-mode-button--active={sidebarView === 'outline'}
        aria-label="Outline"
        title="Outline"
        onclick={() => { sidebarView = 'outline'; }}
      >
        <TextQuote class="size-3.5" />
      </button>
    </div>
  </div>

  <SidebarContent class="p-0">
    <div class="sidebar-shell">
      <section class="sidebar-pane">
        <div class="sidebar-search-wrap">
          <input
            type="text"
            class="sidebar-search"
            bind:value={query}
            placeholder={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
          />
        </div>

        <ScrollArea class="min-h-0 flex-1" scrollbarYClasses="pr-1">
          {#if sidebarView === 'files'}
            {#if filteredEntries.length > 0}
              <SidebarMenu class="sidebar-tree-menu">
                <FileTree nodes={filteredEntries} {activePath} {onNavigate} />
              </SidebarMenu>
            {:else}
              <div class="sidebar-outline-empty">
                <p class="sidebar-outline-empty-title">No files found</p>
                <p class="sidebar-outline-empty-copy">Try a different filter term.</p>
              </div>
            {/if}
          {:else if filteredOutline.length > 0}
            <nav class="sidebar-outline-list" aria-label="Markdown sections">
              {#each filteredOutline as heading (heading.id)}
                <button
                  type="button"
                  class="sidebar-outline-item"
                  class:sidebar-outline-item--active={heading.id === activeOutlineId}
                  style={`--outline-level:${heading.level};`}
                  onclick={() => onOutlineNavigate?.(heading.id)}
                >
                  <span class="sidebar-outline-title">{heading.text}</span>
                  <span class="sidebar-outline-line">L{heading.line}</span>
                </button>
              {/each}
            </nav>
          {:else}
            <div class="sidebar-outline-empty">
              <p class="sidebar-outline-empty-title">No sections found</p>
              <p class="sidebar-outline-empty-copy">Open a markdown file with headings or clear the filter.</p>
            </div>
          {/if}
        </ScrollArea>
      </section>
    </div>
  </SidebarContent>
  <SidebarRail />
</Sidebar>
