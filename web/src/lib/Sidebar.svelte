<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { SearchResultItem, TreeNode } from './types';
  import FileTree from './FileTree.svelte';
  import ReviewFileTree from './ReviewFileTree.svelte';
  import { dragWindow } from './ipc';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import Check from '@lucide/svelte/icons/check';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
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
  import { reviewStore } from './review/store.svelte';
  import type { SidebarPresenceLocation } from './sidebar-presence';
  import UnreadBadge from './UnreadBadge.svelte';

  interface Props {
    entries: TreeNode[];
    /** When true, the files pane shows the shared room's tree (reviewer). */
    reviewMode?: boolean;
    activePath?: string;
    rootPath?: string;
    knownProjects?: string[];
    activeProjectPath?: string;
    remoteSearchQuery?: string;
    remoteSearchItems?: SearchResultItem[];
    onProjectSwitch?: (path: string) => void;
    onNavigate?: (path: string, newTab: boolean) => void;
    onExpand?: (path: string) => void;
    onShare?: (path: string, isDir?: boolean) => void;
    sharedPaths?: Set<string>;
    onSearchQuery?: (query: string) => void;
    outline?: { id: string; text: string; level: number; line: number }[];
    activeOutlineId?: string;
    onOutlineNavigate?: (id: string) => void;
    /** Optional platform-specific actions below the shared file/outline view. */
    footer?: Snippet;
    /** Native reserves space for macOS window controls; hosted desktop does not. */
    showWindowDragRegion?: boolean;
    /** Display label for virtual/browser workspace roots. */
    rootLabel?: string;
    /** Browser-owned workspaces do not expose an outline until one is derived. */
    showOutline?: boolean;
  }

  let {
    entries,
    reviewMode = false,
    activePath = '',
    rootPath = '',
    knownProjects = [],
    activeProjectPath = '',
    remoteSearchQuery = '',
    remoteSearchItems = [],
    onProjectSwitch,
    onNavigate,
    onExpand,
    onShare,
    sharedPaths = new Set<string>(),
    onSearchQuery,
    outline = [],
    activeOutlineId = '',
    onOutlineNavigate,
    footer,
    showWindowDragRegion = true,
    rootLabel,
    showOutline = true,
  }: Props = $props();
  let sidebarView: 'files' | 'outline' = $state('files');
  let query = $state('');
  let sidebarRootEl: HTMLElement | null = $state(null);
  let filterInputEl = $state<HTMLInputElement | null>(null);

  // Keyboard-first discoverability: `/` focuses the file filter, unless the
  // user is already typing in a field or the editor. Honest hint shown in the
  // filter; `/` never collides with the editor's own ⌘F find-in-document.
  function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  $effect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      filterInputEl?.focus();
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  function formatRootLabel(path: string): string {
    if (rootLabel && (path === rootPath || path === selectedProject)) return rootLabel;
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
  // Scale the switcher to the number of projects: a single project is just a
  // heading (nothing to switch to); a short list needs no filter; a long list
  // gets a filter field.
  let hasMultipleProjects = $derived(projectOptions.length > 1);
  let showProjectFilter = $derived(projectOptions.length >= 8);
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
  let collaboratorLocations: SidebarPresenceLocation[] = $derived.by(() =>
    reviewStore.peersResolved
      .filter((peer) => peer.online && typeof peer.locationPath === 'string' && peer.locationPath.length > 0)
      .map((peer) => ({
        id: `${peer.participantId}:${peer.deviceId}`,
        path: peer.locationPath as string,
      })),
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

  function escapeCssSelectorValue(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function findSidebarItem(path: string): HTMLElement | null {
    if (!sidebarRootEl || !path) return null;
    const escaped = escapeCssSelectorValue(path);
    return sidebarRootEl.querySelector<HTMLElement>(
      `[data-sidebar="menu-button"][data-path="${escaped}"], [data-sidebar="menu-sub-button"][data-path="${escaped}"]`,
    );
  }

  $effect(() => {
    if (sidebarView !== 'files' || !activePath) return;

    let cancelled = false;
    let attempts = 0;

    async function scrollActiveItemIntoView(): Promise<void> {
      // Wait for reactive DOM updates and lazy child loads.
      await tick();
      if (cancelled) return;

      const target = findSidebarItem(activePath);
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        return;
      }

      attempts += 1;
      if (attempts < 12 && !cancelled) {
        setTimeout(scrollActiveItemIntoView, 60);
      }
    }

    void scrollActiveItemIntoView();
    return () => {
      cancelled = true;
    };
  });

</script>

<Sidebar class="project-sidebar" bind:ref={sidebarRootEl}>
  <!-- Drag strip: clears traffic lights -->
  {#if showWindowDragRegion}
    <div
      class="h-[46px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
  {/if}

  <div class="sidebar-controls" data-sidebar-controls="true">
    <!-- Project identity: a quiet small-caps label (editorial furniture), not a
         button. It becomes an interactive switcher only when there is more
         than one project to switch to. -->
    <div class="sidebar-project-row" style="-webkit-user-select: none">
      {#if hasMultipleProjects}
        <DropdownMenu bind:open={projectPickerOpen}>
          <DropdownMenuTrigger
            class="sidebar-project-trigger"
            aria-label="Switch project"
            role="combobox"
            aria-expanded={projectPickerOpen}
          >
            <span class="sidebar-project-name" title={selectedProject}>
              {formatRootLabel(selectedProject)}
            </span>
            <ChevronsUpDown class="sidebar-project-chevron size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="sidebar-project-menu p-0">
            <Command.Root class="sidebar-project-command">
              {#if showProjectFilter}
                <Command.Input placeholder="Filter projects" />
              {/if}
              <Command.List class="max-h-[300px]">
                <Command.Empty class="px-3 py-5 text-xs text-muted-foreground">
                  No projects found.
                </Command.Empty>
                <Command.Group>
                  {#each projectOptions as projectPath (projectPath)}
                    <Command.Item
                      value={`${formatRootLabel(projectPath)} ${projectPath}`}
                      class="sidebar-project-menu-item"
                      data-current={projectPath === selectedProject}
                      onSelect={() => {
                        projectPickerOpen = false;
                        if (projectPath !== selectedProject) {
                          onProjectSwitch?.(projectPath);
                        }
                      }}
                    >
                      <Check
                        class="sidebar-project-check size-3.5"
                        data-active={projectPath === selectedProject}
                      />
                      <span class="sidebar-project-menu-label">{formatRootLabel(projectPath)}</span>
                    </Command.Item>
                  {/each}
                </Command.Group>
              </Command.List>
            </Command.Root>
          </DropdownMenuContent>
        </DropdownMenu>
      {:else}
        <span class="sidebar-project-name sidebar-project-name--static" title={selectedProject}>
          {formatRootLabel(selectedProject)}
        </span>
      {/if}
    </div>

    <!-- View control (native): text tabs, rust underline marks the current one
         — the same "rust = current" vocabulary as the file tick. -->
    {#if showOutline}
      <div class="sidebar-view-tabs" role="tablist" aria-label="Sidebar views">
        <button
          type="button"
          class="sidebar-view-tab"
          class:is-current={sidebarView === 'files'}
          role="tab"
          aria-selected={sidebarView === 'files'}
          onclick={() => { sidebarView = 'files'; }}
        >Files</button>
        <button
          type="button"
          class="sidebar-view-tab"
          class:is-current={sidebarView === 'outline'}
          role="tab"
          aria-selected={sidebarView === 'outline'}
          onclick={() => { sidebarView = 'outline'; }}
        >Outline</button>
      </div>
    {/if}

    <!-- Filter: borderless furniture that only draws its box on focus; a search
         glyph, an honest `/` hint, and a clear affordance once typing. -->
    <div class="sidebar-filter" data-has-query={query.length > 0}>
      <Search class="sidebar-filter-icon size-3.5" />
      <input
        bind:this={filterInputEl}
        bind:value={query}
        class="sidebar-filter-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
        aria-label={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
      />
      {#if query.length > 0}
        <button
          type="button"
          class="sidebar-filter-clear"
          aria-label="Clear filter"
          onclick={() => { query = ''; filterInputEl?.focus(); }}
        >
          <X class="size-3" />
        </button>
      {:else}
        <kbd class="sidebar-filter-hint" aria-hidden="true">/</kbd>
      {/if}
    </div>
  </div>

  <SidebarContent class="p-0">
    <div class="sidebar-shell">
      <section class="sidebar-pane">
        <ScrollArea class="min-h-0 flex-1" scrollbarYClasses="pr-1">
          {#if sidebarView === 'files'}
            {#if reviewMode}
              <div class="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground" data-slot="sidebar-shared-label">
                <span>Shared files</span>
                <UnreadBadge
                  count={reviewStore.currentRoomUnread}
                  label="unread updates in shared files"
                />
              </div>
              <ReviewFileTree />
            {:else}
            {#if filteredEntries.length > 0}
              <SidebarMenu class="sidebar-tree-menu">
                {#key treeRenderKey}
                  <FileTree nodes={filteredEntries} {activePath} {rootPath} {onNavigate} {onExpand} {onShare} {sharedPaths} {collaboratorLocations} />
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
  {#if footer}
    <SidebarFooter class="border-t border-sidebar-border/70 p-2">
      {@render footer()}
    </SidebarFooter>
  {/if}
  <SidebarRail />
</Sidebar>
