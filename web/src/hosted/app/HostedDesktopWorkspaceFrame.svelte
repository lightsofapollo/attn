<script lang="ts">
  import type { Snippet } from 'svelte';
  import PathBreadcrumb from '../../lib/PathBreadcrumb.svelte';
  import ReviewBar from '../../lib/ReviewBar.svelte';
  import Sidebar from '../../lib/Sidebar.svelte';
  import WorkspaceEditorFrame from '../../lib/WorkspaceEditorFrame.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { reviewStore } from '../../lib/review/store.svelte';
  import { RAIL_WIDTH_PX } from '../../lib/review/rail-mode';
  import type { WorkspaceEntry, WorkspaceSummary } from './types';
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
    workspaces: WorkspaceSummary[];
    entries: WorkspaceEntry[];
    activeEntryPath?: string;
    shareOpen: boolean;
    actions: Snippet;
    footer: Snippet;
    content: Snippet;
    rail: Snippet;
    onNavigate: (path: string) => void;
    onWorkspaceSwitch: (workspaceId: string, openPath: string) => void;
    onCreateWorkspace: () => void;
    onRenameWorkspace: () => void;
    onOpenWorkspaceHome: () => void;
    onRenameEntry: (path: string) => void;
    onDownloadEntry: (path: string) => void;
    onDeleteEntry: (path: string) => void;
    onShare: (trigger?: HTMLButtonElement) => void;
    onViewport?: (viewport: HTMLElement | null) => void;
  }

  let {
    workspaceId,
    workspaceName,
    workspaces,
    entries,
    activeEntryPath,
    shareOpen,
    actions,
    footer,
    content,
    rail,
    onNavigate,
    onWorkspaceSwitch,
    onCreateWorkspace,
    onRenameWorkspace,
    onOpenWorkspaceHome,
    onRenameEntry,
    onDownloadEntry,
    onDeleteEntry,
    onShare,
    onViewport,
  }: Props = $props();

  const rootPath = $derived(workspaceVirtualRoot(workspaceId));
  const activePath = $derived(
    activeEntryPath ? workspaceTreePath(workspaceId, activeEntryPath) : rootPath,
  );
  const tree = $derived(workspaceEntriesToTree(workspaceId, entries));
  const projectPaths = $derived(workspaces.map((item) => workspaceVirtualRoot(item.id)));
  const projectLabels = $derived(
    Object.fromEntries(workspaces.map((item) => [workspaceVirtualRoot(item.id), item.name])),
  );
  let viewport = $state<HTMLElement | null>(null);

  $effect(() => {
    onViewport?.(viewport);
    return () => onViewport?.(null);
  });

  function navigateTree(treePath: string): void {
    const relativePath = workspaceRelativePath(workspaceId, treePath);
    if (relativePath) onNavigate(relativePath);
  }

  function switchWorkspace(projectPath: string): void {
    const target = workspaces.find((item) => workspaceVirtualRoot(item.id) === projectPath);
    if (target) onWorkspaceSwitch(target.id, target.openPath);
  }

  function relativeEntryPath(treePath: string): string | null {
    return workspaceRelativePath(workspaceId, treePath);
  }
</script>

{#snippet sidebar()}
  <Sidebar
    entries={tree}
    {activePath}
    {rootPath}
    knownProjects={projectPaths}
    {projectLabels}
    activeProjectPath={rootPath}
    rootLabel={workspaceName}
    showOutline={false}
    showWindowDragRegion={false}
    {footer}
    onNavigate={navigateTree}
    onProjectSwitch={switchWorkspace}
    onCreateProject={onCreateWorkspace}
    onRenameProject={onRenameWorkspace}
    onOpenProjectHome={onOpenWorkspaceHome}
    onRenameEntry={(treePath) => {
      const relativePath = relativeEntryPath(treePath);
      if (relativePath) onRenameEntry(relativePath);
    }}
    onDownloadEntry={(treePath) => {
      const relativePath = relativeEntryPath(treePath);
      if (relativePath) onDownloadEntry(relativePath);
    }}
    onDeleteEntry={(treePath) => {
      const relativePath = relativeEntryPath(treePath);
      if (relativePath) onDeleteEntry(relativePath);
    }}
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
    <PathBreadcrumb
      path={activePath}
      {rootPath}
      {actions}
      onShare={onShare}
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
