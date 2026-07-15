<script lang="ts">
  import type { AppRoute } from '../../lib/hosted/routes';
  import DeskHome from './DeskHome.svelte';
  import EditorShell from './EditorShell.svelte';
  import OpenPage from './OpenPage.svelte';
  import StoragePage from './StoragePage.svelte';
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

  const { service, route, newIntent, joinIntent = false }: Props = $props();

  let phase = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state<string | null>(null);
  // svelte-ignore state_referenced_locally — the service is a stable prop;
  // this seeds the initial value and load() refreshes it.
  let health = $state<StorageHealth>(service.storageHealth());
  let workspaces = $state<WorkspaceSummary[]>([]);
  let detail = $state<WorkspaceDetail | undefined>(undefined);
  let activePath = $state<string | undefined>(undefined);
  let bodyText = $state<string | null>(null);
  let editorMode = $state(false);
  let isNewDraft = $state(false);

  async function load(): Promise<void> {
    try {
      health = service.storageHealth();
      if (newIntent) {
        await createAndOpen();
        return;
      }
      if (route?.view === 'workspace') {
        detail = await service.getWorkspace(route.workspaceId);
        if (detail) {
          activePath = route.filePath ?? detail.openPath;
          bodyText = await service.readBodyText(detail.id, activePath);
          editorMode = true;
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

  async function createAndOpen(): Promise<void> {
    // #new is idempotent (attn-cjn): reuse the most recent empty, untouched
    // Untitled workspace instead of minting another — a bookmarked /app#new
    // or a back-button revisit must not grow the desk.
    const existing = await service.listWorkspaces();
    for (const candidate of existing) {
      if (candidate.name !== 'Untitled') continue;
      if (candidate.assetCount > 0 || candidate.markdownCount > 1) continue;
      const candidateDetail = await service.getWorkspace(candidate.id);
      if (!candidateDetail) continue;
      const body = await service.readBodyText(candidate.id, candidateDetail.openPath);
      if (body !== null && body.trim().length > 0) continue;
      detail = candidateDetail;
      activePath = candidateDetail.openPath;
      bodyText = body ?? '';
      editorMode = true;
      isNewDraft = true;
      history.replaceState(null, '', `/app/w/${detail.id}/${detail.openPath}`);
      workspaces = existing;
      phase = 'ready';
      return;
    }
    detail = await service.createWorkspace();
    activePath = detail.openPath;
    bodyText = '';
    editorMode = true;
    isNewDraft = true;
    history.replaceState(null, '', `/app/w/${detail.id}/${detail.openPath}`);
    // The project switcher lists the whole desk, including the new workspace.
    workspaces = await service.listWorkspaces();
    phase = 'ready';
  }

  async function onCreate(): Promise<void> {
    phase = 'loading';
    try {
      await createAndOpen();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  // Switch the active file WITHOUT a page reload: read the new body, update
  // state, and push the URL. The editor swaps in place (< 100 ms, no flash)
  // instead of re-bootstrapping the whole app. `push` is false when the change
  // comes from a back/forward navigation (the history entry already exists).
  async function applyEntry(path: string, push: boolean): Promise<void> {
    if (!detail || path === activePath) return;
    try {
      // Read the new body BEFORE mutating any state, so a failed read leaves
      // the current file open rather than half-switching.
      const body = await service.readBodyText(detail.id, path);
      activePath = path;
      bodyText = body;
      isNewDraft = false;
      if (push) history.pushState(null, '', `/app/w/${detail.id}/${path}`);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = 'error';
    }
  }

  function onSelectEntry(path: string): void {
    void applyEntry(path, true);
  }

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
    history.replaceState(null, '', `/app/w/${fresh.id}/${target}`);
  }

  // Keep the active file in sync with the URL on back/forward.
  $effect(() => {
    const handler = () => {
      if (!detail) return;
      const match = window.location.pathname.match(/^\/app\/w\/[^/]+\/(.+)$/u);
      const path = match ? decodeURIComponent(match[1]) : detail.openPath;
      void applyEntry(path, false);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  });

  // Follow the writer: when ANOTHER tab commits to this workspace (the service
  // never delivers this tab's own changes), re-read from storage so the
  // read-only tab mirrors the writer live instead of showing a stale snapshot.
  $effect(() => {
    const workspaceId = detail?.id;
    if (!workspaceId) return;
    return service.subscribeWorkspaceChanges((change) => {
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
    window.location.assign(`/app/w/${imported.id}/${imported.openPath}`);
  }

  let rememberedRooms = $state<string[]>([]);

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

  async function onExportAll(): Promise<void> {
    const { buildManifest, buildWorkspaceZip, triggerDownload } = await import('./export-zip');
    for (const workspace of workspaces) {
      const files = await service.exportWorkspace(workspace.id);
      const zip = await buildWorkspaceZip(files, buildManifest(workspace.name, files, Date.now()));
      triggerDownload(document, `${workspace.name.replaceAll('/', '-')}.zip`, zip, 'application/zip');
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

  void load();
</script>

{#if phase === 'loading'}
  <div class="app-shell" data-app-view="loading">
    <main class="desk">
      <p class="eyebrow" role="status">Opening your desk…</p>
    </main>
  </div>
{:else if phase === 'error'}
  <div class="app-shell" data-app-view="error">
    <main class="desk">
      <div class="desk-title">
        <div>
          <div class="eyebrow">Something went wrong</div>
          <h1>Your desk couldn’t open</h1>
        </div>
      </div>
      <p style="margin-top: 2rem; font: 1rem/1.6 var(--sans); color: var(--hosted-muted);" role="alert">
        {errorMessage}
      </p>
    </main>
  </div>
{:else if editorMode && detail}
  <EditorShell
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
      window.location.assign(
        target ? `/app/w/${workspaceId}/${target.openPath}` : `/app/w/${workspaceId}`,
      );
    }}
  />
{:else if route?.view === 'workspace'}
  <div class="app-shell" data-app-view="missing">
    <main class="desk">
      <div class="desk-title">
        <div>
          <div class="eyebrow">Not on this device</div>
          <h1>That workspace isn’t here</h1>
        </div>
      </div>
      <p style="margin-top: 2rem; font: 1rem/1.6 var(--sans); color: var(--hosted-muted);">
        Local workspaces live in the browser profile that created them. Import a backup, or go
        back to <a href="/app" style="text-decoration: underline;">your desk</a>.
      </p>
    </main>
  </div>
{:else if route?.view === 'storage'}
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
{:else if route?.view === 'open'}
  <OpenPage {health} {onImport} />
{:else}
  <DeskHome
    {joinIntent} {health} {workspaces} {onCreate} {onImport} {onRename} {onDelete} />
{/if}
