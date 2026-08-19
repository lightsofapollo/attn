<script lang="ts">
  import { tick } from 'svelte';
  import { parseAppRoute, type AppRoute } from '../../lib/hosted/routes';
  import AppHeader from './AppHeader.svelte';
  import DeskHome from './DeskHome.svelte';
  import OpenPage from './OpenPage.svelte';
  import StoragePage from './StoragePage.svelte';
  import NotFound from '../not-found/NotFound.svelte';
  import type { HostedCommand } from './CommandPalette.svelte';
  import type {
    ImportFileInput,
    StorageHealth,
    WorkspaceAppService,
    WorkspaceDetail,
    WorkspaceSummary,
  } from './types';

  interface Props {
    service: WorkspaceAppService;
    route: AppRoute | undefined;
    /** The landing's one-click intent (`/app#new`): atomically create a
     * fresh untitled workspace and open its editor with no dialog. */
    newIntent: boolean;
    joinIntent?: boolean;
  }

  const { service, route: initialRoute, newIntent, joinIntent = false }: Props = $props();

  /* The route is state, not a fixed prop (attn-a9f7.3.1). It used to be read
     once at mount, so every desk↔document move had to be a full page load:
     re-parse, re-bootstrap the service, re-read storage, re-render — on the
     single most-travelled transition in the product, while switching files
     INSIDE a workspace was already instant and in place. The URL contract in
     routes.ts is unchanged; only who applies it moved. */
  // svelte-ignore state_referenced_locally — seeding from the mount-time route
  // is the intent; every later change comes through navigate()/popstate.
  let route = $state<AppRoute | undefined>(initialRoute);

  let phase = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state<string | null>(null);
  // svelte-ignore state_referenced_locally — the service is a stable prop;
  // this seeds the initial value and load() refreshes it.
  let health = $state<StorageHealth>(service.storageHealth());
  let workspaces = $state<WorkspaceSummary[]>([]);
  let detail = $state<WorkspaceDetail | undefined>(undefined);
  let activePath = $state<string | undefined>(undefined);
  let bodyText = $state<string | null>(null);
  let isNewDraft = $state(false);
  let rememberedRooms = $state<string[]>([]);

  /* Desk state that must survive a trip into a document and back: the filter
     query and the scroll position. A full navigation discarded both. */
  let deskFilter = $state('');
  let deskScroll = 0;

  const editorMode = $derived(route?.view === 'workspace');

  async function load(): Promise<void> {
    try {
      health = service.storageHealth();
      if (newIntent) {
        // The URL intent keeps its idempotency (attn-cjn).
        await createAndOpen(true);
        return;
      }
      if (route?.view === 'workspace') {
        detail = await service.getWorkspace(route.workspaceId);
        if (detail) {
          activePath = route.filePath ?? detail.openPath;
          bodyText = await service.readBodyText(detail.id, activePath);
          // Sidebar project switcher: the editor needs the rest of the desk.
          workspaces = await service.listWorkspaces();
        }
      } else {
        workspaces = await service.listWorkspaces();
        if (route?.view === 'storage') {
          rememberedRooms = await service.listRememberedRooms();
        }
      }
      phase = 'ready';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  /** Re-run the initial load after a failure, without a page reload. */
  async function retry(): Promise<void> {
    errorMessage = null;
    phase = 'loading';
    await load();
  }

  /**
   * @param reuseEmpty  Reuse an existing untouched workspace rather than
   *   minting one. True only for the `/app#new` URL intent (attn-n01r.50).
   */
  async function createAndOpen(reuseEmpty: boolean): Promise<void> {
    // #new is idempotent (attn-cjn): reuse the most recent empty, untouched
    // Untitled workspace instead of minting another — a bookmarked /app#new
    // or a back-button revisit must not grow the desk.
    //
    // That guard is scoped to the URL intent it was written for. It used to run
    // for the desk's "New workspace" button too, so a control with that label
    // sometimes reopened an old workspace and said nothing: clicking it three
    // times returned the same id and left the desk count unchanged. A button
    // that names an action has to perform it.
    const existing = reuseEmpty ? await service.listWorkspaces() : [];
    for (const candidate of existing) {
      if (candidate.name !== 'Untitled') continue;
      if (candidate.assetCount > 0 || candidate.htmlCount > 0 || candidate.markdownCount > 1) continue;
      const candidateDetail = await service.getWorkspace(candidate.id);
      if (!candidateDetail) continue;
      const body = await service.readBodyText(candidate.id, candidateDetail.openPath);
      if (body !== null && body.trim().length > 0) continue;
      detail = candidateDetail;
      activePath = candidateDetail.openPath;
      bodyText = body ?? '';
      isNewDraft = true;
      route = { view: 'workspace', workspaceId: detail.id, filePath: activePath };
      history.replaceState(null, '', `/app/w/${detail.id}/${detail.openPath}`);
      workspaces = existing;
      phase = 'ready';
      return;
    }
    detail = await service.createWorkspace();
    activePath = detail.openPath;
    bodyText = '';
    isNewDraft = true;
    route = { view: 'workspace', workspaceId: detail.id, filePath: activePath };
    history.replaceState(null, '', `/app/w/${detail.id}/${detail.openPath}`);
    // The project switcher lists the whole desk, including the new workspace.
    workspaces = await service.listWorkspaces();
    phase = 'ready';
  }

  async function onCreate(): Promise<void> {
    phase = 'loading';
    try {
      // The desk button always creates (attn-n01r.50).
      await createAndOpen(false);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  // Bound EditorShell instance so history navigation can drain its autosave.
  let editorShell = $state<{ flushPendingEdits: () => Promise<void> } | undefined>();

  /* EditorShell is loaded on demand, not statically (attn-n01r.41).
     A static import put the editor's whole dependency set — bits-ui, the
     dialog components, BottomSheet: ~150 KB, 46% of the desk route's static
     JS — into the app entry's modulepreload list, so the desk fetched it at
     highest priority to render a list of file names. It is only ever needed
     under `editorMode && detail`, which is the same condition that guards the
     render below. `editorShell` stays optional-chained at its one call site
     (flushPendingEdits on history navigation), so the brief window before the
     chunk resolves is safe. */
  let EditorShell = $state<typeof import('./EditorShell.svelte').default | undefined>();
  let editorShellPending = false;

  function loadEditorShell(): void {
    if (EditorShell || editorShellPending) return;
    editorShellPending = true;
    void import('./EditorShell.svelte')
      .then((module) => {
        EditorShell = module.default;
      })
      .finally(() => {
        editorShellPending = false;
      });
  }

  // Start the fetch as soon as the route resolves to the editor, so the chunk
  // is in flight while the workspace body is still being read.
  $effect(() => {
    if (editorMode) loadEditorShell();
  });

  // Switch the active file WITHOUT a page reload: read the new body, update
  // state, and push the URL. The editor swaps in place (< 100 ms, no flash)
  // instead of re-bootstrapping the whole app. `push` is false when the change
  // comes from a back/forward navigation (the history entry already exists).
  // The generation counter drops stale reads: rapid selections can resolve
  // out of order, and an older read must never overwrite a newer selection.
  let applyGeneration = 0;
  async function applyEntry(path: string, push: boolean): Promise<void> {
    if (!detail || path === activePath) return;
    const generation = ++applyGeneration;
    try {
      // Read the new body BEFORE mutating any state, so a failed read leaves
      // the current file open rather than half-switching.
      const body = await service.readBodyText(detail.id, path);
      if (generation !== applyGeneration) return;
      activePath = path;
      bodyText = body;
      isNewDraft = false;
      route = { view: 'workspace', workspaceId: detail.id, filePath: path };
      if (push) history.pushState(null, '', `/app/w/${detail.id}/${path}`);
    } catch (error) {
      if (generation !== applyGeneration) return;
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  function onSelectEntry(path: string): void {
    void applyEntry(path, true);
  }

  /* One navigation core for every in-app move (attn-a9f7.3.1). Everything —
     link clicks, the keyboard desk, the palette, back/forward — arrives here,
     so pending edits are drained exactly once per transition and no caller can
     forget to. */
  let navGeneration = 0;

  async function navigate(next: AppRoute, push = true): Promise<void> {
    const generation = ++navGeneration;
    // Leaving the desk: remember where the reader was standing.
    if (route?.view === 'home') deskScroll = window.scrollY;
    // A pending debounced edit must land before the editor unmounts.
    await editorShell?.flushPendingEdits();
    if (generation !== navGeneration) return;

    try {
      if (next.view === 'workspace') {
        await openWorkspaceRoute(next.workspaceId, next.filePath, push, generation);
        return;
      }

      const fresh = await service.listWorkspaces();
      if (generation !== navGeneration) return;
      workspaces = fresh;
      if (next.view === 'storage') {
        rememberedRooms = await service.listRememberedRooms();
        if (generation !== navGeneration) return;
      }
      detail = undefined;
      activePath = undefined;
      bodyText = null;
      isNewDraft = false;
      health = service.storageHealth();
      route = next;
      phase = 'ready';
      if (push) history.pushState(null, '', next.view === 'open' ? '/open' : pathForRoute(next));
      await restoreDeskScroll(next);
    } catch (error) {
      if (generation !== navGeneration) return;
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  function pathForRoute(next: AppRoute): string {
    switch (next.view) {
      case 'home':
        return '/app';
      case 'storage':
        return '/app/storage';
      case 'open':
        return '/open';
      case 'workspace':
        return next.filePath
          ? `/app/w/${next.workspaceId}/${next.filePath}`
          : `/app/w/${next.workspaceId}`;
    }
  }

  async function restoreDeskScroll(next: AppRoute): Promise<void> {
    await tick();
    if (next.view === 'home' && deskScroll > 0) {
      window.scrollTo({ top: deskScroll, behavior: 'auto' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  async function openWorkspaceRoute(
    workspaceId: string,
    filePath: string | undefined,
    push: boolean,
    generation = ++navGeneration,
  ): Promise<void> {
    const fresh = await service.getWorkspace(workspaceId);
    if (generation !== navGeneration) return;
    if (!fresh) {
      // Renders the "not on this device" recovery rather than a blank editor.
      detail = undefined;
      route = { view: 'workspace', workspaceId, filePath };
      phase = 'ready';
      if (push) history.pushState(null, '', pathForRoute(route));
      return;
    }
    const path = filePath ?? fresh.openPath;
    const body = await service.readBodyText(fresh.id, path);
    if (generation !== navGeneration) return;
    detail = fresh;
    activePath = path;
    bodyText = body;
    isNewDraft = false;
    if (workspaces.length === 0) workspaces = await service.listWorkspaces();
    route = { view: 'workspace', workspaceId: fresh.id, filePath: path };
    phase = 'ready';
    const url = `/app/w/${fresh.id}/${path}`;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    await tick();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function onOpenWorkspace(workspaceId: string, filePath: string): void {
    void navigate({ view: 'workspace', workspaceId, filePath });
  }

  /* One delegated link handler instead of a callback threaded through every
     page (attn-a9f7.3.1). Anchors stay real anchors — middle-click, ⌘-click,
     "copy link address" and the status bar all keep working; only the plain
     same-tab click is taken in-app. */
  $effect(() => {
    const handler = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Hash intents (/app#join, /app#new) own their own handling.
      if (url.hash) return;
      const next = parseAppRoute(url.pathname);
      if (!next) return;
      event.preventDefault();
      void navigate(next);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  });

  // Keep the view in sync with the URL on back/forward. Drain the editor's
  // debounce-pending edits FIRST — popstate must behave exactly like an in-app
  // switch, or typing then pressing Back within the debounce window silently
  // discards the pending text.
  $effect(() => {
    const handler = () => {
      const next = parseAppRoute(window.location.pathname);
      if (!next) return;
      void (async () => {
        // Same workspace, different file: the cheap path, no reload of detail.
        if (next.view === 'workspace' && detail && detail.id === next.workspaceId) {
          await editorShell?.flushPendingEdits();
          await applyEntry(next.filePath ?? detail.openPath, false);
          return;
        }
        await navigate(next, false);
      })();
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  });

  // Refresh the in-memory workspace after an entry-list change (create, rename,
  // delete, import assets) — no page reload. `openPath` opens that file; when
  // omitted the current file stays open, unless it was just deleted, in which
  // case we fall back to the workspace's default entry.
  async function onWorkspaceChanged(openPath?: string): Promise<void> {
    if (!detail) return;
    const fresh = await service.getWorkspace(detail.id);
    if (!fresh) return;
    detail = fresh;
    // Keep the project switcher's labels current (workspace renames).
    workspaces = await service.listWorkspaces();
    const target =
      openPath ??
      (activePath && fresh.entries.some((entry) => entry.path === activePath)
        ? activePath
        : fresh.openPath);
    if (target !== activePath) {
      bodyText = await service.readBodyText(fresh.id, target);
      activePath = target;
    }
    isNewDraft = false;
    route = { view: 'workspace', workspaceId: fresh.id, filePath: target };
    history.replaceState(null, '', `/app/w/${fresh.id}/${target}`);
  }

  // Follow cross-tab durable changes. Content/structure keep a read-only
  // workspace fresh; review is deliberately metadata-free and simply asks an
  // already-open Desk to re-project its encrypted log for its count pills.
  $effect(() => {
    return service.subscribeWorkspaceChanges((change) => {
      if (change.kind === 'review') {
        void service.listWorkspaces().then((next) => {
          workspaces = next;
        }).catch(() => undefined);
        return;
      }
      const workspaceId = detail?.id;
      if (!workspaceId) return;
      if (change.workspaceId !== workspaceId) return;
      if (change.kind === 'structure') {
        void onWorkspaceChanged();
        return;
      }
      if (change.path !== undefined && change.path !== activePath) return;
      void refreshActiveBody(workspaceId);
    });
  });

  async function refreshActiveBody(workspaceId: string): Promise<void> {
    const path = activePath;
    if (!path) return;
    const body = await service.readBodyText(workspaceId, path).catch(() => null);
    // Drop stale reads: the user may have switched files while we read.
    if (body !== null && activePath === path) bodyText = body;
  }

  async function onImport(name: string, files: ImportFileInput[]): Promise<void> {
    // Duplicate workspace names get an explicit numbered variant; imports
    // never overwrite or silently merge into an existing workspace.
    const existing = (await service.listWorkspaces()).map((workspace) => workspace.name);
    const { dedupeWorkspaceName } = await import('./import-files');
    const imported = await service.importFiles(dedupeWorkspaceName(name, existing), files);
    workspaces = await service.listWorkspaces();
    void navigate({
      view: 'workspace',
      workspaceId: imported.id,
      filePath: imported.openPath,
    });
  }

  async function onExportWorkspace(workspaceId: string): Promise<void> {
    const target = workspaces.find((workspace) => workspace.id === workspaceId);
    const files = await service.exportWorkspace(workspaceId);
    const { buildManifest, buildWorkspaceZip, triggerDownload, zipFileName } = await import(
      './export-zip'
    );
    const name = target?.name ?? 'workspace';
    const zip = await buildWorkspaceZip(files, buildManifest(name, files, Date.now()));
    triggerDownload(document, zipFileName(name), zip, 'application/zip');
    await service.markBackedUp(workspaceId);
    workspaces = await service.listWorkspaces();
  }

  /* One archive, one download, and "backed up" claimed only afterwards
     (attn-a9f7.1.4). This used to loop triggerDownload() once per workspace and
     mark each one backed up as it went — but a browser that intercepts multiple
     downloads (Chrome's default) delivers the first and silently drops the
     rest, leaving every workspace labelled "Backed up" with one file on disk.
     A backup flow may not claim success it cannot verify. */
  async function onExportAll(): Promise<void> {
    if (workspaces.length === 0) return;
    const exported: Array<{ id: string; name: string; files: ImportFileInput[] }> = [];
    for (const workspace of workspaces) {
      exported.push({
        id: workspace.id,
        name: workspace.name,
        files: await service.exportWorkspace(workspace.id),
      });
    }
    const { buildDeskBackupZip, deskBackupFileName, triggerDownload } = await import('./export-zip');
    const exportedAt = Date.now();
    const zip = await buildDeskBackupZip(exported, exportedAt);
    triggerDownload(document, deskBackupFileName(exportedAt), zip, 'application/zip');
    for (const workspace of exported) {
      await service.markBackedUp(workspace.id);
    }
    workspaces = await service.listWorkspaces();
  }

  async function onClearAll(): Promise<void> {
    await service.clearAllWorkspaces();
    workspaces = await service.listWorkspaces();
    health = service.storageHealth();
  }

  async function onForgetRoom(roomId: string): Promise<void> {
    await service.forgetRoom(roomId);
    rememberedRooms = await service.listRememberedRooms();
  }

  async function onRename(workspaceId: string, name: string): Promise<void> {
    await service.renameWorkspace(workspaceId, name);
    workspaces = await service.listWorkspaces();
  }

  async function onDelete(workspaceId: string): Promise<void> {
    await service.deleteWorkspace(workspaceId);
    workspaces = await service.listWorkspaces();
  }

  /* The desk gets the palette too (attn-a9f7.3.4). ⌘K existed only inside a
     workspace, so the one surface a keyboard-first user opens most had no
     command surface at all. Loaded on first use, so the desk's static bundle
     is unchanged. */
  let CommandPalette = $state<typeof import('./CommandPalette.svelte').default | undefined>();
  let paletteOpen = $state(false);

  const deskCommands = $derived<HostedCommand[]>([
    { id: 'new', label: 'New workspace', hint: 'Untitled.md', keywords: 'create sheet document', run: () => void onCreate() },
    { id: 'import', label: 'Import files…', keywords: 'open upload folder zip', run: () => void navigate({ view: 'open' }) },
    { id: 'join', label: 'Join a review', keywords: 'invite link share', run: () => { window.location.assign('/app#join'); } },
    { id: 'storage', label: 'Storage & recovery', keywords: 'export backup quota clear', run: () => void navigate({ view: 'storage' }) },
    ...workspaces.map((workspace) => ({
      id: `ws-${workspace.id}`,
      label: `Open ${workspace.name}`,
      hint: workspace.lastEditedLabel,
      keywords: 'workspace open switch',
      run: () => onOpenWorkspace(workspace.id, workspace.openPath),
    })),
  ]);

  function onShellKeydown(event: KeyboardEvent): void {
    if (editorMode) return; // The editor owns its own palette.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      void openPalette();
    }
  }

  async function openPalette(): Promise<void> {
    if (!CommandPalette) {
      CommandPalette = (await import('./CommandPalette.svelte')).default;
    }
    paletteOpen = true;
  }

  const chromeView = $derived(
    phase === 'ready' && route && route.view !== 'workspace' ? route.view : undefined,
  );

  void load();
</script>

<svelte:window onkeydown={onShellKeydown} />

{#if phase === 'loading'}
  <div class="app-shell" data-app-view="loading">
    <main class="desk">
      <p class="eyebrow" role="status">Opening your desk…</p>
    </main>
  </div>
{:else if phase === 'error'}
  <!-- The moment of real fear had the least design in the app (attn-a9f7.1.3):
       a raw exception string, no retry, no route out. Say what is safe, offer
       the two actions that can help, and keep the internals for whoever wants
       them. -->
  <div class="app-shell" data-app-view="error">
    <AppHeader mode={health.mode} />
    <main class="desk">
      <div class="desk-title">
        <div>
          <div class="eyebrow">Something went wrong</div>
          <h1>Your desk couldn’t open</h1>
        </div>
      </div>
      <p class="error-lede" role="alert">
        Your workspaces are still stored in this browser profile — nothing was deleted. The desk
        failed to read them, which is usually temporary.
      </p>
      <div class="storage-actions">
        <button class="button primary" type="button" onclick={() => void retry()}>Try again</button>
        <a class="button" href="/app/storage">Check storage</a>
      </div>
      {#if errorMessage}
        <details class="error-detail">
          <summary>Technical detail</summary>
          <p>{errorMessage}</p>
        </details>
      {/if}
    </main>
  </div>
{:else if editorMode && detail && EditorShell}
  <EditorShell
    bind:this={editorShell}
    {service}
    workspace={detail}
    {activePath}
    {bodyText}
    {isNewDraft}
    {onSelectEntry}
    {onWorkspaceChanged}
    {workspaces}
    onSwitchWorkspace={(workspaceId) => {
      const target = workspaces.find((workspace) => workspace.id === workspaceId);
      void navigate({
        view: 'workspace',
        workspaceId,
        filePath: target?.openPath,
      });
    }}
  />
{:else if editorMode && detail}
  <!-- The editor chunk is in flight (attn-n01r.41). Without this branch the
       unloaded case would fall through to "That workspace isn't here", which
       is both wrong and alarming — the workspace is present, its UI is not
       downloaded yet. -->
  <div class="app-shell" data-app-view="editor-loading">
    <main class="desk">
      <p class="eyebrow" role="status">Opening {detail.name}…</p>
    </main>
  </div>
{:else if editorMode}
  <!-- The shared recovery surface (attn-08fa.10). This branch used to render a
       headerless page built from inline styles, whose only way out was a muted
       underlined "your desk" link — a low-visibility recovery path, and a link
       treatment matching neither the prose rule (accent + underline) nor the
       chrome-anchor rule (no underline). It now says its own words through the
       same component the 404 uses, so both get the header, the type scale, the
       capped measure and the two real buttons. -->
  <NotFound
    status="Not on this device"
    heading="That workspace isn’t here."
    copy="Local workspaces live in the browser profile that created them. Import a backup to bring this one onto this device, or go back to your desk."
    primary={{ href: '/app', label: 'Go to your desk' }}
    secondary={{ href: '/open', label: 'Import a workspace' }}
    documentTitle="Workspace not found · attn"
  />
{:else}
  <!-- One shell, three chrome views (attn-a9f7.3.2). The header used to be
       rendered separately inside each page, so desk → storage → open rebuilt
       the same masthead three times and each copy could drift; the shell owns
       it now and the pages contribute only their own main. -->
  <div class="app-shell" data-app-view={chromeView ?? 'home'}>
    <AppHeader mode={health.mode}>
      {#snippet actions()}
        {#if chromeView === 'home'}
          <a class="button" href="/app/storage">Storage</a>
        {:else}
          <a class="button" href="/app">Back to your desk</a>
        {/if}
      {/snippet}
    </AppHeader>
    {#if chromeView === 'storage'}
      <StoragePage
        {health}
        {workspaces}
        rooms={rememberedRooms}
        {onImport}
        {onExportWorkspace}
        {onExportAll}
        {onClearAll}
        {onForgetRoom}
      />
    {:else if chromeView === 'open'}
      <OpenPage {health} {onImport} />
    {:else}
      <DeskHome
        bind:filterQuery={deskFilter}
        {joinIntent}
        {health}
        {workspaces}
        {onCreate}
        {onImport}
        {onRename}
        {onDelete}
        {onExportWorkspace}
        {onOpenWorkspace}
      />
    {/if}
  </div>
{/if}

{#if CommandPalette && !editorMode}
  <CommandPalette bind:open={paletteOpen} commands={deskCommands} />
{/if}
