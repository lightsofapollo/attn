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
  }

  const { service, route, newIntent }: Props = $props();

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
        [workspaces, detail] = await Promise.all([
          service.listWorkspaces(),
          service.getWorkspace(route.workspaceId),
        ]);
        if (detail) {
          activePath = route.filePath ?? detail.openPath;
          bodyText = await service.readBodyText(detail.id, activePath);
          editorMode = true;
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
    detail = await service.createWorkspace();
    workspaces = await service.listWorkspaces();
    activePath = detail.openPath;
    bodyText = '';
    editorMode = true;
    isNewDraft = true;
    history.replaceState(null, '', `/app/w/${detail.id}/${detail.openPath}`);
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

  async function refreshOpenWorkspace(nextActivePath = activePath): Promise<void> {
    if (!detail) return;
    const refreshed = await service.getWorkspace(detail.id);
    if (!refreshed) return;
    const nextPath = nextActivePath && refreshed.entries.some((entry) => entry.path === nextActivePath)
      ? nextActivePath
      : refreshed.openPath;
    const nextBody = await service.readBodyText(refreshed.id, nextPath);
    detail = refreshed;
    activePath = nextPath;
    bodyText = nextBody;
    workspaces = await service.listWorkspaces();
    history.replaceState(null, '', `/app/w/${refreshed.id}/${nextPath}`);
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
      <p style="margin-top: 2rem; font: 1rem/1.6 var(--sans); color: var(--muted);" role="alert">
        {errorMessage}
      </p>
    </main>
  </div>
{:else if editorMode && detail}
  <EditorShell
    {service}
    workspace={detail}
    {workspaces}
    {activePath}
    {bodyText}
    {isNewDraft}
    onWorkspaceRefresh={refreshOpenWorkspace}
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
      <p style="margin-top: 2rem; font: 1rem/1.6 var(--sans); color: var(--muted);">
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
  <DeskHome {health} {workspaces} {onCreate} {onImport} {onRename} {onDelete} />
{/if}
