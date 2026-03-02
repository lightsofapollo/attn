<script lang="ts">
  import type { SearchResultItem, TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import { dragWindow } from './ipc';
  import FolderTree from '@lucide/svelte/icons/folder-tree';
  import TextQuote from '@lucide/svelte/icons/text-quote';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import {
    Sidebar,
    SidebarContent,
    SidebarInput,
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
    remoteSearchQuery?: string;
    remoteSearchItems?: SearchResultItem[];
    onProjectSwitch?: (path: string) => void;
    onNavigate?: (path: string, newTab: boolean) => void;
    onExpand?: (path: string) => void;
    onSearchQuery?: (query: string) => void;
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
    remoteSearchQuery = '',
    remoteSearchItems = [],
    onProjectSwitch,
    onNavigate,
    onExpand,
    onSearchQuery,
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
  let treeRenderKey = $state('');
  let normalizedQuery = $derived(query.trim().toLowerCase());
  let backendQueryAligned = $derived(remoteSearchQuery.trim().toLowerCase() === normalizedQuery);
  let showBackendMatches = $derived(
    sidebarView === 'files' && normalizedQuery.length > 0 && backendQueryAligned,
  );

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

  $effect(() => {
    const nextKey = selectedProject || rootPath || '';
    if (!nextKey) return;
    if (treeRenderKey && treeRenderKey !== nextKey) {
      query = '';
      sidebarView = 'files';
    }
    treeRenderKey = nextKey;
  });

  $effect(() => {
    if (!onSearchQuery) return;
    if (sidebarView !== 'files') {
      onSearchQuery('');
      return;
    }
    const handle = setTimeout(() => {
      onSearchQuery(query.trim());
    }, 150);
    return () => clearTimeout(handle);
  });

  function basename(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts.at(-1) ?? path;
  }
</script>

<Sidebar class="project-sidebar">
  <!-- Drag strip: clears traffic lights -->
  <div
    class="h-[46px] shrink-0"
    style="-webkit-user-select: none"
    role="button"
    aria-label="Drag window"
    tabindex="-1"
    onmousedown={dragWindow}
  ></div>

  <div
    class="sidebar-controls"
    data-sidebar-controls="true"
    style="
      display: grid;
      gap: 12px;
      margin: 2px 12px 14px;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
      background: color-mix(in oklch, var(--background) 80%, white 20%);
      box-shadow:
        inset 0 1px 0 color-mix(in oklch, white 48%, transparent),
        0 1px 2px color-mix(in oklch, black 4%, transparent);
    "
  >
    <div class="sidebar-header flex items-center justify-between gap-3" style="-webkit-user-select: none">
      <div class="sidebar-project-picker min-w-0 flex-1">
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
    <div class="sidebar-search-wrap p-0">
      <SidebarInput
        class="sidebar-search !h-8 !px-3 !py-1.5 !text-[0.82rem] !leading-tight"
        bind:value={query}
        placeholder={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
        aria-label={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
      />
    </div>
  </div>

  <SidebarContent class="p-0">
    <div class="sidebar-shell">
      <section class="sidebar-pane">
        <ScrollArea class="min-h-0 flex-1" scrollbarYClasses="pr-1">
          {#if sidebarView === 'files'}
            {#if filteredEntries.length > 0}
              <SidebarMenu class="sidebar-tree-menu">
                {#key treeRenderKey}
                  <FileTree nodes={filteredEntries} {activePath} {rootPath} {onNavigate} {onExpand} />
                {/key}
              </SidebarMenu>
            {:else}
              <div class="sidebar-outline-empty">
                <p class="sidebar-outline-empty-title">No files found</p>
                <p class="sidebar-outline-empty-copy">Try a different filter term.</p>
              </div>
            {/if}
            {#if showBackendMatches}
              <div class="sidebar-outline-wrap pt-2">
                {#if remoteSearchItems.length > 0}
                  <p class="sidebar-outline-empty-copy pb-1">Project-wide matches</p>
                  <nav class="sidebar-outline-list" aria-label="Project search results">
                    {#each remoteSearchItems as item (item.path)}
                      <button
                        type="button"
                        class="sidebar-outline-item"
                        class:sidebar-outline-item--active={item.path === activePath}
                        onclick={() => onNavigate?.(item.path, false)}
                      >
                        <span class="sidebar-outline-title">{basename(item.path)}</span>
                        <span class="sidebar-outline-line">{item.path}</span>
                      </button>
                    {/each}
                  </nav>
                {:else}
                  <div class="sidebar-outline-empty">
                    <p class="sidebar-outline-empty-title">No project-wide matches</p>
                    <p class="sidebar-outline-empty-copy">No results in unopened folders for “{query.trim()}”.</p>
                  </div>
                {/if}
              </div>
            {:else if sidebarView === 'files' && normalizedQuery.length > 0}
              <div class="sidebar-outline-empty">
                <p class="sidebar-outline-empty-copy">Searching full project...</p>
              </div>
            {/if}
          {:else if filteredOutline.length > 0}
            <div class="sidebar-outline-wrap">
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
            </div>
          {:else}
            <div class="sidebar-outline-wrap">
              <div class="sidebar-outline-empty">
                <p class="sidebar-outline-empty-title">No sections found</p>
                <p class="sidebar-outline-empty-copy">Open a markdown file with headings or clear the filter.</p>
              </div>
            </div>
          {/if}
        </ScrollArea>
      </section>
    </div>
  </SidebarContent>
  <SidebarRail />
</Sidebar>
