<script lang="ts">
  import type { Snippet } from 'svelte';
  import Share2 from '@lucide/svelte/icons/share-2';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import BrandMark from '../../lib/BrandMark.svelte';
  import ReviewBar from '../../lib/ReviewBar.svelte';
  import Sidebar from '../../lib/Sidebar.svelte';
  import ProjectPicker from '../../lib/ProjectPicker.svelte';
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
  import { createHostedFileIconResolver } from './hosted-icon-registry';
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
    /** Keep durable comments visible even once the live room disconnects. */
    reviewHistoryAvailable?: boolean;
    /**
     * False while nothing has been selected (user ruling, 2026-08-20): a
     * workspace holding one blank untitled.md mounts no file rail at all. The
     * picker moved to the header precisely so this can be dropped whole — the
     * rail's remaining jobs are navigating files and adding them, and neither
     * applies until there is a file that is not the one already open.
     */
    showSidebar?: boolean;
    /**
     * False while the canvas is still asking which document to open (user
     * ruling, 2026-08-20).
     *
     * Minting a workspace creates a placeholder `untitled.md` and routes to it,
     * so the path is non-empty from the first frame — long before anyone has
     * chosen anything. The header was printing that placeholder's name beside a
     * canvas whose whole content was "Open a document", which named a file the
     * person had not picked. Same condition that drops the file rail.
     */
    fileChosen?: boolean;
    /** True while a workspace rename is in flight; swaps the name for `rename`. */
    renaming?: boolean;
    /**
     * The workspace-relative path of the file being renamed, and the field that
     * takes its row's label. Converted to a tree path here, which is the only
     * layer that knows both address spaces.
     */
    renamingEntryPath?: string;
    entryRename?: Snippet;
    /** The rename input, rendered in the name's own slot (attn-rjuo.2.1). */
    rename?: Snippet;
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
    reviewHistoryAvailable = false,
    showSidebar = true,
    fileChosen = true,
    renaming = false,
    rename,
    renamingEntryPath,
    entryRename,
  }: Props = $props();

  // This is intentionally created at the hosted-desktop boundary. Sidebar and
  // FileTree receive the narrow resolver contract, never the native registry.
  const hostedFileIconResolver = createHostedFileIconResolver();
  // Comments are durable content, not evidence of an active connection.
  // Keep them discoverable in the document header, but do not reserve a gutter
  // until the person explicitly opens the column.
  let savedHistoryOpen = $state(false);
  const railVisible = $derived(reviewStore.railMode !== 'hidden' || savedHistoryOpen);
  const effectiveRailMode = $derived(
    savedHistoryOpen ? 'expanded' : reviewStore.railMode,
  );
  // Reading wins over visual stability in the hosted owner workspace. A
  // durable review is a deliberate secondary task; when it opens, reserve a
  // real column for it rather than painting cards over the document. That
  // means a line may reflow when the user explicitly opens Comments,
  // but the document's visible reading column is never covered by feedback.
  const dockedRailWidth = $derived(RAIL_WIDTH_PX[effectiveRailMode]);

  // The header's last segment: the file's own name, not its path. The path
  // lives in the title so a nested file can still be placed on hover, and the
  // rail is where the shape of the workspace is read.
  const activeFileName = $derived(
    fileChosen && activeEntryPath
      ? activeEntryPath.split('/').filter(Boolean).at(-1)
      : undefined,
  );

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

  /* `workspaceName` wins for the open project: it tracks a live rename, while
     `switcherLabels` is a snapshot of the whole desk taken when the summaries
     last loaded. Same precedence Sidebar's own `formatRootLabel` uses. */
  function projectLabel(path: string): string {
    if (path === rootPath) return workspaceName;
    return switcherLabels[path] ?? 'Workspace';
  }

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
    {sharedProjects}
    showOutline={false}
    showProjectPicker={false}
    showWindowDragRegion={false}
    {onOpenDesk}
    {sharedPaths}
    {unreadByPath}
    iconResolver={hostedFileIconResolver}
    {footer}
    renamingPath={renamingEntryPath ? workspaceTreePath(workspaceId, renamingEntryPath) : undefined}
    renameField={entryRename}
    onNavigate={navigateTree}
    onRename={onRename ? renameTree : undefined}
    onDelete={onDelete ? deleteTree : undefined}
  />
{/snippet}

{#snippet mainContent()}
  <!-- One header bar, matching the reviewer page's grammar (user ruling:
       'make owner match the review'): brand · divider · workspace · file on
       the left, save state + share/review chips inline on the right. This
       replaces the breadcrumb row and the floating ReviewBar dock. -->
  <!-- Chrome plane, matching App.svelte's native-header and the right rail:
       `--header-surface` behind a `--panel-border` hairline, so the document
       reads as a lit sheet between recessed chrome. See the longer note on
       `data-slot="native-header"` in App.svelte. -->
  <header
    class="relative z-40 flex h-11 shrink-0 items-center gap-2 border-b border-[var(--panel-border)] bg-[var(--header-surface)] px-[var(--chrome-inline-gutter)]"
    data-slot="owner-header"
  >
    <!-- The mark is the way home (user ruling, 2026-08-20). It carried product
         identity and nothing else, which in a browser tab is a dead corner:
         every other site puts its home under the logo, so people click ours and
         nothing happens. It leaves the app for the marketing home; the desk —
         the app's own home — has its own named routes (the rail's "Back to
         desk" and the picker's "All workspaces"), because those two
         destinations are different places and must not share one target. -->
    <a class="owner-brand" href="/" data-slot="owner-brand" aria-label="attn — home">
      <BrandMark size={18} />
      <span class="select-none font-serif text-sm font-bold leading-none text-foreground">attn</span>
    </a>
    <span class="h-3 w-px shrink-0 bg-border" aria-hidden="true"></span>
    <!-- The workspace switcher lives here, not in the rail (user ruling,
         2026-08-20). It is app-level navigation — which project is open, and
         every one you could open instead — so it belongs in the bar that is
         present in every state, rather than inside a file rail that is not.

         Mark · WORKSPACE · file (user ruling, 2026-08-20). The switcher briefly
         wore the open FILE's name, on the theory that a workspace and its first
         document are routinely called the same thing and one label would do.
         They diverge the moment either is renamed or a second file is added,
         and the trigger then advertised a list of workspaces under a file's
         name. The two names are now two segments: the workspace opens the
         switcher (it is what the menu lists), the file is where you are and
         says so quietly. -->
    <div class="flex min-w-0 shrink items-center gap-2" data-slot="owner-doc-name">
      {#if renaming && rename}
        <!-- In place: the input takes the trigger's slot rather than appearing
             somewhere else in the bar (attn-rjuo.2.1). -->
        {@render rename()}
      {:else}
      <ProjectPicker
        projects={switcherProjects}
        selected={rootPath}
        labelFor={projectLabel}
        {sharedProjects}
        actions={projectMenuActions}
        onSwitch={switchProject}
        variant="header"
      />
      {/if}
      {#if activeFileName}
        <!-- The same hairline that follows the mark (user ruling, 2026-08-20),
             not a breadcrumb chevron. Three names across one bar, divided the
             same way twice: the bar reads as one line of chrome rather than a
             wordmark, then a path, in two different grammars. -->
        <span class="h-3 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <span class="owner-file-name" data-slot="owner-file-name" title={activeEntryPath}>
          {activeFileName}
        </span>
      {/if}
    </div>
    <div class="ml-auto flex h-full min-w-0 shrink-0 items-center gap-1.5">
      {@render actions()}
      <!-- "Comments", not "Saved review" (user ruling, 2026-08-19). The rail
           holds comments; "saved review" named the storage state rather than
           the thing, and no other surface in the product calls them that —
           ReviewBar's own toggle has said "Show/Hide comments" all along.

           Gated on there being NO active room, because ReviewBar renders its
           rail toggle exactly when there is one (`hasActiveRoom` there is this
           same `currentRoomId`). Without the gate, sharing a document with the
           rail hidden put two identical panel-right buttons in one header,
           both labelled "Show comments", opening two different things. -->
      {#if reviewHistoryAvailable && reviewStore.railMode === 'hidden' && reviewStore.currentRoomId === null}
        <button
          type="button"
          class="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-[0.72rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-slot="comments-toggle"
          aria-expanded={savedHistoryOpen}
          aria-controls="comments-margin"
          onclick={() => (savedHistoryOpen = !savedHistoryOpen)}
        >
          {#if savedHistoryOpen}
            <PanelRightClose class="size-3.5" aria-hidden="true" />
            <span>Hide comments</span>
          {:else}
            <PanelRightOpen class="size-3.5" aria-hidden="true" />
            <span>Comments</span>
          {/if}
        </button>
      {/if}
      {#if reviewStore.currentRoomId === null && !shareOpen && onShare}
        <!-- Keep local status + Share together, matching the mobile masthead.
             Once a room is active the ReviewBar's ShareChip owns the slot. -->
        <button
          type="button"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
        compactShare={true}
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
    <!-- `hosted-canvas-row` is the containing block the empty-canvas invitation
         centres in: the full visible canvas, not the capped document column.
         `--canvas-invite-end` hands it the docked rail's width so it centres on
         what is on screen rather than sliding under an open comments column. -->
    <div
      class="hosted-canvas-row flex min-h-full flex-row"
      style={`--canvas-invite-end: ${railVisible ? dockedRailWidth : 0}px;`}
    >
      <!-- Fixed left gutter: the document anchors here in EVERY state —
           sharing or not, rail or not — so its left edge never moves and
           always has room to breathe (user ruling: not flush-left, not
           centered; a stable anchored margin). Comments hug the document's
           right edge. -->
      <div aria-hidden="true" style="flex: 0 0 clamp(0.75rem, 3vw, 3.5rem);"></div>
      <!-- `min-width: 0` is essential when the user opens a 320px dock at a
           compact desktop width. The prose measure may reduce, but it cannot
           keep its old 44rem minimum and push the review column behind the
           app frame's overflow clip. -->
      <div class="min-w-0 flex-1" style="max-width: calc(var(--content-measure) + 4.5rem);">
        {@render content()}
      </div>
      {#if railVisible}
        <!-- A closed live room and closed comments mount no rail at all. Opening either
             deliberately adds this in-flow column, and its header retains an
             explicit close action in the user's eye-line. -->
        <aside
          class="right-rail sticky top-0 flex flex-col self-start"
          style={`flex: 0 0 ${dockedRailWidth}px; height: ${railViewportHeight > 0 ? `${railViewportHeight}px` : '100dvh'};`}
          data-state={reviewStore.panelOpen ? 'open' : 'closed'}
          data-mode={effectiveRailMode}
          data-layout="docked"
          data-slot="right-rail"
          aria-label="Review margin"
        >
          <!-- The header bar is in flow above this scroller now, so the
               card layer needs only breathing room, not bar clearance. -->
          <div class="h-2 shrink-0" aria-hidden="true"></div>
          <div
            class="review-rail-panel mb-2 flex-1"
            style="--review-overlay-top: 0.5rem; --review-overlay-bottom: 0.5rem;"
            data-expanded={effectiveRailMode === 'expanded'}
            data-layout="docked"
            id="comments-margin"
          >
            {#if railVisible}
              {@render rail()}
            {/if}
          </div>
        </aside>
      {/if}
    </div>
  </ScrollArea>
{/snippet}

{#snippet emptyRail()}{/snippet}

<WorkspaceEditorFrame
  class="hosted-workspace-frame"
  sidebar={showSidebar ? sidebar : undefined}
  content={mainContent}
  rail={emptyRail}
  railMode="hidden"
  panelOpen={reviewStore.panelOpen}
  railToggleInHeader={true}
/>

<style>
  /* This hosted frame owns its rail outside WorkspaceEditorFrame's scoped
     styles, so restate the panel plane here. Apart from marking the dock as a
     distinct reading surface, this keeps the saved-history text on a known,
     high-contrast backdrop in both themes. */
  .right-rail[data-layout='docked'] {
    --rail-backdrop: var(--panel-surface);
    color: var(--foreground);
    background: var(--rail-backdrop);
    border-left: 1px solid var(--panel-border);
  }
</style>
