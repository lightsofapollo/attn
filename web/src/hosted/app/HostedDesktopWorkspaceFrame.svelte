<script lang="ts">
  import type { Snippet } from 'svelte';
  import PathBreadcrumb from '../../lib/PathBreadcrumb.svelte';
  import ReviewBar from '../../lib/ReviewBar.svelte';
  import Sidebar from '../../lib/Sidebar.svelte';
  import WorkspaceEditorFrame from '../../lib/WorkspaceEditorFrame.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { reviewStore } from '../../lib/review/store.svelte';
  import { ownerUnreadByPath } from '../../lib/review/room-ui';
  import { RAIL_WIDTH_PX } from '../../lib/review/rail-mode';
  import type { WorkspaceEntry } from './types';
  import {
    workspaceEntriesToTree,
    workspaceRelativePath,
    workspaceTreePath,
    workspaceVirtualRoot,
  } from './workspace-tree';
  import './desktop-editor-styles';

  interface Props {
    workspaceId: string;
    workspaceName: string;
    entries: WorkspaceEntry[];
    /** All workspaces on this desk — the sidebar project row switches between them. */
    workspaces?: { id: string; name: string }[];
    onSwitchWorkspace?: (workspaceId: string) => void;
    onCreateWorkspace?: () => void;
    onRenameWorkspace?: () => void;
    onOpenDesk?: () => void;
    activeEntryPath?: string;
    shareOpen: boolean;
    actions: Snippet;
    footer: Snippet;
    content: Snippet;
    rail: Snippet;
    onNavigate: (path: string) => void;
    onShare: (trigger?: HTMLButtonElement) => void;
    onRename?: (path: string) => void;
    onDelete?: (path: string) => void;
    onViewport?: (viewport: HTMLElement | null) => void;
  }

  let {
    workspaceId,
    workspaceName,
    entries,
    workspaces = [],
    onSwitchWorkspace,
    onCreateWorkspace,
    onRenameWorkspace,
    onOpenDesk,
    activeEntryPath,
    shareOpen,
    actions,
    footer,
    content,
    rail,
    onNavigate,
    onShare,
    onRename,
    onDelete,
    onViewport,
  }: Props = $props();

  const rootPath = $derived(workspaceVirtualRoot(workspaceId));
  const activePath = $derived(
    activeEntryPath ? workspaceTreePath(workspaceId, activeEntryPath) : rootPath,
  );
  const tree = $derived(workspaceEntriesToTree(workspaceId, entries));
  function toWorkspacePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const root = workspaceVirtualRoot(workspaceId);
    if (path === root || path.startsWith(`${root}/`)) return path;
    return workspaceTreePath(workspaceId, normalized);
  }
  const sharedPaths = $derived.by(() => {
    const paths = new Set<string>();
    for (const snapshot of reviewStore.snapshots) {
      if (reviewStore.rooms[snapshot.roomId]?.role !== 'owner') continue;
      if (snapshot.ownerDisplayPath) paths.add(toWorkspacePath(snapshot.ownerDisplayPath));
    }
    return paths;
  });
  const unreadByPath = $derived.by(() => {
    const raw = ownerUnreadByPath({
      rooms: reviewStore.roomsList,
      snapshots: reviewStore.snapshots,
      unreadByRoom: reviewStore.unreadByRoom,
    });
    return Object.fromEntries(
      Object.entries(raw).map(([path, count]) => [toWorkspacePath(path), count]),
    );
  });
  // Project switcher: every workspace on the desk, addressed by virtual root.
  const switcherProjects = $derived(
    workspaces.length > 0
      ? workspaces.map((workspace) => workspaceVirtualRoot(workspace.id))
      : [rootPath],
  );
  const switcherLabels = $derived(
    Object.fromEntries(
      workspaces.map((workspace) => [workspaceVirtualRoot(workspace.id), workspace.name]),
    ),
  );

  function switchProject(projectRoot: string): void {
    const target = workspaces.find(
      (workspace) => workspaceVirtualRoot(workspace.id) === projectRoot,
    );
    if (target && target.id !== workspaceId) onSwitchWorkspace?.(target.id);
  }

  // Workspace-realm actions live in the picker menu, with the identity they
  // act on — not scattered across the header or the footer.
  const projectMenuActions = $derived([
    ...(onCreateWorkspace ? [{ id: 'new-workspace', label: 'New workspace', run: onCreateWorkspace }] : []),
    ...(onRenameWorkspace ? [{ id: 'rename-workspace', label: 'Rename workspace', run: onRenameWorkspace }] : []),
    ...(onOpenDesk ? [{ id: 'all-workspaces', label: 'All workspaces', run: onOpenDesk }] : []),
  ]);
  let viewport = $state<HTMLElement | null>(null);

  $effect(() => {
    onViewport?.(viewport);
    return () => onViewport?.(null);
  });

  function navigateTree(treePath: string): void {
    const relativePath = workspaceRelativePath(workspaceId, treePath);
    if (relativePath) onNavigate(relativePath);
  }

  function renameTree(treePath: string): void {
    const relativePath = workspaceRelativePath(workspaceId, treePath);
    if (relativePath) onRename?.(relativePath);
  }

  function deleteTree(treePath: string): void {
    const relativePath = workspaceRelativePath(workspaceId, treePath);
    if (relativePath) onDelete?.(relativePath);
  }
</script>

{#snippet sidebar()}
  <Sidebar
    entries={tree}
    {activePath}
    {rootPath}
    knownProjects={switcherProjects}
    activeProjectPath={rootPath}
    rootLabel={workspaceName}
    projectLabels={switcherLabels}
    onProjectSwitch={switchProject}
    {projectMenuActions}
    showOutline={false}
    showWindowDragRegion={false}
    {sharedPaths}
    {unreadByPath}
    {footer}
    onNavigate={navigateTree}
    onRename={onRename ? renameTree : undefined}
    onDelete={onDelete ? deleteTree : undefined}
  />
{/snippet}

{#snippet chrome()}
  <ReviewBar
    {shareOpen}
    isOwner={true}
    onShareClick={onShare}
  />
{/snippet}

{#snippet mainContent()}
  <div class="relative shrink-0">
    <!-- Pre-share the breadcrumb's quiet icon is the only Share entry point.
         Once a room is active (or the sheet is up) the ReviewBar's ShareChip
         owns share status + management, so the icon hides — same gate as the
         native App.svelte header. -->
    <PathBreadcrumb
      path={activePath}
      {rootPath}
      {actions}
      onShare={reviewStore.currentRoomId === null && !shareOpen ? onShare : undefined}
      shareEnabled={true}
      rightInsetPx={reviewStore.currentRoomId !== null && reviewStore.railMode !== 'expanded'
        ? 328 - RAIL_WIDTH_PX[reviewStore.railMode]
        : 16}
    />
  </div>
  <ScrollArea
    class="attn-content-viewport hosted-content-viewport min-h-0 flex-1"
    orientation="vertical"
    bind:viewportRef={viewport}
  >
    {@render content()}
  </ScrollArea>
{/snippet}

<WorkspaceEditorFrame
  class="hosted-workspace-frame"
  {sidebar}
  {chrome}
  content={mainContent}
  {rail}
  railMode={reviewStore.railMode}
  panelOpen={reviewStore.panelOpen}
  unreadCount={reviewStore.currentRoomUnread}
  onToggleRail={() => reviewStore.togglePanel()}
  onRailWheel={(deltaY) => {
    if (viewport) viewport.scrollTop += deltaY;
  }}
/>
