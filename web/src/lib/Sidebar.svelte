<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { SearchResultItem, TreeNode } from './types';
  import BrandMark from './BrandMark.svelte';
  import FileTree from './FileTree.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import ReviewFileTree from './ReviewFileTree.svelte';
  import { dragWindow, zoomWindow } from './ipc';
  import Search from '@lucide/svelte/icons/search';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import X from '@lucide/svelte/icons/x';
  import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarMenu,
    SidebarRail,
  } from '$lib/components/ui/sidebar';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { reviewStore } from './review/store.svelte';
  import type { SidebarPresenceLocation } from './sidebar-presence';
  import UnreadBadge from './UnreadBadge.svelte';
  import type { FileIconResolver } from './file-icon-resolver';

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
    onRename?: (path: string) => void;
    onDelete?: (path: string) => void;
    sharedPaths?: Set<string>;
    unreadByPath?: Readonly<Record<string, number>>;
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
    /** Display labels keyed by project path, for roots whose path is not a
     *  human-readable filesystem path (hosted workspace virtual roots). */
    projectLabels?: Record<string, string>;
    /** Workspace-level actions appended to the project picker menu (hosted:
     *  New workspace / Rename workspace / All workspaces). Their presence
     *  makes the picker interactive even with a single project. */
    projectMenuActions?: { id: string; label: string; run: () => void }[];
    /** Project roots with an active review share — the picker marks them so
     *  what's shared is legible next to local-only workspaces (attn-vt4). */
    sharedProjects?: Set<string>;
    /** Browser-owned workspaces do not expose an outline until one is derived. */
    showOutline?: boolean;
    /**
     * Render the attn mark + wordmark above the project label (attn-64iy.5).
     *
     * Opt-in, and only one surface opts in: `App.svelte` in a BROWSER tab,
     * where there are no traffic lights and the sidebar's top-left corner is
     * therefore free. The desktop window keeps its brand in the header — that
     * corner belongs to the OS — and the hosted surfaces carry their own brand
     * in their own headers. Defaults false so none of them change.
     */
    showBrand?: boolean;
    /** The owning shell supplies its registry; Sidebar and FileTree remain
     *  reusable without importing a platform-specific icon bundle. */
    iconResolver?: FileIconResolver;
    /** False where the owning shell renders the project picker itself. */
    showProjectPicker?: boolean;
    /**
     * The tree row being renamed, and the field that replaces its label.
     *
     * Pure pass-through to FileTree: the owning shell holds the value and owns
     * the commit, because it is the shell that knows what a valid path is and
     * what happens after one changes. See the longer note in FileTree.
     */
    renamingPath?: string;
    renameField?: Snippet;
    /**
     * Hosted only: leaves the open workspace for the desk that lists them all.
     *
     * The rail is the one piece of chrome a person is already looking at while
     * navigating files, so it is where the way OUT of this workspace belongs.
     * The native app has no desk and passes nothing, so no row renders there.
     */
    onOpenDesk?: () => void;
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
    onRename,
    onDelete,
    sharedPaths = new Set<string>(),
    unreadByPath = {},
    onSearchQuery,
    outline = [],
    activeOutlineId = '',
    onOutlineNavigate,
    footer,
    showWindowDragRegion = true,
    rootLabel,
    projectLabels = {},
    projectMenuActions = [],
    sharedProjects = new Set<string>(),
    showOutline = true,
    showBrand = false,
    iconResolver,
    showProjectPicker = true,
    renamingPath,
    renameField,
    onOpenDesk,
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
  // `/` must never reach across a focus boundary: pressed on a dialog, menu,
  // or lightbox control it would focus the filter BEHIND the modal.
  function insideOverlay(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    return el.closest(
      'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]',
    ) !== null;
  }
  $effect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || insideOverlay(event.target)) return;
      // A collapsed/hidden sidebar has no visible filter to hand focus to.
      const input = filterInputEl;
      if (!input || input.offsetParent === null) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  function formatRootLabel(path: string): string {
    // rootLabel wins for the active project: it tracks live renames, while
    // projectLabels is a snapshot of the whole desk.
    if (rootLabel && (path === rootPath || path === selectedProject)) return rootLabel;
    const mapped = projectLabels[path];
    if (mapped) return mapped;
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
      ondblclick={zoomWindow}
    ></div>
  {/if}

  <div class="sidebar-controls" data-sidebar-controls="true">
    {#if onOpenDesk}
      <!-- First row in the rail, above everything about this workspace: the
           way back out of it. Until now the only exit was buried in the
           header picker's action list, three rows down a menu you had to know
           to open — so the rail could show you every file in one workspace and
           no way to reach the next one. A back chevron and the destination's
           own name; nothing else in this column points up a level, so it does
           not need to compete. -->
      <button
        type="button"
        class="sidebar-back"
        data-slot="sidebar-back"
        onclick={onOpenDesk}
      >
        <ChevronLeft class="sidebar-back-glyph size-3.5" aria-hidden="true" />
        <span>Back to desk</span>
      </button>
    {/if}
    {#if showBrand}
      <!-- Product identity, in the corner the browser leaves free
           (attn-64iy.5). It sits inside `.sidebar-controls`, which is outside
           the file tree's ScrollArea, so "fixed in position" is structural
           rather than a `position: fixed` that would have to be unwound at
           every breakpoint. Above the project label, not merged into its row:
           the mark says which product this is and the label says which folder
           is open, and one of those changes while the other never does. -->
      <div class="sidebar-brand" data-slot="sidebar-brand" aria-label="attn">
        <BrandMark size={18} />
        <span class="sidebar-brand-word">attn</span>
      </div>
    {/if}
    <!-- Project identity: a quiet small-caps label (editorial furniture), not a
         button. It becomes an interactive switcher only when there is more
         than one project to switch to.

         Hidden on the hosted surfaces, which carry this control in their own
         header instead (user ruling, 2026-08-20). -->
    {#if showProjectPicker}
    <div class="sidebar-project-row" style="-webkit-user-select: none">
      <ProjectPicker
        projects={projectOptions}
        selected={selectedProject}
        labelFor={formatRootLabel}
        {sharedProjects}
        actions={projectMenuActions}
        onSwitch={onProjectSwitch}
      />
    </div>
    {/if}

    <!-- View control (native): text tabs, rust underline marks the current one
         — the same "rust = current" vocabulary as the file tick. -->
    {#if showOutline}
      <div class="sidebar-view-tabs" aria-label="Sidebar views">
        <button
          type="button"
          class="sidebar-view-tab"
          class:is-current={sidebarView === 'files'}
          aria-pressed={sidebarView === 'files'}
          onclick={() => { sidebarView = 'files'; }}
        >Files</button>
        <button
          type="button"
          class="sidebar-view-tab"
          class:is-current={sidebarView === 'outline'}
          aria-pressed={sidebarView === 'outline'}
          onclick={() => { sidebarView = 'outline'; }}
        >Outline</button>
      </div>
    {/if}

    <!-- Filter: a standing box (attn-64iy.7 — borderless until focus leaves an
         input reading as a label), a search glyph, an honest `/` hint, and a
         clear affordance once typing. Focus promotes the box to the accent
         ring.

         `size="1"` is load-bearing, not tidiness: an <input> carries an
         INTRINSIC width from its `size` attribute (default 20 characters,
         ~130px) which acts as a layout floor that `min-width: 0` on the input
         cannot remove — that declaration governs flex shrinking inside the
         filter, not the filter's own min-content contribution to the sidebar
         grid. With the default, the filter bottomed out at 194px and hung over
         the document once the sidebar was resized near its 180px minimum
         (reported on the desktop app, where a narrow window is ordinary). See
         the matching `min-width: 0` on the controls grid in app.css; both
         halves are required. -->
    <div class="sidebar-filter" data-has-query={query.length > 0}>
      <Search class="sidebar-filter-icon size-3.5" />
      <input
        bind:this={filterInputEl}
        bind:value={query}
        class="sidebar-filter-input"
        type="text"
        size="1"
        autocomplete="off"
        spellcheck="false"
        placeholder={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
        aria-label={sidebarView === 'outline' ? 'Filter headings' : 'Filter files'}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            if (query.length > 0) { query = ''; } else { filterInputEl?.blur(); }
          }
        }}
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
              <!-- No px-3 here: the rail's inline gutter is `--sidebar-gutter`
                   in app.css (attn-mkmz.4), and a utility would outrank it. -->
              <div class="flex items-center gap-1.5 pb-1 pt-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground" data-slot="sidebar-shared-label">
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
                  <FileTree nodes={filteredEntries} {activePath} {rootPath} {onNavigate} {onExpand} {onShare} {onRename} {onDelete} {sharedPaths} {unreadByPath} {collaboratorLocations} {iconResolver} {renamingPath} {renameField} />
                {/key}
              </SidebarMenu>
              {#if showBackendMatches && remoteSearchItems.length > 0}
                <div class="sidebar-outline-wrap pt-2">
                  <p class="sidebar-outline-empty-copy pb-1">Elsewhere in the project</p>
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
                </div>
              {/if}
            {:else if normalizedQuery.length > 0}
              <!-- One state, not two stacked boxes: while the project-wide
                   search is still in flight the same card says so; once it
                   resolves it either lists the matches or closes the loop. -->
              {#if showBackendMatches && remoteSearchItems.length > 0}
                <div class="sidebar-outline-wrap">
                  <p class="sidebar-outline-empty-copy pb-1">No matches in open folders — elsewhere in the project:</p>
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
                </div>
              {:else if showBackendMatches}
                <div class="sidebar-outline-empty">
                  <p class="sidebar-outline-empty-title">No files match “{query.trim()}”</p>
                  <p class="sidebar-outline-empty-copy">Checked the whole project. Try a different term.</p>
                </div>
              {:else if onSearchQuery}
                <div class="sidebar-outline-empty">
                  <p class="sidebar-outline-empty-title">Nothing in open folders</p>
                  <p class="sidebar-outline-empty-copy">Searching the rest of the project…</p>
                </div>
              {:else}
                <!-- No project-wide search on this surface (hosted workspaces
                     are fully listed) — never promise one. -->
                <div class="sidebar-outline-empty">
                  <p class="sidebar-outline-empty-title">No files match “{query.trim()}”</p>
                  <p class="sidebar-outline-empty-copy">Try a different term.</p>
                </div>
              {/if}
            {:else}
              <div class="sidebar-outline-empty">
                <p class="sidebar-outline-empty-title">No files yet</p>
                <p class="sidebar-outline-empty-copy">Add or drop files to get started.</p>
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
