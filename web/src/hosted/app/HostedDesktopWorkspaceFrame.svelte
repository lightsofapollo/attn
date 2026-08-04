<script lang="ts">
  import type { Snippet } from 'svelte';
  import Share2 from '@lucide/svelte/icons/share-2';
  import ReviewBar from '../../lib/ReviewBar.svelte';
  import Sidebar from '../../lib/Sidebar.svelte';
  import WorkspaceEditorFrame from '../../lib/WorkspaceEditorFrame.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { reviewStore } from '../../lib/review/store.svelte';
  import { ownerUnreadByPath } from '../../lib/review/room-ui';
  import { isThreadActive } from '../../lib/review/thread-visibility';
  import { RAIL_WIDTH_PX } from '../../lib/review/rail-mode';
  import type { WorkspaceEntry } from './types';
  import type { ReviewStatusPeer } from '../../lib/types';
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
    /** Jump the owner to a peer's file + caret (attn-qs03); threaded to ReviewBar. */
    onJumpTo?: (peer: ReviewStatusPeer) => void;
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
    onJumpTo,
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
    const counts: Record<string, number> = {};
    // Native path: the daemon feeds per-room unread counts.
    const raw = ownerUnreadByPath({
      rooms: reviewStore.roomsList,
      snapshots: reviewStore.snapshots,
      unreadByRoom: reviewStore.unreadByRoom,
    });
    for (const [path, count] of Object.entries(raw)) {
      const wp = toWorkspacePath(path);
      counts[wp] = (counts[wp] ?? 0) + count;
    }
    // Hosted path: nothing feeds unreadByRoom, so derive a persistent
    // per-file open-thread count from the store itself. Without this, a
    // comment on a non-active file of a multi-file share left NO durable
    // trace in the sidebar once the arrival toast expired.
    const roomId = reviewStore.currentRoomId;
    if (roomId !== null && reviewStore.rooms[roomId]?.role === 'owner') {
      const pathByFileId = new Map<string, string>();
      for (const snapshot of reviewStore.snapshots) {
        if (snapshot.roomId === roomId && snapshot.ownerDisplayPath) {
          pathByFileId.set(snapshot.fileId, snapshot.ownerDisplayPath);
        }
      }
      for (const thread of reviewStore.threads) {
        if (thread.rootEvent.meta.roomId !== roomId) continue;
        if (!isThreadActive(thread, reviewStore.locallyDismissed)) continue;
        const path = thread.anchor ? pathByFileId.get(thread.anchor.fileId) : undefined;
        if (!path) continue;
        const wp = toWorkspacePath(path);
        counts[wp] = (counts[wp] ?? 0) + 1;
      }
    }
    return counts;
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

{#snippet mainContent()}
  <!-- One header bar, matching the reviewer page's grammar (user ruling:
       'make owner match the review'): brand · divider · document name on
       the left, save state + share/review chips inline on the right. This
       replaces the breadcrumb row and the floating ReviewBar dock. -->
  <header
    class="relative z-40 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3"
    data-slot="owner-header"
  >
    <span
      class="select-none font-serif text-sm font-bold leading-none text-foreground"
      data-slot="owner-brand"
      aria-label="attn"
    >attn</span>
    <span class="h-3 w-px shrink-0 bg-border" aria-hidden="true"></span>
    <span
      class="min-w-0 truncate font-sans text-[13px] font-medium text-foreground"
      data-slot="owner-doc-name"
    >{activeEntryPath ? activeEntryPath.split('/').at(-1) : workspaceName}</span>
    <div class="ml-auto flex h-full min-w-0 shrink-0 items-center gap-1.5">
      {@render actions()}
      {#if reviewStore.currentRoomId === null && !shareOpen && onShare}
        <!-- Keep local status + Share together, matching the mobile masthead.
             Once a room is active the ReviewBar's ShareChip owns the slot. -->
        <button
          type="button"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-slot="owner-header-share"
          aria-label="Share for review"
          title="Share for review"
          onclick={(event) => onShare(event.currentTarget)}
        >
          <Share2 class="size-3.5" aria-hidden="true" />
        </button>
      {/if}
      <ReviewBar
        {shareOpen}
        isOwner={true}
        onShareClick={onShare}
        {onJumpTo}
        railToggle={true}
        inline={true}
      />
    </div>
  </header>
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
    <div class="flex min-h-full flex-row">
      <!-- Fixed left gutter: the document anchors here in EVERY state —
           sharing or not, rail or not — so its left edge never moves and
           always has room to breathe (user ruling: not flush-left, not
           centered; a stable anchored margin). Comments hug the document's
           right edge. -->
      <div aria-hidden="true" style="flex: 0 0 clamp(0.75rem, 3vw, 3.5rem);"></div>
      <div class="flex-1" style="max-width: calc(var(--content-measure) + 4.5rem); min-width: min(100%, 44rem);">
        {@render content()}
      </div>
      {#if reviewStore.railMode !== 'hidden'}
        <!-- The aside reserves ONLY the 48px marker gutter, permanently.
             Review mode never widens it in flow: the card column renders as
             an elevated overlay panel anchored to this aside's right edge
             (.review-rail-panel in styles/base.css), sliding over the paper.
             Document geometry is a pure function of the viewport — toggling
             the rail never re-wraps a line of text
             (planning/collab/review-band-stability.md, option A). -->
        <aside
          class="right-rail sticky top-0 flex flex-col self-start"
          style={`flex: 0 0 ${RAIL_WIDTH_PX.collapsed}px; height: ${railViewportHeight > 0 ? `${railViewportHeight}px` : '100dvh'};`}
          data-state={reviewStore.panelOpen ? 'open' : 'closed'}
          data-mode={reviewStore.railMode}
          data-slot="right-rail"
          aria-label="Review margin"
        >
          <!-- The header bar is in flow above this scroller now, so the
               card layer needs only breathing room, not bar clearance. -->
          <div class="h-2 shrink-0" aria-hidden="true"></div>
          <div
            class="review-rail-panel mb-2 flex-1"
            style="--review-overlay-top: 0.5rem; --review-overlay-bottom: 0.5rem;"
            data-expanded={reviewStore.railMode === 'expanded'}
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
  content={mainContent}
  rail={emptyRail}
  railMode="hidden"
  panelOpen={reviewStore.panelOpen}
/>
