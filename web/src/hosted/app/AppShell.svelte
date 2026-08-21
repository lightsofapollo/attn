<script lang="ts">
  import { tick } from 'svelte';
  import { appWorkspaceUrl, parseAppRoute, type AppRoute } from '../../lib/hosted/routes';
  import {
    canApplyWorkspaceRead,
    createNavigationGuard,
    type PendingWorkspaceRead,
  } from './navigation-guard';
  import { clearChunkReload, takeChunkReload } from './chunk-reload';
  import AppHeader from './AppHeader.svelte';
  import DeskHome from './DeskHome.svelte';
  import LoadingLine from './LoadingLine.svelte';
  import OpenPage from './OpenPage.svelte';
  import {
    forgetAllWorkspaceOrigins,
    forgetWorkspaceOrigin,
    readWorkspaceOrigin,
    rememberWorkspaceOrigin,
  } from './workspace-origin';
  import StoragePage from './StoragePage.svelte';
  import NotFound from '../not-found/NotFound.svelte';
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
  }

  const { service, route: initialRoute, newIntent }: Props = $props();

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
  /* Why the workspace was opened, when this session opened it (attn-mkmz.5).
     "blank" means the person asked for an empty page in so many words, so the
     canvas must not then cover it with an offer to import something — that is
     the one route where the invitation would be answering a question they had
     already answered. Everything else, including the `#new` URL intent, leaves
     the invitation up, because starting blank is deliberately NOT the default
     (user ruling, 2026-08-20). */
  let createIntent = $state<'blank' | 'import' | undefined>();
  let rememberedRooms = $state<string[]>([]);

  /* Desk state that must survive a trip into a document and back: the filter
     query and the scroll position. A full navigation discarded both. */
  let deskFilter = $state('');
  let deskScroll = 0;

  const editorMode = $derived(route?.view === 'workspace');

  /* One transition token shared by every async path that mutates the state
     above (attn-1l2f.2). Declared here, with that state, because the first
     user of it is `load()` immediately below. */
  const nav = createNavigationGuard();

  async function load(): Promise<void> {
    // The first paint is a transition like any other: a popstate or a link
    // click can land while the initial read is still out (attn-1l2f.2).
    const generation = nav.begin();
    try {
      health = service.storageHealth();
      if (newIntent) {
        // The URL intent keeps its idempotency (attn-cjn).
        await createAndOpen(true, 'import', generation);
        return;
      }
      if (route?.view === 'workspace') {
        const fresh = await service.getWorkspace(route.workspaceId);
        if (!nav.isCurrent(generation)) return;
        detail = fresh;
        if (detail) {
          /* A reload has no session intent, so recover it (attn-rjuo.1.2): an
             explicitly blank workspace must not be re-covered with an offer to
             import something. Unknown origin falls through to undefined, which
             leaves the import-first default in place. */
          createIntent = readWorkspaceOrigin(detail.id);
          activePath = route.filePath ?? detail.openPath;
          const body = await service.readBodyText(detail.id, activePath);
          if (!nav.isCurrent(generation)) return;
          bodyText = body;
          // Sidebar project switcher: the editor needs the rest of the desk.
          const desk = await service.listWorkspaces();
          if (!nav.isCurrent(generation)) return;
          workspaces = desk;
        }
      } else {
        const desk = await service.listWorkspaces();
        if (!nav.isCurrent(generation)) return;
        workspaces = desk;
        if (route?.view === 'storage') {
          const rooms = await service.listRememberedRooms();
          if (!nav.isCurrent(generation)) return;
          rememberedRooms = rooms;
        }
      }
      phase = 'ready';
    } catch (error) {
      if (!nav.isCurrent(generation)) return;
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
  async function createAndOpen(
    reuseEmpty: boolean,
    intent: 'blank' | 'import',
    generation = nav.begin(),
  ): Promise<void> {
    createIntent = intent;
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
    if (!nav.isCurrent(generation)) return;
    for (const candidate of existing) {
      if (candidate.name !== 'Untitled') continue;
      if (candidate.assetCount > 0 || candidate.htmlCount > 0 || candidate.markdownCount > 1) continue;
      const candidateDetail = await service.getWorkspace(candidate.id);
      if (!candidateDetail) continue;
      const body = await service.readBodyText(candidate.id, candidateDetail.openPath);
      if (!nav.isCurrent(generation)) return;
      if (body !== null && body.trim().length > 0) continue;
      detail = candidateDetail;
      rememberWorkspaceOrigin(detail.id, intent);
      activePath = candidateDetail.openPath;
      bodyText = body ?? '';
      isNewDraft = true;
      route = { view: 'workspace', workspaceId: detail.id, filePath: activePath };
      history.replaceState(null, '', appWorkspaceUrl(detail.id, detail.openPath));
      workspaces = existing;
      phase = 'ready';
      return;
    }
    const created = await service.createWorkspace();
    if (!nav.isCurrent(generation)) return;
    detail = created;
    rememberWorkspaceOrigin(detail.id, intent);
    activePath = detail.openPath;
    bodyText = '';
    isNewDraft = true;
    route = { view: 'workspace', workspaceId: detail.id, filePath: activePath };
    history.replaceState(null, '', appWorkspaceUrl(detail.id, detail.openPath));
    // The project switcher lists the whole desk, including the new workspace.
    const desk = await service.listWorkspaces();
    if (!nav.isCurrent(generation)) return;
    workspaces = desk;
    phase = 'ready';
  }

  async function onCreate(intent: 'blank' | 'import' = 'blank'): Promise<void> {
    phase = 'loading';
    try {
      // The desk button always creates (attn-n01r.50).
      await createAndOpen(false, intent);
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
  let editorShellFailed = $state(false);
  let editorShellError = $state<string | null>(null);

  /* A chunk that never arrives is not a slow chunk (attn-ze60.1). This loader
     used to be a bare `import().then()` with no rejection handler, so a failed
     fetch — the tab lost the network mid-navigation, or the deployment this
     document came from has been replaced and its hashed chunks are now 404s —
     left `EditorShell` undefined with nothing to re-trigger the effect above.
     The workspace then sat under "Opening ..." for as long as the person was
     willing to watch it, and the only record of the fault was an unhandled
     rejection in a console they had no reason to open. */
  function loadEditorShell(): void {
    if (EditorShell || editorShellPending) return;
    editorShellPending = true;
    editorShellFailed = false;
    void import('./EditorShell.svelte')
      .then((module) => {
        EditorShell = module.default;
        // The chunk arrived, so a later, unrelated failure in this tab is a
        // different failure and gets its own reload.
        clearChunkReload();
      })
      .catch((error: unknown) => {
        console.error('[attn] the editor chunk failed to load', error);
        editorShellError = error instanceof Error ? error.message : String(error);
        // Retrying the import cannot help: the module map remembers a failed
        // fetch and answers the next call with the same rejection without
        // going back to the network. A fresh document can — it re-reads
        // index.html and so picks up the new chunk names, which is the whole
        // of the stale-deploy case. chunk-reload.ts owns the ceiling of one.
        if (takeChunkReload()) {
          window.location.reload();
          return;
        }
        editorShellFailed = true;
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
  //
  // The read is tagged with both the transition that issued it and the
  // workspace it was issued against (attn-1l2f.2). Rapid selections resolve
  // out of order, so an older read must never overwrite a newer one — and a
  // read from a workspace the user has since left must never land at all, or
  // its body and path end up in the new workspace's editor, URL, and autosave.
  async function applyEntry(path: string, push: boolean): Promise<void> {
    if (!detail || path === activePath) return;
    const pending: PendingWorkspaceRead = { token: nav.begin(), workspaceId: detail.id };
    try {
      // Read the new body BEFORE mutating any state, so a failed read leaves
      // the current file open rather than half-switching.
      const body = await service.readBodyText(pending.workspaceId, path);
      if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
      activePath = path;
      bodyText = body;
      isNewDraft = false;
      createIntent = undefined;
      route = { view: 'workspace', workspaceId: pending.workspaceId, filePath: path };
      if (push) history.pushState(null, '', appWorkspaceUrl(pending.workspaceId, path));
    } catch (error) {
      if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
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
     forget to. Each takes a token from `nav`, so a move of any kind supersedes
     whatever was in flight — a file switch cancels a workspace navigation and
     vice versa. */
  async function navigate(next: AppRoute, push = true): Promise<void> {
    const generation = nav.begin();
    // Leaving the desk: remember where the reader was standing.
    if (route?.view === 'home') deskScroll = window.scrollY;
    // A pending debounced edit must land before the editor unmounts.
    await editorShell?.flushPendingEdits();
    if (!nav.isCurrent(generation)) return;

    try {
      if (next.view === 'workspace') {
        await openWorkspaceRoute(next.workspaceId, next.filePath, push, generation);
        return;
      }

      const fresh = await service.listWorkspaces();
      if (!nav.isCurrent(generation)) return;
      workspaces = fresh;
      if (next.view === 'storage') {
        rememberedRooms = await service.listRememberedRooms();
        if (!nav.isCurrent(generation)) return;
      }
      detail = undefined;
      activePath = undefined;
      bodyText = null;
      isNewDraft = false;
      createIntent = undefined;
      health = service.storageHealth();
      route = next;
      phase = 'ready';
      if (push) history.pushState(null, '', next.view === 'open' ? '/open' : pathForRoute(next));
      await restoreDeskScroll(next);
    } catch (error) {
      if (!nav.isCurrent(generation)) return;
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
        return appWorkspaceUrl(next.workspaceId, next.filePath);
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
    generation = nav.begin(),
  ): Promise<void> {
    const fresh = await service.getWorkspace(workspaceId);
    if (!nav.isCurrent(generation)) return;
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
    if (!nav.isCurrent(generation)) return;
    detail = fresh;
    activePath = path;
    bodyText = body;
    isNewDraft = false;
    createIntent = undefined;
    if (workspaces.length === 0) workspaces = await service.listWorkspaces();
    route = { view: 'workspace', workspaceId: fresh.id, filePath: path };
    phase = 'ready';
    const url = appWorkspaceUrl(fresh.id, path);
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
    // A background refresh: it must be dropped by a navigation, never cancel
    // one, and never write another workspace's entries over the open document
    // (attn-1l2f.2).
    const pending: PendingWorkspaceRead = { token: nav.current(), workspaceId: detail.id };
    const fresh = await service.getWorkspace(pending.workspaceId);
    if (!fresh) return;
    if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
    detail = fresh;
    // Keep the project switcher's labels current (workspace renames).
    const desk = await service.listWorkspaces();
    if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
    workspaces = desk;
    const target =
      openPath ??
      (activePath && fresh.entries.some((entry) => entry.path === activePath)
        ? activePath
        : fresh.openPath);
    if (target !== activePath) {
      const body = await service.readBodyText(fresh.id, target);
      if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
      bodyText = body;
      activePath = target;
    }
    isNewDraft = false;
    createIntent = undefined;
    route = { view: 'workspace', workspaceId: fresh.id, filePath: target };
    history.replaceState(null, '', appWorkspaceUrl(fresh.id, target));
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
    const pending: PendingWorkspaceRead = { token: nav.current(), workspaceId };
    const body = await service.readBodyText(workspaceId, path).catch(() => null);
    // Drop stale reads: the user may have switched files — or workspaces —
    // while we read, and two workspaces routinely hold the same path name.
    if (body === null || activePath !== path) return;
    if (!canApplyWorkspaceRead(nav, pending, detail?.id)) return;
    bodyText = body;
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
    forgetAllWorkspaceOrigins();
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
    forgetWorkspaceOrigin(workspaceId);
    workspaces = await service.listWorkspaces();
  }

  /* No desk-level command palette (attn-mkmz.6). attn-a9f7.3.4 added a second
     one here with its own command set, so ⌘K meant two different lists
     depending on which route you were standing on. The palette James introduced
     (c810cb9) is document-scoped and lives in EditorShell; the native app puts
     its palette in the same place for the same reason. The desk's own actions
     are all on the desk, visible, one click away. */

  const chromeView = $derived(
    phase === 'ready' && route && route.view !== 'workspace' ? route.view : undefined,
  );

  void load();
</script>

{#if phase === 'loading'}
  <!-- attn-mkmz.7. Both loading branches used to render `main.desk` with a
       left-aligned eyebrow at the top of the page — so opening a DOCUMENT drew
       a desk-shaped page first, then snapped to a three-column editor, and the
       indicator itself sat in the top-left corner of a region it was standing
       in for. One centred surface for every wait, and the editor route names
       the same thing at every stage (see EditorShell's own loading text). -->
  <div class="app-shell" data-app-view="loading">
    <div class="app-loading" role="status"><LoadingLine text="Opening your desk" /></div>
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
    {createIntent}
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
{:else if editorMode && detail && editorShellFailed}
  <!-- The editor's code never arrived (attn-ze60.1). The same surface as the
       desk failure above, with the words the situation actually calls for: the
       workspace is present and intact, it is the app that is incomplete, so the
       recovery is a fresh document rather than a re-read of storage. -->
  <div class="app-shell" data-app-view="error">
    <AppHeader mode={health.mode} />
    <main class="desk">
      <div class="desk-title">
        <div>
          <div class="eyebrow">Something went wrong</div>
          <h1>The editor didn’t finish loading</h1>
        </div>
      </div>
      <p class="error-lede" role="alert">
        {detail.name} is safe in this browser profile — nothing was lost. Part of attn itself
        failed to download, which usually means the app was updated while this tab was open.
      </p>
      <div class="storage-actions">
        <button class="button primary" type="button" onclick={() => window.location.reload()}>
          Reload attn
        </button>
        <a class="button" href="/app">Go to your desk</a>
      </div>
      {#if editorShellError}
        <details class="error-detail">
          <summary>Technical detail</summary>
          <p>{editorShellError}</p>
        </details>
      {/if}
    </main>
  </div>
{:else if editorMode && detail}
  <!-- The editor chunk is in flight (attn-n01r.41). Without this branch the
       unloaded case would fall through to "That workspace isn't here", which
       is both wrong and alarming — the workspace is present, its UI is not
       downloaded yet. -->
  <div class="app-shell" data-app-view="editor-loading">
    <div class="app-loading" role="status"><LoadingLine text={`Opening ${detail.name}`} /></div>
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

