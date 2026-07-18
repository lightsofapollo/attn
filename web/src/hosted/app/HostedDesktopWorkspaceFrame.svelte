<script lang="ts">
  import type { Snippet } from 'svelte';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import PathBreadcrumb from '../../lib/PathBreadcrumb.svelte';
  import UnreadBadge from '../../lib/UnreadBadge.svelte';
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
    /** All workspaces on this desk — the sidebar project row switches between
     *  them; `sharing` marks the ones with an active review link. */
    workspaces?: { id: string; name: string; sharing?: 'local-only' | 'shared' | 'backed-up' }[];
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
  // Shared vs local-only in the picker (attn-vt4). Storage summaries carry
  // the durable sharing state; the live store covers the workspace whose
  // share was created THIS session before the summaries refresh.
  const sharedProjects = $derived.by(() => {
    const shared = new Set<string>();
    for (const workspace of workspaces) {
      if (workspace.sharing === 'shared') shared.add(workspaceVirtualRoot(workspace.id));
    }
    const roomId = reviewStore.currentRoomId;
    if (roomId !== null && reviewStore.rooms[roomId]?.role === 'owner') shared.add(rootPath);
    return shared;
  });

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
  // The sticky margin column must be exactly one viewport tall so the
  // bottom-fit pass inside ReviewMargin sees the real visible height.
  let railViewportHeight = $state(0);
  $effect(() => {
    const el = viewport;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      railViewportHeight = el.clientHeight;
    });
    observer.observe(el);
    railViewportHeight = el.clientHeight;
    return () => observer.disconnect();
  });

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
    {sharedProjects}
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
      rightInsetPx={reviewStore.currentRoomId !== null || shareOpen ? 328 : 16}
    />
  </div>
  <ScrollArea
    class="attn-content-viewport hosted-content-viewport min-h-0 flex-1"
    orientation="vertical"
    bind:viewportRef={viewport}
  >
    <!-- ONE scroll context encloses the document AND the review margin
         (Docs structure, matching the reviewer page): the overlay scrollbar
         lands at the far right of the pane — right of the comments — and
         wheel anywhere drives the same scroller. The margin is sticky and
         exactly one viewport tall; its top spacer clears the floating
         ReviewBar, and its header carries the collapse toggle that used to
         live on the outer frame aside. -->
    <div class="flex min-h-full flex-row justify-center">
      <!-- Document column caps at the content measure so [document + margin]
           center together — comments adjacent to the text, not the window
           edge (Docs adjacency; the native frame's hug-rail equivalent). -->
      <div class="min-w-0 flex-1" style="max-width: calc(var(--content-measure) + 4.5rem);">
        {@render content()}
      </div>
      {#if reviewStore.railMode !== 'hidden'}
        <!-- The aside reserves the FULL margin width for the whole life of
             the review context: toggling collapsed↔expanded only changes
             what renders inside, so the document column never reflows or
             recenters (Docs rule — the page doesn't move when comments
             open). The inner column narrows to the gutter width when
             collapsed; the spare width is plain paper. -->
        <aside
          class="right-rail sticky top-0 flex shrink-0 flex-col self-start overflow-hidden"
          style={`width: ${RAIL_WIDTH_PX.expanded}px; height: ${railViewportHeight > 0 ? `${railViewportHeight}px` : '100dvh'};`}
          data-state={reviewStore.panelOpen ? 'open' : 'closed'}
          data-mode={reviewStore.railMode}
          data-slot="right-rail"
          aria-label="Review margin"
        >
          <div
            class={`flex h-10 shrink-0 items-center pt-2 ${reviewStore.panelOpen ? 'justify-end pr-2' : 'justify-center'}`}
            style={`width: ${RAIL_WIDTH_PX[reviewStore.railMode]}px;`}
            data-slot="rail-header"
          >
            <button
              type="button"
              class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              data-slot="rail-toggle"
              data-state={reviewStore.panelOpen ? 'expanded' : 'collapsed'}
              aria-label={reviewStore.panelOpen ? 'Collapse comments rail' : 'Expand comments rail'}
              title={`${reviewStore.panelOpen ? 'Collapse' : 'Expand'} comments (⌘J)`}
              aria-expanded={reviewStore.panelOpen}
              onclick={() => reviewStore.togglePanel()}
            >
              {#if reviewStore.panelOpen}
                <PanelRightClose class="size-4" aria-hidden="true" />
              {:else}
                <PanelRightOpen class="size-4" aria-hidden="true" />
              {/if}
              <UnreadBadge
                count={reviewStore.currentRoomUnread}
                label="unread review updates"
                class="absolute -right-1.5 -top-1.5"
              />
            </button>
          </div>
          <div
            class="relative mb-2 min-h-0 flex-1 overflow-hidden"
            style={`width: ${RAIL_WIDTH_PX[reviewStore.railMode]}px;`}
          >
            {@render rail()}
          </div>
        </aside>
      {/if}
    </div>
  </ScrollArea>
{/snippet}

{#snippet emptyRail()}{/snippet}

<WorkspaceEditorFrame
  class="hosted-workspace-frame"
  {sidebar}
  {chrome}
  content={mainContent}
  rail={emptyRail}
  railMode="hidden"
  panelOpen={reviewStore.panelOpen}
/>
