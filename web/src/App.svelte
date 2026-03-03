<script lang="ts">
  import type {
    AppMode,
    ContentPayload,
    DiagMode,
    FileType,
    TreeOp,
    TreePatch,
    TreeNode,
    InitPayload,
    PlanStructure,
    SearchResultItem,
    UpdatePayload,
  } from './lib/types';
  import { initKeyboard } from './lib/keyboard';
  import {
    dragWindow,
    editSave,
    loadChildren,
    navigate,
    openExternal,
    searchFiles,
    switchProject,
  } from './lib/ipc';
  import {
    decreaseFontScale as decreaseGlobalFontScale,
    increaseFontScale as increaseGlobalFontScale,
    initFontScale,
    resetFontScale as resetGlobalFontScale,
  } from './lib/font-scale';
  import { initTheme } from './lib/theme';
  import { createTab, findTabByPath, type Tab } from './lib/tabs';
  import Editor from './lib/Editor.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import TabBar from './lib/TabBar.svelte';
  import ImageViewer from './lib/ImageViewer.svelte';
  import MediaPlayer from './lib/MediaPlayer.svelte';
  import DirectoryOverview from './lib/DirectoryOverview.svelte';
  import CommandPalette from './lib/CommandPalette.svelte';
  import KeyboardShortcutsDialog from './lib/KeyboardShortcutsDialog.svelte';
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

  let mode: AppMode = $state('edit');
  let commandPaletteOpen = $state(false);
  let shortcutsOpen = $state(false);
  let rawMarkdown = $state('');
  let structure: PlanStructure = $state({ phases: [], tasks: [], file_refs: [] });
  let fileTree: TreeNode[] = $state([]);
  let rootPath = $state('');
  let knownProjects: string[] = $state([]);
  let activeProjectPath = $state('');
  let diagMode: DiagMode = $state('full');
  let editorRef: ReturnType<typeof Editor> | undefined = $state(undefined);

  // Tab state
  let tabs: Tab[] = $state([]);
  let activeTabId = $state('');
  const scopedTabsByProject = new Map<string, { tabs: Tab[]; activeTabId: string }>();
  let activeTabScopeKey = $state('__default__');

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
  const loadedMtimeByPath = new Map<string, number>();
  const markdownCacheByPath = new Map<string, string>();
  const deferredReloadMtimeByPath = new Map<string, number | null>();
  const deferredReloadNoticeByPath = new Set<string>();
  const loadedDirPaths = new Set<string>();
  let editorDirty = $state(false);
  let pendingLinkAnchor: { path: string; fragment: string } | null = $state(null);
  type OutlineHeading = { id: string; text: string; level: number; line: number };
  let outlineHeadings: OutlineHeading[] = $state([]);
  let activeOutlineId = $state('');
  let sidebarSearchQuery = $state('');
  let sidebarSearchResults: SearchResultItem[] = $state([]);

  function emptyPlanStructure(): PlanStructure {
    return { phases: [], tasks: [], file_refs: [] };
  }

  function normalizeFsPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function patchTreeChildren(
    nodes: TreeNode[],
    parentPath: string,
    children: TreeNode[],
  ): { next: TreeNode[]; applied: boolean } {
    let applied = false;
    const parentKey = normalizeFsPath(parentPath);
    const next = nodes.map((node) => {
      const nodePath = normalizeFsPath(node.path);
      if (nodePath === parentKey) {
        applied = true;
        return { ...node, children };
      }
      if (!node.children?.length) {
        return node;
      }
      const patched = patchTreeChildren(node.children, parentPath, children);
      if (!patched.applied) return node;
      applied = true;
      return { ...node, children: patched.next };
    });
    return { next, applied };
  }

  function applyTreePatch(patch: TreePatch): void {
    const parentKey = normalizeFsPath(patch.parentPath);
    const rootKey = normalizeFsPath(rootPath);
    if (parentKey === rootKey) {
      fileTree = patch.children;
      return;
    }
    const patched = patchTreeChildren(fileTree, patch.parentPath, patch.children);
    if (patched.applied) {
      fileTree = patched.next;
    }
  }

  function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  function upsertNodeIntoChildren(children: TreeNode[], node: TreeNode): TreeNode[] {
    const idx = children.findIndex((entry) => normalizeFsPath(entry.path) === normalizeFsPath(node.path));
    if (idx >= 0) {
      const next = [...children];
      next[idx] = node;
      return sortTreeNodes(next);
    }
    return sortTreeNodes([...children, node]);
  }

  function applyTreeOps(ops: TreeOp[]): void {
    if (ops.length === 0) return;
    let next = fileTree;
    const rootKey = normalizeFsPath(rootPath);
    const removeSet = new Set<string>();
    const upsertsByParent = new Map<string, Map<string, TreeNode>>();

    for (const op of ops) {
      if (op.op === 'remove') {
        removeSet.add(normalizeFsPath(op.path));
        continue;
      }
      const parent = normalizeFsPath(op.parentPath);
      const path = normalizeFsPath(op.node.path);
      const bucket = upsertsByParent.get(parent) ?? new Map<string, TreeNode>();
      bucket.set(path, op.node);
      upsertsByParent.set(parent, bucket);
    }

    for (const removedPath of removeSet) {
      loadedDirPaths.delete(removedPath);
    }

    function visit(nodes: TreeNode[]): { nodes: TreeNode[]; changed: boolean } {
      let changed = false;
      const out: TreeNode[] = [];

      for (const node of nodes) {
        const nodePath = normalizeFsPath(node.path);
        if (removeSet.has(nodePath)) {
          changed = true;
          continue;
        }

        let nextNode = node;
        if (node.children) {
          const childResult = visit(node.children);
          if (childResult.changed) {
            changed = true;
            nextNode = { ...nextNode, children: childResult.nodes };
          }
        }

        const pending = upsertsByParent.get(nodePath);
        if (pending && pending.size > 0) {
          const currentChildren = nextNode.children ?? [];
          const merged = new Map<string, TreeNode>();
          for (const child of currentChildren) {
            merged.set(normalizeFsPath(child.path), child);
          }
          for (const [path, upsertNode] of pending.entries()) {
            merged.set(path, upsertNode);
          }
          const nextChildren = sortTreeNodes(Array.from(merged.values()));
          nextNode = { ...nextNode, children: nextChildren };
          changed = true;
          upsertsByParent.delete(nodePath);
        }

        out.push(nextNode);
      }

      return { nodes: changed ? out : nodes, changed };
    }

    const rootVisited = visit(next);
    next = rootVisited.nodes;
    let rootChanged = rootVisited.changed;

    const rootUpserts = upsertsByParent.get(rootKey);
    if (rootUpserts && rootUpserts.size > 0) {
      const merged = new Map<string, TreeNode>();
      for (const node of next) {
        merged.set(normalizeFsPath(node.path), node);
      }
      for (const [path, upsertNode] of rootUpserts.entries()) {
        merged.set(path, upsertNode);
      }
      next = sortTreeNodes(Array.from(merged.values()));
      rootChanged = true;
    } else if (removeSet.size > 0) {
      const filtered = next.filter((node) => !removeSet.has(normalizeFsPath(node.path)));
      if (filtered.length !== next.length) {
        next = filtered;
        rootChanged = true;
      }
    }

    if (rootChanged) {
      fileTree = next;
    }
  }

  function pruneTabsForRemovedPaths(paths: string[]): void {
    if (paths.length === 0 || tabs.length === 0) return;

    const removed = new Set(paths.map((path) => normalizeFsPath(path)));
    const prevTabs = tabs;
    const nextTabs = prevTabs.filter((tab) => !removed.has(normalizeFsPath(tab.path)));
    if (nextTabs.length === prevTabs.length) return;

    tabs = nextTabs;

    if (nextTabs.length === 0) {
      activeTabId = '';
      pendingFrontendNav = false;
      rawMarkdown = '';
      structure = emptyPlanStructure();
      return;
    }

    const activeStillExists = nextTabs.some((tab) => tab.id === activeTabId);
    if (activeStillExists) {
      return;
    }

    const nextActive = nextTabs[0];
    activeTabId = nextActive.id;

    if (nextActive.fileType === 'markdown') {
      pendingFrontendNav = false;
      navigate(nextActive.path);
    } else {
      rawMarkdown = '';
      structure = emptyPlanStructure();
    }
  }

  function getProjectScopeKey(
    projectPath: string | undefined = activeProjectPath,
    root: string | undefined = rootPath,
  ): string {
    const key = (projectPath ?? '').trim() || (root ?? '').trim();
    return key || '__default__';
  }

  function cloneTabsForScope(input: Tab[]): Tab[] {
    return input.map((tab) => ({ ...tab }));
  }

  function persistCurrentTabScope(): void {
    scopedTabsByProject.set(activeTabScopeKey, {
      tabs: cloneTabsForScope(tabs),
      activeTabId,
    });
  }

  function applyTabScopeForProject(
    projectPath: string | undefined = activeProjectPath,
    root: string | undefined = rootPath,
  ): void {
    const nextScopeKey = getProjectScopeKey(projectPath, root);
    if (nextScopeKey === activeTabScopeKey) return;

    persistCurrentTabScope();
    activeTabScopeKey = nextScopeKey;

    const scoped = scopedTabsByProject.get(nextScopeKey);
    if (scoped) {
      tabs = cloneTabsForScope(scoped.tabs);
      activeTabId = scoped.activeTabId;
      const restoredTab = tabs.find((tab) => tab.id === activeTabId);
      if (restoredTab?.fileType === 'markdown') {
        pendingFrontendNav = false;
        navigate(restoredTab.path);
      } else if (!restoredTab) {
        rawMarkdown = '';
        structure = emptyPlanStructure();
      }
      return;
    }

    tabs = [];
    activeTabId = '';
    rawMarkdown = '';
    structure = emptyPlanStructure();
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

  function isExternalLinkHref(href: string): boolean {
    if (!href) return false;
    if (href.startsWith('//')) return true;
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href);
  }

  function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  function dirname(path: string): string {
    const normalized = normalizePath(path);
    const idx = normalized.lastIndexOf('/');
    if (idx < 0) return '';
    return normalized.slice(0, idx);
  }

  function resolvePath(baseFilePath: string, hrefPath: string): string {
    const normalizedHref = normalizePath(hrefPath);
    if (normalizedHref.startsWith('/')) {
      // Treat `/foo.md` as project-root-relative (common in markdown docs),
      // not filesystem-root absolute.
      const normalizedRoot = normalizePath(rootPath);
      if (normalizedRoot) {
        const trimmedRoot = normalizedRoot.replace(/\/+$/, '');
        return `${trimmedRoot}${normalizedHref}`;
      }
      return normalizedHref;
    }
    if (/^[a-zA-Z]:\//.test(normalizedHref)) return normalizedHref;
    const baseDir = dirname(baseFilePath);
    const joined = baseDir ? `${baseDir}/${normalizedHref}` : normalizedHref;
    const parts = joined.split('/');
    const stack: string[] = [];
    const hasLeadingSlash = joined.startsWith('/');
    const driveMatch = parts[0]?.match(/^[a-zA-Z]:$/);
    const drivePrefix = driveMatch ? parts.shift()! : '';
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0 && stack[stack.length - 1] !== '..') {
          stack.pop();
        } else if (!hasLeadingSlash) {
          stack.push(part);
        }
      } else {
        stack.push(part);
      }
    }
    if (drivePrefix) {
      return `${drivePrefix}/${stack.join('/')}`;
    }
    return `${hasLeadingSlash ? '/' : ''}${stack.join('/')}`;
  }

  function splitLinkTarget(href: string): { path: string; fragment: string } {
    const hashIdx = href.indexOf('#');
    if (hashIdx < 0) return { path: href, fragment: '' };
    return {
      path: href.slice(0, hashIdx),
      fragment: href.slice(hashIdx + 1),
    };
  }

  function scrollToHeadingFragment(fragment: string): boolean {
    if (!contentViewport) return false;
    const normalized = decodeURIComponent(fragment).trim().toLowerCase();
    if (!normalized) {
      contentViewport.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    }
    const domHeadings = Array.from(
      contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    if (domHeadings.length === 0) return false;
    const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
    const idx = idsByDomOrder.findIndex((id) => id === normalized);
    if (idx < 0) return false;
    activeOutlineId = normalized;
    domHeadings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function handleEditorLinkNavigate(href: string): void {
    const trimmed = href.trim();
    if (!trimmed) return;

    if (isExternalLinkHref(trimmed)) {
      openExternal(trimmed);
      return;
    }

    const { path: rawPath, fragment } = splitLinkTarget(trimmed);
    if (!rawPath) {
      requestAnimationFrame(() => {
        scrollToHeadingFragment(fragment);
      });
      return;
    }

    const resolvedPath = resolvePath(activePath, decodeURIComponent(rawPath));
    if (!resolvedPath) return;

    if (fragment) {
      pendingLinkAnchor = { path: resolvedPath, fragment };
    }
    openPath(resolvedPath, detectFileType(resolvedPath));
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
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = 0;
      });
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
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = 0;
      });
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

  function handleEditorDirtyChange(dirty: boolean): void {
    editorDirty = dirty;
  }

  function deferExternalReload(path: string, contentMtimeMs?: number): void {
    if (!path) return;
    deferredReloadMtimeByPath.set(path, typeof contentMtimeMs === 'number' ? contentMtimeMs : null);
    if (deferredReloadNoticeByPath.has(path)) return;
    deferredReloadNoticeByPath.add(path);
    toast.info('File changed on disk. Reload will apply after save or cancel.');
  }

  async function flushDeferredReload(path: string): Promise<void> {
    if (!path || !deferredReloadMtimeByPath.has(path)) return;
    const pendingMtime = deferredReloadMtimeByPath.get(path);
    deferredReloadMtimeByPath.delete(path);
    deferredReloadNoticeByPath.delete(path);
    await loadMarkdownForPath(path, typeof pendingMtime === 'number' ? pendingMtime : undefined);
  }

  function invalidatePathCaches(paths: string[]): void {
    for (const path of paths) {
      if (!path) continue;
      markdownCacheByPath.delete(path);
      loadedMtimeByPath.delete(path);
    }
  }

  async function loadMarkdownForPath(path: string, contentMtimeMs?: number): Promise<void> {
    if (!path || detectFileType(path) !== 'markdown') return;
    const cachedMarkdown = markdownCacheByPath.get(path);
    if (typeof contentMtimeMs === 'number') {
      const lastMtime = loadedMtimeByPath.get(path);
      if (lastMtime === contentMtimeMs && typeof cachedMarkdown === 'string') {
        rawMarkdown = cachedMarkdown;
        structure = extractStructureFromMarkdown(cachedMarkdown);
        return;
      }
    }

    try {
      const markdown = await loadMarkdownFromPath(path);
      const currentPath = tabs.find((t) => t.id === activeTabId)?.path;
      if (currentPath && currentPath !== path) return;

      rawMarkdown = markdown;
      structure = extractStructureFromMarkdown(markdown);
      markdownCacheByPath.set(path, markdown);
      deferredReloadMtimeByPath.delete(path);
      deferredReloadNoticeByPath.delete(path);
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

  function findTreeNodeByPath(nodes: TreeNode[], path: string): TreeNode | undefined {
    const normalizedTarget = normalizeFsPath(path);
    for (const node of nodes) {
      if (normalizeFsPath(node.path) === normalizedTarget) {
        return node;
      }
      if (node.children && node.children.length > 0) {
        const found = findTreeNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return undefined;
  }

  function inferFileTypeFromTree(path: string): FileType | undefined {
    if (!path) return undefined;
    if (normalizeFsPath(path) === normalizeFsPath(rootPath)) {
      return 'directory';
    }
    return findTreeNodeByPath(fileTree, path)?.fileType;
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
    const initialMarkdown = typeof init.markdown === 'string' && init.markdown.length > 0
      ? init.markdown
      : null;
    if (init.filePath && detectFileType(init.filePath) === 'markdown' && initialMarkdown !== null) {
      markdownCacheByPath.set(init.filePath, initialMarkdown);
      if (typeof init.contentMtimeMs === 'number') {
        loadedMtimeByPath.set(init.filePath, init.contentMtimeMs);
      }
    }
    diagMode = init.diagMode ?? 'full';
    if (init.fileTree) {
      fileTree = init.fileTree;
      loadedDirPaths.clear();
    }
    if (init.rootPath) {
      rootPath = init.rootPath;
    }
    if (init.knownProjects) {
      knownProjects = init.knownProjects;
    }
    if (init.activeProjectPath) {
      activeProjectPath = init.activeProjectPath;
    } else if (init.rootPath) {
      activeProjectPath = init.rootPath;
    }
    activeTabScopeKey = getProjectScopeKey(activeProjectPath, rootPath);
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
      if (data.rootPath) {
        rootPath = data.rootPath;
      }
      if (data.knownProjects) {
        knownProjects = data.knownProjects;
      }
      if (data.activeProjectPath) {
        activeProjectPath = data.activeProjectPath;
      }
      if (data.searchResults) {
        sidebarSearchQuery = data.searchResults.query ?? '';
        sidebarSearchResults = data.searchResults.items ?? [];
      }
      applyTabScopeForProject(activeProjectPath, rootPath);

      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        if (detectFileType(data.filePath) === 'markdown') {
          markdownCacheByPath.set(data.filePath, data.markdown);
          deferredReloadMtimeByPath.delete(data.filePath);
          deferredReloadNoticeByPath.delete(data.filePath);
          if (typeof data.contentMtimeMs === 'number') {
            loadedMtimeByPath.set(data.filePath, data.contentMtimeMs);
          }
        }
        if (data.structure) {
          structure = data.structure;
        } else {
          structure = extractStructureFromMarkdown(data.markdown);
        }
      } else if (data.structure) {
        structure = data.structure;
      }

      const wasFrontendNav = pendingFrontendNav;
      if (data.filePath) {
        pendingFrontendNav = false;
      }

      if (data.filePath && data.filePath !== activePath) {
        const ft = detectFileType(data.filePath);

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
            requestAnimationFrame(() => {
              if (contentViewport) contentViewport.scrollTop = 0;
            });
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
        loadedDirPaths.clear();
      }
      if (data.treePatch) {
        applyTreePatch(data.treePatch);
        loadedDirPaths.add(normalizeFsPath(data.treePatch.parentPath));
      }
      if (data.treeOps) {
        applyTreeOps(data.treeOps);
        const removedPaths = data.treeOps
          .filter((op): op is Extract<TreeOp, { op: 'remove' }> => op.op === 'remove')
          .map((op) => op.path);
        pruneTabsForRemovedPaths(removedPaths);
      }
      if (detectFileType(data.filePath) === 'markdown' && typeof data.markdown !== 'string') {
        if (mode === 'edit' && data.filePath === activePath && editorDirty) {
          deferExternalReload(data.filePath, data.contentMtimeMs);
          return;
        }
        void loadMarkdownForPath(data.filePath, data.contentMtimeMs);
      }
    }

    function applyUpdateContent(data: UpdatePayload): void {
      if (data.rootPath) {
        rootPath = data.rootPath;
      }
      if (data.knownProjects) {
        knownProjects = data.knownProjects;
      }
      if (data.activeProjectPath) {
        activeProjectPath = data.activeProjectPath;
      }
      if (data.searchResults) {
        sidebarSearchQuery = data.searchResults.query ?? '';
        sidebarSearchResults = data.searchResults.items ?? [];
      }
      applyTabScopeForProject(activeProjectPath, rootPath);
      if (data.fileTree) {
        fileTree = data.fileTree;
        loadedDirPaths.clear();
      }
      if (data.treePatch) {
        applyTreePatch(data.treePatch);
        loadedDirPaths.add(normalizeFsPath(data.treePatch.parentPath));
      }
      if (data.treeOps) {
        applyTreeOps(data.treeOps);
        const removedPaths = data.treeOps
          .filter((op): op is Extract<TreeOp, { op: 'remove' }> => op.op === 'remove')
          .map((op) => op.path);
        pruneTabsForRemovedPaths(removedPaths);
      }
      if (data.changedPaths && data.changedPaths.length > 0) {
        invalidatePathCaches(data.changedPaths);
      }

      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        const sourcePath = data.filePath ?? activePath;
        if (sourcePath && detectFileType(sourcePath) === 'markdown') {
          markdownCacheByPath.set(sourcePath, data.markdown);
          deferredReloadMtimeByPath.delete(sourcePath);
          deferredReloadNoticeByPath.delete(sourcePath);
          if (typeof data.contentMtimeMs === 'number') {
            loadedMtimeByPath.set(sourcePath, data.contentMtimeMs);
          }
        }
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
      let targetPath = data.filePath;
      if (!targetPath && data.changedPaths?.includes(activePath)) {
        targetPath = activePath;
      }
      if (targetPath && targetPath === activePath && detectFileType(targetPath) === 'markdown') {
        if (mode === 'edit' && editorDirty) {
          deferExternalReload(targetPath, data.contentMtimeMs);
          return;
        }
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
      increaseFontScale() {
        increaseGlobalFontScale();
      },
      decreaseFontScale() {
        decreaseGlobalFontScale();
      },
      resetFontScale() {
        resetGlobalFontScale();
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

  function saveEdits(): void {
    if (editorRef) {
      const md = editorRef.getMarkdown();
      if (activePath && detectFileType(activePath) === 'markdown') {
        rawMarkdown = md;
        markdownCacheByPath.set(activePath, md);
      }
      structure = extractStructureFromMarkdown(md);
      editSave(md);
      editorRef.commitSaved();
      editorDirty = false;
      if (activePath) {
        deferredReloadMtimeByPath.delete(activePath);
        deferredReloadNoticeByPath.delete(activePath);
      }
    }
  }

  function cancelEdit(): void {
    if (editorRef) {
      editorRef.resetToMarkdown(rawMarkdown);
    }
    editorDirty = false;
    if (activePath && detectFileType(activePath) === 'markdown') {
      void flushDeferredReload(activePath);
    }
    toast.info('Edits reverted');
  }

  function isShortcutsHelpHotkey(e: KeyboardEvent): boolean {
    if (e.repeat) return false;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return false;
    return (
      e.code === 'Slash'
      || e.code === 'NumpadDivide'
      || e.code === 'IntlRo'
      || e.code === 'IntlYen'
      || e.key === '/'
      || e.key === '?'
      || e.key === '÷'
    );
  }

  function isEditableShortcutElement(el: HTMLElement | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return Boolean(
      el.closest('[contenteditable="true"]')
      || el.closest('[role="textbox"]')
      || el.closest('.cm-editor')
      || el.closest('.monaco-editor')
      || el.closest('.ProseMirror'),
    );
  }

  function isEditableShortcutTarget(target: EventTarget | null): boolean {
    const targetEl = target as HTMLElement | null;
    if (isEditableShortcutElement(targetEl)) return true;
    const activeEl = document.activeElement as HTMLElement | null;
    return isEditableShortcutElement(activeEl);
  }

  function handleGlobalShortcutsHelpHotkey(e: KeyboardEvent): void {
    if (!isShortcutsHelpHotkey(e)) return;
    if (isEditableShortcutTarget(e.target)) return;
    e.preventDefault();
    shortcutsOpen = !shortcutsOpen;
    if (shortcutsOpen) commandPaletteOpen = false;
  }

  // Handle sidebar navigation events
  function handleSidebarNavigate(path: string, newTab: boolean): void {
    openPath(path, undefined, newTab);
  }

  function handleProjectSwitch(path: string): void {
    if (!path || path === activeProjectPath) return;
    pendingFrontendNav = false;
    switchProject(path);
  }

  function handleTreeExpand(path: string): void {
    if (!path) return;
    const normalized = normalizeFsPath(path);
    if (loadedDirPaths.has(normalized)) return;
    loadedDirPaths.add(normalized);
    loadChildren(path);
  }

  function handleSidebarSearchQuery(query: string): void {
    searchFiles(query);
  }

  $effect(() => {
    if (activeFileType !== 'markdown') {
      outlineHeadings = [];
      activeOutlineId = '';
      editorDirty = false;
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
    const pending = pendingLinkAnchor;
    if (!pending) return;
    if (activePath !== pending.path) return;
    if (activeFileType !== 'markdown') {
      pendingLinkAnchor = null;
      return;
    }
    requestAnimationFrame(() => {
      scrollToHeadingFragment(pending.fragment);
      if (pendingLinkAnchor?.path === pending.path && pendingLinkAnchor?.fragment === pending.fragment) {
        pendingLinkAnchor = null;
      }
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
    initFontScale();
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
      onUndo: () => {
        if (mode !== 'edit' || activeFileType !== 'markdown') return;
        editorRef?.undoStep();
      },
      onRedo: () => {
        if (mode !== 'edit' || activeFileType !== 'markdown') return;
        editorRef?.redoStep();
      },
      onCommandPalette: () => {
        commandPaletteOpen = !commandPaletteOpen;
        if (commandPaletteOpen) shortcutsOpen = false;
      },
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
    onNavigate={(dir) => openPath(dir, inferFileTypeFromTree(dir))}
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
        onLinkNavigate={handleEditorLinkNavigate}
        onSave={saveEdits}
        onCancel={cancelEdit}
        onDirtyChange={handleEditorDirtyChange}
      />
    {:else if activeFileType === 'image'}
      <ImageViewer src={markdownSourceUrl(activePath)} />
    {:else if activeFileType === 'video' || activeFileType === 'audio'}
      <MediaPlayer src={markdownSourceUrl(activePath)} fileType={activeFileType} />
    {:else if activeFileType === 'directory'}
      <DirectoryOverview
        path={activePath}
        {rootPath}
        entries={fileTree}
        onOpen={(path) => openPath(path, detectFileType(path))}
      />
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
        onLinkNavigate={handleEditorLinkNavigate}
        onSave={saveEdits}
        onCancel={cancelEdit}
        onDirtyChange={handleEditorDirtyChange}
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
    <div
      class="h-[46px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render minimalDiagnosticContent()}
  </main>
{:else if diagMode === 'editor_only'}
  <main class="flex h-screen flex-col overflow-hidden">
    <div
      class="h-[46px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render editorOnlyContent()}
  </main>
{:else if hasSidebar}
  <SidebarProvider class="h-svh overflow-hidden">
    <Sidebar
      entries={fileTree}
      {activePath}
      {rootPath}
      {knownProjects}
      {activeProjectPath}
      remoteSearchQuery={sidebarSearchQuery}
      remoteSearchItems={sidebarSearchResults}
      outline={outlineHeadings}
      {activeOutlineId}
      onProjectSwitch={handleProjectSwitch}
      onNavigate={handleSidebarNavigate}
      onExpand={handleTreeExpand}
      onSearchQuery={handleSidebarSearchQuery}
      onOutlineNavigate={handleOutlineNavigate}
    />
    <SidebarInset class="flex flex-col overflow-hidden">
      {@render mainContent()}
    </SidebarInset>
  </SidebarProvider>
{:else}
  <main class="flex h-screen flex-col overflow-hidden">
    <div
      class="h-[34px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render mainContent()}
  </main>
{/if}

<svelte:window onkeydown={handleGlobalShortcutsHelpHotkey} />
<KeyboardShortcutsDialog bind:open={shortcutsOpen} />
<CommandPalette
  bind:open={commandPaletteOpen}
  {fileTree}
  onSelect={(path) => openPath(path, detectFileType(path))}
/>
