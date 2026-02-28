<script lang="ts">
  import type {
    AppMode,
    ContentPayload,
    DiagMode,
    FileType,
    TreeNode,
    InitPayload,
    PlanStructure,
    UpdatePayload,
  } from './lib/types';
  import { initKeyboard } from './lib/keyboard';
  import { dragWindow, editSave, navigate } from './lib/ipc';
  import { initTheme } from './lib/theme';
  import { createTab, findTabByPath, type Tab } from './lib/tabs';
  import Editor from './lib/Editor.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import TabBar from './lib/TabBar.svelte';
  import ImageViewer from './lib/ImageViewer.svelte';
  import MediaPlayer from './lib/MediaPlayer.svelte';
  import { toast } from 'svelte-sonner';
  import { SidebarProvider, SidebarInset } from '$lib/components/ui/sidebar';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import PathBreadcrumb from './lib/PathBreadcrumb.svelte';
  import {
    detectFileType,
    extractStructureFromMarkdown,
    loadMarkdownFromPath,
    markdownSourceUrl,
  } from './lib/markdown-layer';
  import './app.css';
  import '../styles/base.css';
  import '../styles/prosemirror.css';
  import '../styles/syntax.css';

  let mode: AppMode = $state('edit');
  let commandPaletteOpen = $state(false);
  let shortcutsOpen = $state(false);
  let rawMarkdown = $state('');
  let structure: PlanStructure = $state({ phases: [], tasks: [], file_refs: [] });
  let fileTree: TreeNode[] = $state([]);
  let rootPath = $state('');
  let diagMode: DiagMode = $state('full');
  let editorRef: ReturnType<typeof Editor> | undefined = $state(undefined);

  // Tab state
  let tabs: Tab[] = $state([]);
  let activeTabId = $state('');

  // Track if a navigation was initiated from the frontend (sidebar click)
  let pendingFrontendNav = false;
  // Deferred navigation for auto-select when opening a directory
  let pendingAutoNav: string | null = null;
  let contentViewport: HTMLElement | null = $state(null);

  let activeTab = $derived(tabs.find((t) => t.id === activeTabId));
  let activePath = $derived(activeTab?.path ?? '');
  let hasActiveTab = $derived(Boolean(activeTab));
  let activeFileType = $derived<FileType>(activeTab?.fileType ?? 'unsupported');
  let hasSidebar = $derived(fileTree.length > 0);
  let showTabBar = $derived(tabs.length > 1);
  let markdownFetchSeq = 0;
  const loadedMtimeByPath = new Map<string, number>();
  type OutlineHeading = { id: string; text: string; level: number; line: number };
  let outlineHeadings: OutlineHeading[] = $state([]);
  let activeOutlineId = $state('');

  function emptyPlanStructure(): PlanStructure {
    return { phases: [], tasks: [], file_refs: [] };
  }

  function slugifyHeading(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function extractOutlineHeadings(markdown: string): OutlineHeading[] {
    if (!markdown) return [];
    const lines = markdown.split(/\r?\n/);
    const slugCounts = new Map<string, number>();
    const result: OutlineHeading[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      const level = match[1].length;
      const text = match[2].trim();
      if (!text) continue;
      const base = slugifyHeading(text) || `section-${i + 1}`;
      const count = (slugCounts.get(base) ?? 0) + 1;
      slugCounts.set(base, count);
      const id = count > 1 ? `${base}-${count}` : base;
      result.push({ id, text, level, line: i + 1 });
    }

    return result;
  }

  function normalizedHeadingKey(text: string, level: number): string {
    return `${level}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  function buildOutlineDomIndex(headings: OutlineHeading[], domHeadings: HTMLElement[]): string[] {
    const outlineBuckets = new Map<string, string[]>();
    for (const heading of headings) {
      const key = normalizedHeadingKey(heading.text, heading.level);
      const bucket = outlineBuckets.get(key) ?? [];
      bucket.push(heading.id);
      outlineBuckets.set(key, bucket);
    }

    const consumed = new Map<string, number>();
    return domHeadings.map((el) => {
      const level = Number(el.tagName.slice(1));
      const key = normalizedHeadingKey(el.textContent ?? '', level);
      const bucket = outlineBuckets.get(key);
      if (!bucket || bucket.length === 0) return '';
      const used = consumed.get(key) ?? 0;
      consumed.set(key, used + 1);
      return bucket[used] ?? '';
    });
  }

  function syncActiveOutlineFromViewport(): void {
    if (!contentViewport || outlineHeadings.length === 0) {
      activeOutlineId = '';
      return;
    }
    const domHeadings = Array.from(
      contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    if (domHeadings.length === 0) {
      activeOutlineId = outlineHeadings[0]?.id ?? '';
      return;
    }

    const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
    const viewportTop = contentViewport.getBoundingClientRect().top + 72;
    let current = idsByDomOrder[0] || outlineHeadings[0]?.id || '';

    for (let i = 0; i < domHeadings.length; i += 1) {
      const id = idsByDomOrder[i];
      if (!id) continue;
      if (domHeadings[i].getBoundingClientRect().top <= viewportTop) {
        current = id;
      } else {
        break;
      }
    }

    activeOutlineId = current;
  }

  function handleOutlineNavigate(id: string): void {
    activeOutlineId = id;
    if (!contentViewport) return;
    requestAnimationFrame(() => {
      if (!contentViewport) return;
      const domHeadings = Array.from(
        contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
      );
      if (domHeadings.length === 0) return;
      const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
      const idx = idsByDomOrder.findIndex((entry) => entry === id);
      if (idx === -1) return;
      domHeadings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function openPath(path: string, fileType?: FileType, newTab = false): void {
    const ft = fileType ?? detectFileType(path);

    if (!newTab) {
      // Reuse existing tab for this path, or navigate the active tab
      const existing = findTabByPath(tabs, path);
      if (existing) {
        switchTab(existing.id);
        return;
      }
    }

    if (newTab || tabs.length === 0) {
      // Add a new tab
      const tab = createTab(path, ft);
      tabs = [...tabs, tab];
      activeTabId = tab.id;
    } else {
      // Navigate current tab
      saveScrollPosition();
      const tab = activeTab;
      if (tab) {
        tab.path = path;
        tab.fileType = ft;
        tab.label = path.split('/').pop() ?? path;
        tab.scrollY = 0;
        tabs = [...tabs]; // trigger reactivity
      }
    }

    // For markdown files, tell Rust backend to load content
    if (ft === 'markdown') {
      pendingFrontendNav = true;
      navigate(path);
    }
  }

  function switchTab(id: string): void {
    if (id === activeTabId) return;
    saveScrollPosition();
    activeTabId = id;
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      if (tab.fileType === 'markdown') {
        navigate(tab.path);
      }
      // Restore scroll after content renders
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = tab.scrollY;
      });
    }
  }

  function closeTab(id: string): void {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    tabs = tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) {
      activeTabId = '';
      return;
    }
    if (id === activeTabId) {
      // Activate adjacent tab
      const newIdx = Math.min(idx, tabs.length - 1);
      switchTab(tabs[newIdx].id);
    }
  }

  function saveScrollPosition(): void {
    const tab = activeTab;
    if (tab && contentViewport) tab.scrollY = contentViewport.scrollTop;
  }

  // Gallery navigation: collect supported files from tree
  function collectSupportedFiles(nodes: TreeNode[]): string[] {
    const result: string[] = [];
    for (const node of nodes) {
      if (node.isDir && node.children) {
        result.push(...collectSupportedFiles(node.children));
      } else if (node.fileType !== 'unsupported' && node.fileType !== 'directory') {
        result.push(node.path);
      }
    }
    return result;
  }

  function navigateGallery(direction: -1 | 1): void {
    const files = collectSupportedFiles(fileTree);
    if (files.length === 0) return;
    const currentIdx = files.indexOf(activePath);
    if (currentIdx === -1) return;
    const newIdx = (currentIdx + direction + files.length) % files.length;
    openPath(files[newIdx]);
  }

  async function loadMarkdownForPath(path: string, contentMtimeMs?: number): Promise<void> {
    if (!path || detectFileType(path) !== 'markdown') return;
    if (typeof contentMtimeMs === 'number') {
      const lastMtime = loadedMtimeByPath.get(path);
      if (lastMtime === contentMtimeMs) return;
    }

    const requestId = ++markdownFetchSeq;
    try {
      const markdown = await loadMarkdownFromPath(path);
      if (requestId !== markdownFetchSeq) return;
      const currentPath = tabs.find((t) => t.id === activeTabId)?.path;
      if (currentPath && currentPath !== path) return;

      rawMarkdown = markdown;
      structure = extractStructureFromMarkdown(markdown);
      if (typeof contentMtimeMs === 'number') {
        loadedMtimeByPath.set(path, contentMtimeMs);
      }
    } catch (error) {
      console.error('[attn] failed to load markdown via attn protocol', { path, error });
    }
  }

  /** Find the first supported file in the tree (depth-first) */
  function findFirstFile(nodes: TreeNode[]): TreeNode | undefined {
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const found = findFirstFile(node.children);
        if (found) return found;
      } else if (node.fileType !== 'unsupported' && node.fileType !== 'directory') {
        return node;
      }
    }
    return undefined;
  }

  function loadInitPayload(): void {
    const init = (window as { __attn_init__?: InitPayload }).__attn_init__;
    if (!init) {
      // Show Svelte app even without init data
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.display = '';
      return;
    }
    // Clear so we only process once (prevents $effect re-entry)
    delete (window as { __attn_init__?: InitPayload }).__attn_init__;

    rawMarkdown = init.markdown ?? '';
    structure = init.structure ?? emptyPlanStructure();
    diagMode = init.diagMode ?? 'full';
    if (init.fileTree) {
      fileTree = init.fileTree;
    }
    if (init.rootPath) {
      rootPath = init.rootPath;
    }
    if (init.filePath) {
      const ft = detectFileType(init.filePath);
      const openedDirectory = ft === 'unsupported' && init.rootPath === init.filePath;
      if (!openedDirectory) {
        // Opening a specific file (including unsupported types)
        const tab = createTab(init.filePath, ft);
        tabs = [tab];
        activeTabId = tab.id;
        if (ft === 'markdown' && !init.markdown) {
          void loadMarkdownForPath(init.filePath, init.contentMtimeMs);
        }
      } else if (init.fileTree && init.fileTree.length > 0) {
        // Opening a directory — auto-select first supported file
        const first = findFirstFile(init.fileTree);
        if (first) {
          const tab = createTab(first.path, first.fileType);
          tabs = [tab];
          activeTabId = tab.id;
          pendingAutoNav = first.fileType === 'markdown' ? first.path : null;
        }
      }
    }
    document.documentElement.dataset.theme = init.theme;
    initTheme();

    // Show Svelte app
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.display = '';
  }

  function registerIpcHandlers(): void {
    function applySetContent(data: ContentPayload): void {
      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        if (data.structure) {
          structure = data.structure;
        } else {
          structure = extractStructureFromMarkdown(data.markdown);
        }
      } else if (data.structure) {
        structure = data.structure;
      }

      if (data.filePath && data.filePath !== activePath) {
        const ft = detectFileType(data.filePath);
        const wasFrontendNav = pendingFrontendNav;
        pendingFrontendNav = false;

        if (tabs.length === 0) {
          // First tab
          const tab = createTab(data.filePath, ft);
          tabs = [tab];
          activeTabId = tab.id;
        } else if (wasFrontendNav) {
          // Sidebar click: update the active tab
          const tab = activeTab;
          if (tab) {
            tab.path = data.filePath;
            tab.fileType = ft;
            tab.label = data.filePath.split('/').pop() ?? data.filePath;
            tab.scrollY = 0;
            tabs = [...tabs];
          }
        } else {
          // Daemon socket: add a new tab (or focus existing)
          const existing = findTabByPath(tabs, data.filePath);
          if (existing) {
            activeTabId = existing.id;
          } else {
            const tab = createTab(data.filePath, ft);
            tabs = [...tabs, tab];
            activeTabId = tab.id;
          }
        }
      }
      if (data.fileTree) {
        fileTree = data.fileTree;
      }
      if (detectFileType(data.filePath) === 'markdown' && typeof data.markdown !== 'string') {
        rawMarkdown = '';
        void loadMarkdownForPath(data.filePath, data.contentMtimeMs);
      }
    }

    function applyUpdateContent(data: UpdatePayload): void {
      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        if (data.structure) {
          structure = data.structure;
        } else {
          structure = extractStructureFromMarkdown(data.markdown);
        }
        return;
      }

      if (data.structure) {
        structure = data.structure;
      }
      const targetPath = data.filePath ?? activePath;
      if (targetPath && targetPath === activePath && detectFileType(targetPath) === 'markdown') {
        void loadMarkdownForPath(targetPath, data.contentMtimeMs);
      }
    }

    window.__attn__ = {
      setContent(data: ContentPayload) {
        applySetContent(data);
      },
      updateContent(data: UpdatePayload) {
        applyUpdateContent(data);
      },
    };

    type QueuedMessage =
      | { kind: 'set'; data: ContentPayload }
      | { kind: 'update'; data: UpdatePayload };
    const w = window as Window & { __attn_queue__?: QueuedMessage[] };
    const queued = w.__attn_queue__ ?? [];
    for (const item of queued) {
      if (item.kind === 'set') {
        applySetContent(item.data);
      } else if (item.kind === 'update') {
        applyUpdateContent(item.data);
      }
    }
    w.__attn_queue__ = [];
  }

  function toggleEdit(): void {
    if (activeFileType !== 'markdown') return;
    if (mode === 'read') {
      mode = 'edit';
    } else {
      saveAndExitEdit();
    }
  }

  function saveAndExitEdit(): void {
    if (editorRef) {
      const md = editorRef.getMarkdown();
      structure = extractStructureFromMarkdown(md);
      editSave(md);
      toast.success('File saved');
    }
    mode = 'read';
  }

  function cancelEdit(): void {
    mode = 'read';
    toast.info('Edit cancelled');
  }

  // Handle sidebar navigation events
  function handleSidebarNavigate(path: string, newTab: boolean): void {
    openPath(path, undefined, newTab);
  }

  $effect(() => {
    if (activeFileType !== 'markdown') {
      outlineHeadings = [];
      activeOutlineId = '';
      return;
    }

    const headings = extractOutlineHeadings(rawMarkdown);
    outlineHeadings = headings;
    activeOutlineId = headings[0]?.id ?? '';
    requestAnimationFrame(() => {
      syncActiveOutlineFromViewport();
    });
  });

  $effect(() => {
    if (!contentViewport) return;
    const viewport = contentViewport;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncActiveOutlineFromViewport();
      });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(() => {
      syncActiveOutlineFromViewport();
    });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  });

  $effect(() => {
    loadInitPayload();
    registerIpcHandlers();
    // Handle deferred auto-navigation (directory opened, first file selected)
    if (pendingAutoNav) {
      navigate(pendingAutoNav);
      pendingAutoNav = null;
    }
    if (diagMode === 'minimal') {
      return;
    }
    const cleanup = initKeyboard({
      getMode: () => (activeFileType === 'markdown' ? mode : 'read'),
      onEditToggle: toggleEdit,
      onEditCancel: cancelEdit,
      onEditSave: saveAndExitEdit,
      onTabClose: () => { if (activeTabId) closeTab(activeTabId); },
      onTabPrev: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) switchTab(tabs[idx - 1].id);
      },
      onTabNext: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
      },
      onGalleryPrev: () => navigateGallery(-1),
      onGalleryNext: () => navigateGallery(1),
      onFind: () => {
        if (activeFileType === 'markdown') {
          editorRef?.openFind();
        }
      },
      onCommandPalette: () => { commandPaletteOpen = !commandPaletteOpen; },
      onShortcutsHelp: () => { shortcutsOpen = true; },
    });
    return () => {
      cleanup();
    };
  });
</script>

{#snippet mainContent()}
  {#if showTabBar}
    <TabBar {tabs} {activeTabId} onSwitch={switchTab} onClose={closeTab} />
  {/if}
  <PathBreadcrumb
    path={activePath}
    {rootPath}
    avoidWindowControls={!hasSidebar}
    fixed={!hasSidebar}
    topOffsetPx={34}
    onNavigate={(dir) => openPath(dir)}
  />
  {#if !hasSidebar}
    <div class="h-[40px] shrink-0"></div>
  {/if}

  <ScrollArea
    class="attn-content-viewport min-h-0 flex-1"
    orientation="vertical"
    bind:viewportRef={contentViewport}
  >

    {#if !hasActiveTab}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <p class="text-sm font-medium text-foreground">No file selected</p>
        {#if hasSidebar}
          <p class="text-sm opacity-75">Choose a file from the sidebar to begin.</p>
        {:else}
          <p class="text-sm opacity-75">Launch with a file or directory path, or open this app from a project folder.</p>
        {/if}
      </div>
    {:else if activeFileType === 'markdown'}
      <Editor
        bind:this={editorRef}
        markdown={rawMarkdown}
        editable={mode === 'edit'}
        onSave={saveAndExitEdit}
        onCancel={cancelEdit}
      />
    {:else if activeFileType === 'image'}
      <ImageViewer src={markdownSourceUrl(activePath)} />
    {:else if activeFileType === 'video' || activeFileType === 'audio'}
      <MediaPlayer src={markdownSourceUrl(activePath)} fileType={activeFileType} />
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p>This file type is not supported for preview.</p>
        <p class="text-sm opacity-60">{activePath}</p>
      </div>
    {/if}
  </ScrollArea>
{/snippet}

{#snippet minimalDiagnosticContent()}
  <div class="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-foreground">
    <p class="mb-2 font-semibold">Diagnostic mode: minimal</p>
    <p class="mb-3 text-muted-foreground">Path: {activePath || '(none)'}</p>
    <pre class="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3">{rawMarkdown}</pre>
  </div>
{/snippet}

{#snippet editorOnlyContent()}
  <div class="min-h-0 flex-1 overflow-auto">
    {#if !hasActiveTab}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <p class="text-sm font-medium text-foreground">No file selected</p>
        <p class="text-sm opacity-75">Launch with a markdown file path for editor-only diagnostics.</p>
      </div>
    {:else if activeFileType === 'markdown'}
      <Editor
        bind:this={editorRef}
        markdown={rawMarkdown}
        editable={mode === 'edit'}
        onSave={saveAndExitEdit}
        onCancel={cancelEdit}
      />
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p>Editor-only mode supports markdown files.</p>
        <p class="text-sm opacity-60">{activePath}</p>
      </div>
    {/if}
  </div>
{/snippet}

{#if diagMode === 'minimal'}
  <main class="flex h-screen flex-col overflow-hidden">
    <div class="h-[46px] shrink-0" style="-webkit-user-select: none" onmousedown={dragWindow}></div>
    {@render minimalDiagnosticContent()}
  </main>
{:else if diagMode === 'editor_only'}
  <main class="flex h-screen flex-col overflow-hidden">
    <div class="h-[46px] shrink-0" style="-webkit-user-select: none" onmousedown={dragWindow}></div>
    {@render editorOnlyContent()}
  </main>
{:else if hasSidebar}
  <SidebarProvider class="h-svh overflow-hidden">
    <Sidebar
      entries={fileTree}
      {activePath}
      {rootPath}
      outline={outlineHeadings}
      {activeOutlineId}
      onNavigate={handleSidebarNavigate}
      onOutlineNavigate={handleOutlineNavigate}
    />
    <SidebarInset class="flex flex-col overflow-hidden">
      {@render mainContent()}
    </SidebarInset>
  </SidebarProvider>
{:else}
  <main class="flex h-screen flex-col overflow-hidden">
    <div class="h-[34px] shrink-0" style="-webkit-user-select: none" onmousedown={dragWindow}></div>
    {@render mainContent()}
  </main>
{/if}
