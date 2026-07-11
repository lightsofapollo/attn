<script lang="ts">
  import type { Snippet } from 'svelte';
  import PathBreadcrumb from '../../lib/PathBreadcrumb.svelte';
  import ReviewBar from '../../lib/ReviewBar.svelte';
  import Sidebar from '../../lib/Sidebar.svelte';
  import WorkspaceEditorFrame from '../../lib/WorkspaceEditorFrame.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { reviewStore } from '../../lib/review/store.svelte';
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
    activeEntryPath?: string;
    shareOpen: boolean;
    actions: Snippet;
    footer: Snippet;
    content: Snippet;
    rail: Snippet;
    onNavigate: (path: string) => void;
    onShare: (trigger?: HTMLButtonElement) => void;
    onViewport?: (viewport: HTMLElement | null) => void;
  }

  let {
    workspaceId,
    workspaceName,
    entries,
    activeEntryPath,
    shareOpen,
    actions,
    footer,
    content,
    rail,
    onNavigate,
    onShare,
    onViewport,
  }: Props = $props();

  const rootPath = $derived(workspaceVirtualRoot(workspaceId));
  const activePath = $derived(
    activeEntryPath ? workspaceTreePath(workspaceId, activeEntryPath) : rootPath,
  );
  const tree = $derived(workspaceEntriesToTree(workspaceId, entries));
  let viewport = $state<HTMLElement | null>(null);

  $effect(() => {
    onViewport?.(viewport);
    return () => onViewport?.(null);
  });

  function navigateTree(treePath: string): void {
    const relativePath = workspaceRelativePath(workspaceId, treePath);
    if (relativePath) onNavigate(relativePath);
  }
</script>

{#snippet sidebar()}
  <Sidebar
    entries={tree}
    {activePath}
    {rootPath}
    knownProjects={[rootPath]}
    activeProjectPath={rootPath}
    rootLabel={workspaceName}
    showOutline={false}
    showWindowDragRegion={false}
    {footer}
    onNavigate={navigateTree}
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
