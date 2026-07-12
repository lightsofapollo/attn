<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type {
    AppMode,
    ContentPayload,
    DiagMode,
    FileType,
    TreeOp,
    TreePatch,
    TreeNode,
    InitPayload,
    PlanStructure,
    ReviewAnchorResolutionUpdate,
    ReviewErrorStatus,
    ReviewEvent,
    ReviewSnapshot,
    ReviewStatus,
    ReviewUnreadChanged,
    ReviewNotificationMuteChanged,
    SearchResultItem,
    UpdatePayload,
  } from './lib/types';
  import { initKeyboard } from './lib/keyboard';
  import { checkForUpdate, upgradeHint } from './lib/update-check';
  import { netRemovedPaths } from './lib/tree-ops';
  import {
    dragWindow,
    editSave,
    loadChildren,
    navigate,
    openExternal,
    reviewAcceptSuggestion,
    reviewCollabSend,
    reviewViewState,
    reviewStop,
    searchFiles,
    setIpcToken,
    switchProject,
  } from './lib/ipc';
  import { CollabController } from './lib/prosemirror/collab-controller';
  import type { EditorBridge } from './lib/prosemirror/collab-session';
  import { remoteCursorsKey } from './lib/prosemirror/remote-cursors';
  import { markdownParser } from './lib/schema';
  import type { Node as PmNode } from 'prosemirror-model';
  import { getVersion } from 'prosemirror-collab';
  import type { FileId } from './lib/types';
  import {
    decreaseFontScale as decreaseGlobalFontScale,
    increaseFontScale as increaseGlobalFontScale,
    initFontScale,
    resetFontScale as resetGlobalFontScale,
  } from './lib/font-scale';
  import { cycleTheme, initTheme } from './lib/theme';
  import type { PaletteCommand } from './lib/CommandPalette.svelte';
  import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
  import PenLineIcon from '@lucide/svelte/icons/pen-line';
  import Share2Icon from '@lucide/svelte/icons/share-2';
  import PanelRightIcon from '@lucide/svelte/icons/panel-right';
  import SunMoonIcon from '@lucide/svelte/icons/sun-moon';
  import KeyboardIcon from '@lucide/svelte/icons/keyboard';
  import { createTab, findTabByPath, type Tab } from './lib/tabs';
  import Editor from './lib/Editor.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import TabBar from './lib/TabBar.svelte';
  import ImageViewer from './lib/ImageViewer.svelte';
  import MediaPlayer from './lib/MediaPlayer.svelte';
  import HtmlViewer from './lib/HtmlViewer.svelte';
  import DirectoryOverview from './lib/DirectoryOverview.svelte';
  import CommandPalette from './lib/CommandPalette.svelte';
  import KeyboardShortcutsDialog from './lib/KeyboardShortcutsDialog.svelte';
  import ReviewApplyExpand from './lib/ReviewApplyExpand.svelte';
  import ReviewBar from './lib/ReviewBar.svelte';
  import ShareDialog from './lib/ShareDialog.svelte';
  import NamePrompt from './lib/NamePrompt.svelte';
  import { userProfile } from './lib/review/profile.svelte';
  import Users from '@lucide/svelte/icons/users';
  import CommentComposer from './lib/CommentComposer.svelte';
  import SuggestionComposer from './lib/SuggestionComposer.svelte';
  import SelectionToolbar from './lib/SelectionToolbar.svelte';
  import SuggestionPopover from './lib/SuggestionPopover.svelte';
  import { findSuggestionById, type SuggestionInfo } from './lib/review/suggestions';
  import {
    applySuggestion,
    revertSuggestion,
  } from '@handlewithcare/prosemirror-suggest-changes';
  import { hasTextSelection } from './lib/review/popover-anchor';
  import type { ConstructAnchorContext } from './lib/review/anchors';
  import { toast } from 'svelte-sonner';
  import { Toaster } from '$lib/components/ui/sonner';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import PathBreadcrumb from './lib/PathBreadcrumb.svelte';
  import {
    detectFileType,
    extractStructureFromMarkdown,
    loadMarkdownFromPath,
    markdownSourceUrl,
  } from './lib/markdown-layer';
  import { RAIL_WIDTH_PX } from './lib/review/rail-mode';
  import { reviewStore } from './lib/review/store.svelte';
  import { consumePendingRoomFocus } from './lib/review/pending-room-focus';
  import ReviewMargin from './lib/ReviewMargin.svelte';
  import ReviewFileNav from './lib/ReviewFileNav.svelte';
  import ReviewFileTree from './lib/ReviewFileTree.svelte';
  import {
    shouldAutoSelectOnlyRoom,
    isReviewerView,
    collabRoleFor,
    collabSeedReady,
    shareTargetMatches,
  } from './lib/review/room-ui';
  import {
    requestReviewDecorationsRebuild,
    reviewDecorationsPlugin,
  } from './lib/prosemirror/review-decorations';
  import { resolveAnchor } from './lib/review/resolver';
  import type { EditorView } from 'prosemirror-view';
  import type { Plugin as PMPlugin } from 'prosemirror-state';
  import { TextSelection } from 'prosemirror-state';
  import ResidentSettings from './lib/ResidentSettings.svelte';
  import WorkspaceEditorFrame from './lib/WorkspaceEditorFrame.svelte';

  interface Props {
    /**
     * Optional snippet rendered into the right-rail slot. When omitted the
     * rail mounts a neutral placeholder (no review session is active).
     * Phase 2 (attn-nnj.4.3) drops `<ReviewPanel>` in here.
     */
    rightRail?: Snippet;
  }

  let { rightRail }: Props = $props();

  let mode: AppMode = $state('edit');
  let commandPaletteOpen = $state(false);
  let shortcutsOpen = $state(false);
  // Share-for-review dialog (attn-nnj.4.10). Owner-only modal opened via
  // the ReviewBar's [Share] button or the Cmd+Shift+S keybinding.
  let shareDialogOpen = $state(false);
  // The explicit path the ShareDialog targets — a file OR a folder. Set on
  // every open so the dialog shares the row that was clicked, not whatever
  // file happens to be active (folder shares never navigate the owner).
  let shareTargetPath = $state<string | null>(null);
  // Onboarding display-name prompt. Shown once when the user first enters a
  // room (share or join) with no name set; also reachable in 'edit' mode via
  // the connection badge. `namePrompted` is a per-session one-shot guard.
  let namePromptOpen = $state(false);
  let namePromptMode = $state<'onboard' | 'edit'>('onboard');
  let namePrompted = $state(false);
  // When the onboarding prompt was opened by a share action, the share to
  // resume once the user confirms/skips the name.
  let pendingSharePath = $state<string | null>(null);
  let pendingShareIsDir = $state(false);
  let rawMarkdown = $state('');
  let structure: PlanStructure = $state({ phases: [], tasks: [], file_refs: [] });
  let fileTree: TreeNode[] = $state([]);
  let rootPath = $state('');
  let knownProjects: string[] = $state([]);
  let activeProjectPath = $state('');
  let diagMode: DiagMode = $state('full');
  let residentSettings = $state({
    active: false,
    installed: false,
    loaded: false,
    degraded: false,
    error: null as string | null,
    supported: false,
  });
  let editorRef: ReturnType<typeof Editor> | undefined = $state(undefined);

  // Tab state
  let tabs: Tab[] = $state([]);
  let activeTabId = $state('');
  const scopedTabsByProject = new Map<string, { tabs: Tab[]; activeTabId: string }>();
  let activeTabScopeKey = $state('__default__');

  // Track if a navigation was initiated from the frontend (sidebar click)
  let pendingFrontendNav = false;
  // Deferred navigation for auto-select when opening a directory
  let pendingAutoNav: string | null = null;
  let contentViewport: HTMLElement | null = $state(null);
  let windowFocused = $state(
    typeof document !== 'undefined' ? document.hasFocus() : false,
  );
  let documentVisible = $state(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : false,
  );

  let activeTab = $derived(tabs.find((t) => t.id === activeTabId));
  let activePath = $derived(activeTab?.path ?? '');
  let hasActiveTab = $derived(Boolean(activeTab));
  let activeFileType = $derived<FileType>(activeTab?.fileType ?? 'unsupported');

  // Role: a reviewer is in a room they did NOT mint (no local `currentShare`).
  // The owner is whoever minted the share. This is the single source of truth
  // for "should this window show the shared document" — gating on role (not on
  // "has no local tab") is what makes a reviewer jump to the shared content on
  // join AND keeps the owner pinned to their local file (so the owner never
  // flips into shared-doc mode after remote edits — see attn-0wa).
  //
  // We gate on a POSITIVE reviewer role (the daemon reports `Joined` → role
  // `reviewer`; the owner gets `Live` → role `owner`), not just "no local
  // share". `currentShare` is only set on a fresh `ShareReady` and is lost on
  // reconnect/rehydrate, so an owner returning to a remembered room would have
  // `currentShare === null` yet `role === 'owner'` — gating on `currentShare`
  // alone flipped them into shared-doc view (attn-0wa). Requiring `role ===
  // 'reviewer'` is a strict tightening: an owner (role `owner`/`unknown`) never
  // flips, a real reviewer (role `reviewer`, no local share) still does.
  let isReviewerInRoom = $derived(
    isReviewerView({
      inRoom: reviewStore.currentRoomId !== null,
      hasLocalShare: reviewStore.currentShare !== null,
      role: reviewStore.activeRoom?.role,
    }),
  );

  // A reviewer always gets the sidebar shell (to host the shared-file tree),
  // even when they opened attn on an empty directory with no local files.
  let hasSidebar = $derived(fileTree.length > 0 || isReviewerInRoom);
  let showBreadcrumbShare = $derived(
    (activeFileType === 'markdown' || activeFileType === 'html') &&
      !shareDialogOpen &&
      reviewStore.currentRoomId === null,
  );
  let showReviewChrome = $derived(
    reviewStore.currentRoomId !== null || reviewStore.roomsList.length > 0 || shareDialogOpen,
  );

  let autoSelectedRoomId = $state<string | null>(null);
  $effect(() => {
    const roomId = shouldAutoSelectOnlyRoom({
      hasActiveTab,
      currentRoomId: reviewStore.currentRoomId,
      rooms: reviewStore.roomsList,
    });
    if (roomId === null || roomId === autoSelectedRoomId) return;
    autoSelectedRoomId = roomId;
    reviewStore.selectRoom(roomId);
  });

  // Native owns the durable read marker. Report both predicates together so
  // selecting a room in a background/occluded window cannot clear it.
  $effect(() => {
    const roomId = reviewStore.currentRoomId;
    if (roomId === null) return;
    // Re-report after an import updates the count while the room remains
    // selected. Otherwise the focus predicates have not changed, so a
    // continuously focused room would retain a badge until blur/refocus.
    reviewStore.currentRoomUnread;
    reviewViewState(roomId, documentVisible, windowFocused);
  });

  // Reviewer rendering: when this daemon joined a room (currentRoomId set)
  // and has received the owner's snapshot for the focused file, render the
  // snapshot markdown. The owner keeps rendering their local file (they
  // have a real tab + rawMarkdown). See store.applyEvent — SnapshotCreated
  // events are mirrored into `reviewStore.snapshots` and auto-set
  // `currentFileId`.
  // The LATEST snapshot for the focused file — owner edits republish a new
  // snapshot per save, so several may exist for one fileId. Newest createdAt
  // wins so the reviewer always sees the freshest content. Covers both
  // markdown and read-only HTML docs.
  let reviewSnapshot = $derived.by(() => {
    const roomId = reviewStore.currentRoomId;
    const fileId = reviewStore.currentFileId;
    if (!roomId || !fileId) return null;
    const candidates = reviewStore.snapshots.filter(
      (s) => s.roomId === roomId && s.fileId === fileId && typeof s.content === 'string',
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  });
  let reviewSnapshotContent = $derived(reviewSnapshot?.content ?? null);
  let reviewSnapshotDocType = $derived(reviewSnapshot?.docType ?? 'markdown');
  // Markdown snapshots seed the prosemirror editor (anchors/collab). HTML
  // snapshots are read-only and render in HtmlViewer — never the editor — so
  // markdown-only consumers (collab seed, anchor remap, effectiveMarkdown) key
  // off this and naturally skip HTML.
  let reviewSnapshotMarkdown = $derived(
    reviewSnapshotDocType === 'markdown' ? reviewSnapshotContent : null,
  );
  // A reviewer who has received the owner's snapshot for the focused file
  // renders the shared doc — regardless of whether they also have a local
  // tab open. Joining a room is an explicit "show me the shared content"
  // action, so the shared doc wins for reviewers.
  let isReviewerViewingSnapshot = $derived(
    isReviewerInRoom && reviewSnapshotMarkdown !== null,
  );
  // Read-only HTML shared doc — rendered in HtmlViewer (sandboxed iframe),
  // never the editor.
  let isReviewerViewingHtmlSnapshot = $derived(
    isReviewerInRoom && reviewSnapshotDocType === 'html' && reviewSnapshotContent !== null,
  );
  // Reviewer is in the room but the owner's snapshot for the focused file
  // hasn't arrived yet — show a "waiting for shared content" state instead
  // of silently leaving them on whatever local file they had open. Applies to
  // any shared doc type.
  let isReviewerWaiting = $derived(
    isReviewerInRoom && reviewSnapshotContent === null,
  );
  // The markdown the editor actually renders: the shared snapshot for a
  // reviewer, otherwise the local file (or a received snapshot when no local
  // tab is open).
  let effectiveMarkdown = $derived(
    isReviewerViewingSnapshot
      ? (reviewSnapshotMarkdown ?? rawMarkdown)
      : hasActiveTab
        ? rawMarkdown
        : (reviewSnapshotMarkdown ?? rawMarkdown),
  );
  let showTabBar = $derived(tabs.length > 1);
  // Owner-side: which local paths are currently shared in a room. Drives the
  // inline "shared" marker in the file tree. Derived from the owner's own
  // published snapshots (each carries the absolute `ownerDisplayPath`), filtered
  // to rooms where we are the owner so a room we merely joined never marks our
  // local files. Folder shares surface as one snapshot per contained file, so a
  // folder reads as shared when any descendant path is in this set.
  let sharedPaths = $derived.by(() => {
    const set = new Set<string>();
    for (const snap of reviewStore.snapshots) {
      const path = snap.ownerDisplayPath;
      if (!path) continue;
      if (reviewStore.rooms[snap.roomId]?.role !== 'owner') continue;
      set.add(path);
    }
    return set;
  });
  // Whether the Share dialog's current target is the file/folder ALREADY shared
  // in the active owned room. When it is, the dialog re-shows that room's
  // invite; when it's a NEW target (e.g. sharing a folder while a single file is
  // shared), the dialog mints a fresh room so the owner "switches over" to it.
  let shareTargetIsCurrent = $derived.by(() => {
    const share = reviewStore.currentShare;
    if (!share?.roomId) return false;
    const target = shareTargetPath ?? activePath ?? '';
    return shareTargetMatches(share.ownerDisplayPath, target);
  });
  // Reset the share target when the dialog closes so a stale path can't feed
  // shareTargetIsCurrent on the next open; openShareDialogForPath always sets it
  // fresh before reopening, so clearing here is safe.
  $effect(() => {
    if (!shareDialogOpen) shareTargetPath = null;
  });
  const loadedMtimeByPath = new Map<string, number>();
  // Reactive map of disk mtimes for HTML files, keyed by path. Bumping an
  // entry cache-busts the HtmlViewer iframe URL so on-disk edits live-reload.
  // Must be a SvelteMap (not a plain Map under $state): $state does not deeply
  // proxy Map, so plain `.set()` would not invalidate the template's `.get()`
  // read and the iframe would never reload.
  const htmlMtimeByPath = new SvelteMap<string, number>();
  const markdownCacheByPath = new Map<string, string>();
  const deferredReloadMtimeByPath = new Map<string, number | null>();
  const deferredReloadNoticeByPath = new Set<string>();
  const loadedDirPaths = new Set<string>();
  let editorDirty = $state(false);
  let pendingLinkAnchor: { path: string; fragment: string } | null = $state(null);
  type OutlineHeading = { id: string; text: string; level: number; line: number };
  let outlineHeadings: OutlineHeading[] = $state([]);
  let activeOutlineId = $state('');
  let sidebarSearchQuery = $state('');
  let sidebarSearchResults: SearchResultItem[] = $state([]);
  let commandPaletteSearchQuery = $state('');
  let commandPaletteSearchResults: SearchResultItem[] = $state([]);

  // Right-rail (Phase 2 ReviewPanel mount point). Default collapsed; no review
  // session is active yet, so the slot renders a neutral placeholder. Toggling
  // shortcut (Cmd+J) is wired here as a placeholder until 12.9 owns it.
  // State lives on `reviewStore.panelOpen` so the future keyboard hook /
  // ReviewPanel can drive it via `reviewStore.togglePanel()`.

  // Review-decoration plugin host (attn-nnj.4.6). One plugin instance per
  // editor mount; the `onReady` callback hands us the EditorView so the
  // store-driven $effect can dispatch rebuild signals without subscribing
  // to runes inside the plugin's `apply` handler.
  const reviewPlugin: PMPlugin = reviewDecorationsPlugin();
  const editorPlugins: PMPlugin[] = [reviewPlugin];
  let pmViewForReview: EditorView | undefined = $state(undefined);

  function handleEditorReady(view: EditorView): void {
    pmViewForReview = view;
    // Automation hook: expose the live editor view so E2E (`--eval`) can
    // dispatch transactions (e.g. drive co-typing in tests).
    (window as unknown as { __attnPmView?: EditorView }).__attnPmView = view;
  }

  // ---------------------------------------------------------------------------
  // Live co-typing (prosemirror-collab over the encrypted signal channel).
  //
  // Role: we're the owner iff we minted the share (currentShare set) OR the
  // daemon reports our role as `owner` for this room (durable across reconnect,
  // where no fresh ShareReady fires — see attn-0wa). Every other participant is
  // a reviewer/client. A session is "active" when we're connected to a room and
  // looking at the shared markdown doc. While active the editor installs the
  // collab plugin (seeded from the frozen v0 markdown) and stops resetting from
  // the markdown prop — collab steps own the doc.
  // ---------------------------------------------------------------------------
  let collabRole = $derived<'owner' | 'reviewer'>(
    collabRoleFor({
      hasLocalShare: reviewStore.currentShare !== null,
      role: reviewStore.activeRoom?.role,
    }),
  );
  let collabActive = $derived(
    reviewStore.currentRoomId !== null &&
      // Active whenever a transport is up — mailbox OR the WebRTC DataChannel
      // (live_direct), or the relay fallback after a failed direct attempt.
      // Only 'offline' means no path for steps.
      reviewStore.connection !== 'offline' &&
      // Owner views their local markdown file; a pure reviewer views the
      // shared snapshot (no local tab → activeFileType is 'unsupported').
      (activeFileType === 'markdown' || isReviewerViewingSnapshot) &&
      reviewStore.snapshots.some((s) => s.fileId === reviewStore.currentFileId),
  );
  // Stable per-session client id (collab requires a unique, stable id per
  // editor) and a frozen v0 seed so the editor's markdown prop can't shift
  // mid-session and trigger a reset.
  let collabClientId = $state<string | null>(null);
  let collabSeedMarkdown = $state<string | null>(null);
  let collabController = $state<CollabController | null>(null);
  // Per-file live collab: the editor shows one file at a time, so switching the
  // active file re-seeds the editor at v0 from THAT file's base snapshot under a
  // fresh clientId. `collabEpoch` forces the editor to fully re-create on each
  // (re)seed (a plugin reconfigure would preserve the old collab doc/version);
  // `collabSeededFileId` tracks which file the current seed is for so the seed
  // effect knows when a switch happened. The bind vars below let the bind
  // effect re-point the persistent controller at the new view+file exactly once.
  let collabEpoch = $state(0);
  let collabSeededFileId = $state<FileId | null>(null);
  let collabBoundView: EditorView | undefined = undefined;
  let collabBoundFileId: FileId | null = null;

  // Activate / tear down as `collabActive` flips. Capturing clientId + seed
  // here (not in render) keeps them stable for the whole session.
  //
  // Teardown is DEFERRED past a grace window: `collabActive` flips false
  // momentarily whenever the owner's auto-save republishes a snapshot (the
  // `snapshots.some(...)` term) or the connection blips. Tearing down
  // immediately nulls collabClientId, which unblocks the editor's markdown
  // reset and re-seeds it from the clean (suggestion-reverted) markdown —
  // dropping every pending suggestion mark, so the owner never sees reviewers'
  // suggestions. We only tear down if collab stays inactive past the window.
  let collabTeardownTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (collabActive) {
      if (collabTeardownTimer !== null) {
        clearTimeout(collabTeardownTimer);
        collabTeardownTimer = null;
      }
      // Seed from the ACTIVE file's BASE (earliest) snapshot — that is the v0
      // every authority + resync replay is anchored to, so the editor lands at
      // a doc the full step log rebases cleanly onto. (The owner of a just-
      // shared file may not have its snapshot echoed back yet; fall back to the
      // editor's current content so the first share never stalls. A reviewer
      // must wait for the snapshot — never seed from their own local file.)
      const fileId = reviewStore.currentFileId;
      const base = collabBaseSnapshotMarkdown(fileId);
      const seed = base ?? (collabRole === 'owner' ? effectiveMarkdown : null);
      const seedReady =
        seed !== null &&
        collabSeedReady({ effectiveMarkdown: seed, isReviewerInRoom, isReviewerViewingSnapshot });
      // (Re)seed on first activation OR whenever the active file changes — a
      // file switch needs a fresh clientId (so the log's own past steps rebase
      // in as remote edits) and an epoch bump (forces a full editor re-create).
      if (seedReady && fileId !== null && (collabClientId === null || collabSeededFileId !== fileId)) {
        collabClientId = crypto.randomUUID();
        collabSeedMarkdown = seed;
        collabSeededFileId = fileId;
        collabEpoch += 1;
      }
    } else if (collabClientId !== null && collabTeardownTimer === null) {
      collabTeardownTimer = setTimeout(() => {
        collabTeardownTimer = null;
        if (!collabActive) {
          collabClientId = null;
          collabSeedMarkdown = null;
          collabController = null;
          collabSeededFileId = null;
          collabBoundView = undefined;
          collabBoundFileId = null;
        }
      }, 4000);
    }
  });

  // Build the collab controller once the session is active and the editor view
  // exists. This is reactive (not driven by the editor's onReady) because the
  // view is now created once on mount and reconfigured in place — onReady fires
  // a single time, possibly before collab activates. The `!collabController`
  // guard makes this idempotent across unrelated re-runs.
  $effect(() => {
    const view = pmViewForReview;
    if (collabActive && collabClientId !== null && view && collabController === null) {
      maybeStartCollab();
    }
  });

  // Bind the (persistent) controller to the active file's editor view. A file
  // switch re-seeds + re-creates the editor (new `pmViewForReview`), so this
  // re-points collab at the fresh view exactly once per view. `setActiveFile`
  // re-attaches the owner's host (replaying its log into the v0 editor) or
  // makes a reviewer wire-client + requests a resync. Gating on view identity
  // is sufficient: every active-file change bumps the epoch → new view.
  $effect(() => {
    const view = pmViewForReview;
    const fileId = reviewStore.currentFileId;
    const controller = collabController;
    if (!collabActive || controller === null || !view || fileId === null) return;
    if (view === collabBoundView) return;
    // Only bind a view that actually has the collab plugin installed. When
    // collab activates (or the active file switches) the editor RE-CREATES with
    // collab at v0, but this effect can fire first on the stale pre-collab view
    // (collabActive flipped, new view not mounted yet). Binding that view would
    // call getVersion() on a state without the collab plugin → throw, which
    // aborts the Svelte flush and freezes all reactivity. Wait for the fresh
    // collab view (its onReady updates pmViewForReview → this effect re-runs).
    if (!viewHasCollab(view)) return;
    const bridge: EditorBridge = {
      getState: () => view.state,
      apply: (tr) => view.dispatch(tr),
    };
    controller.setActiveFile(fileId, bridge);
    collabBoundView = view;
    collabBoundFileId = fileId;
  });

  // Owner: keep the room's active file in sync with the file shown in the
  // editor (the local file at `activePath`). Clicking a shared file in the
  // sidebar switches the live collab doc to it; navigating to a non-shared
  // file clears the scope so collab deactivates and the plain file renders.
  // (Reviewers switch files via ReviewFileNav, which drives currentFileId
  // directly; their editor shows the snapshot, not a local path.)
  $effect(() => {
    if (collabRole !== 'owner' || reviewStore.currentRoomId === null) return;
    const path = activePath;
    const fileId = path ? ownerFileIdForPath(path) : null;
    if (fileId !== reviewStore.currentFileId) {
      reviewStore.setCurrentFile(fileId);
    }
  });

  // Auto-expand the review rail the first time the current file has
  // UNRESOLVED feedback (attn-42y: resolved-only history defaults to the
  // collapsed gutter). Without this the rail stays collapsed and a
  // reviewer's notes are invisible until someone happens to press Cmd+J — so
  // incoming review work silently disappears. One-shot PER ROOM so a
  // deliberate collapse (toggle / Cmd+J) stays collapsed, but a second room
  // joined later in the session still opens by default on its feedback.
  let reviewRailAutoOpenedRoom = $state<string | null>(null);
  $effect(() => {
    const roomId = reviewStore.currentRoomId;
    if (roomId === null) return;
    if (reviewStore.marginActiveThreadCount > 0 && reviewRailAutoOpenedRoom !== roomId) {
      reviewRailAutoOpenedRoom = roomId;
      if (!reviewStore.panelOpen) reviewStore.panelOpen = true;
    }
  });

  // Onboarding: the first time the user enters a room (after sharing or joining)
  // without a chosen display name, prompt them to confirm/set it. One-shot per
  // session. Their name already defaults to the git/OS name, so this is a
  // confirm-or-override step, not a blocker.
  $effect(() => {
    if (
      reviewStore.currentRoomId !== null &&
      !userProfile.isSet &&
      !namePrompted &&
      !namePromptOpen
    ) {
      namePrompted = true;
      namePromptMode = 'onboard';
      namePromptOpen = true;
    }
  });

  // "Edit name" affordance (connection badge) flips a module signal; open the
  // prompt in edit mode and clear the request.
  $effect(() => {
    if (userProfile.editRequested) {
      userProfile.editRequested = false;
      namePromptMode = 'edit';
      namePromptOpen = true;
    }
  });

  function handleNameConfirm(name: string): void {
    userProfile.save(name);
    resumePendingShare();
  }

  // Skip on the onboarding prompt: keep the resolved default and proceed.
  function handleNameSkip(): void {
    resumePendingShare();
  }

  // If the prompt was opened by a share action, continue to the ShareDialog now
  // that a name is set (or skipped). `namePrompted`/`isSet` guard re-entry.
  function resumePendingShare(): void {
    const path = pendingSharePath;
    const isDir = pendingShareIsDir;
    pendingSharePath = null;
    pendingShareIsDir = false;
    if (path) openShareDialogForPath(path, isDir);
  }

  function maybeStartCollab(): void {
    // Build the per-room controller ONCE; the bind effect points it at each
    // file's editor as the active file changes. Only build when the collab
    // plugin is actually installed (collabClientId set).
    if (!collabActive || collabClientId === null) {
      collabController = null;
      return;
    }
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    const isOwner = collabRole === 'owner';
    collabController = new CollabController({
      isOwner,
      send: (payload) => reviewCollabSend(roomId, payload),
      selfClientId: collabClientId,
      // Caret label is the user's chosen/resolved display name (falls back to
      // the kind only if somehow empty), so peers see a real name not "Reviewer".
      selfLabel: userProfile.effectiveName || (isOwner ? 'Owner' : 'Reviewer'),
      // Caret colors mirror the presence chips: owner warm, reviewer cool.
      selfColor: isOwner ? '#d97706' : '#2563eb',
      // Owner only: seed an authority for a file a reviewer reaches before the
      // owner has opened it, from that file's base snapshot.
      getSeedDoc: isOwner ? collabSeedDocFor : undefined,
      isAuthorityDevice: isOwner
        ? undefined
        : (deviceId) =>
            reviewStore.peersResolved.some(
              (peer) => peer.deviceId === deviceId && peer.kind === 'owner',
            ),
      getLocation: currentCollabLocation,
      onPeerLocation: (deviceId, location) => {
        reviewStore.notePeerLocation(deviceId, location);
      },
      onRemoteCursors: (cursors) => {
        // Push the remote-caret set into the CURRENT editor as a meta
        // transaction so the remoteCursorsPlugin re-renders its decorations.
        // Read the live view (a file switch re-creates it — a captured view
        // would be destroyed).
        const v = pmViewForReview;
        if (v) v.dispatch(v.state.tr.setMeta(remoteCursorsKey, cursors));
      },
    });
  }

  // Keep the live caret label in sync with renames: the onboarding
  // NamePrompt fires AFTER a room is entered, so the label captured when
  // the CollabController was constructed (the git/OS default) goes stale
  // the moment the user picks a real name — peers' caret chips kept
  // showing the old name (attn-k1n follow-up). The controller
  // re-broadcasts the caret so the rename lands immediately.
  $effect(() => {
    const name = userProfile.effectiveName;
    collabController?.setSelfLabel(
      name || (collabRole === 'owner' ? 'Owner' : 'Reviewer'),
    );
  });

  // Base (earliest) snapshot markdown for a file in the current room. This is
  // the v0 every authority + resync replay anchors to, so the live editor seeds
  // from it (NOT the latest republished snapshot) and the full step log rebases
  // cleanly. Returns null until that file's first snapshot has landed.
  function collabBaseSnapshotMarkdown(fileId: FileId | null): string | null {
    const roomId = reviewStore.currentRoomId;
    if (!roomId || !fileId) return null;
    let base: ReviewSnapshot | null = null;
    for (const s of reviewStore.snapshots) {
      if (s.roomId !== roomId || s.fileId !== fileId) continue;
      // Collab/editor seed is markdown-only; HTML docs are read-only.
      if (s.docType === 'html' || typeof s.content !== 'string') continue;
      if (base === null || s.createdAt < base.createdAt) base = s;
    }
    return base?.content ?? null;
  }

  // Owner's getSeedDoc: the v0 ProseMirror doc for a file, so the controller
  // can stand up an authority for a file a reviewer edits before the owner
  // opens it. Parsed from the same base snapshot every peer seeds from.
  function collabSeedDocFor(fileId: FileId): PmNode | null {
    const md = collabBaseSnapshotMarkdown(fileId);
    if (md === null) return null;
    return markdownParser.parse(md) ?? null;
  }

  // Owner: the room's snapshot fileId for a local display path (so navigating
  // the sidebar can switch the live collab doc). Only our own shared rooms.
  function ownerFileIdForPath(path: string): FileId | null {
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return null;
    for (const s of reviewStore.snapshots) {
      if (s.roomId !== roomId) continue;
      if (reviewStore.rooms[s.roomId]?.role !== 'owner') continue;
      if (s.ownerDisplayPath === path) return s.fileId;
    }
    return null;
  }

  // Debug/E2E: mirror the live collab wiring onto `window` so `--eval` can see
  // whether a session is active and which file it's bound to (the values are
  // component-local otherwise). Cheap and harmless; kept for diagnosing the
  // per-file folder-share flow.
  $effect(() => {
    (
      window as Window & { __attn_collab_debug__?: Record<string, unknown> }
    ).__attn_collab_debug__ = {
      collabActive,
      collabRole,
      collabClientId,
      collabSeededFileId,
      collabEpoch,
      currentRoomId: reviewStore.currentRoomId,
      currentFileId: reviewStore.currentFileId,
      connection: reviewStore.connection,
      activeFileType,
      isReviewerViewingSnapshot,
      boundFileId: collabBoundFileId,
      hasController: collabController !== null,
      snapshotCount: reviewStore.snapshots.length,
    };
  });

  // True iff the editor view has the prosemirror-collab plugin installed (its
  // state carries a collab version). getVersion throws when the plugin is
  // absent — that's exactly the pre-collab / torn-down view we must NOT bind.
  function viewHasCollab(view: EditorView): boolean {
    try {
      getVersion(view.state);
      return true;
    } catch {
      return false;
    }
  }

  function handleCollabSelectionChange(head: number): void {
    collabController?.broadcastCursor(head);
  }

  function latestSnapshotForCurrentFile(): ReviewSnapshot | null {
    const roomId = reviewStore.currentRoomId;
    const fileId = reviewStore.currentFileId;
    if (!roomId || !fileId) return null;

    if (reviewStore.currentSnapshotId) {
      const locked = reviewStore.snapshots.find(
        (snapshot) =>
          snapshot.roomId === roomId
          && snapshot.fileId === fileId
          && snapshot.snapshotId === reviewStore.currentSnapshotId,
      );
      if (locked) return locked;
    }

    let latest: ReviewSnapshot | null = null;
    for (const snapshot of reviewStore.snapshots) {
      if (snapshot.roomId !== roomId || snapshot.fileId !== fileId) continue;
      if (latest === null || snapshot.createdAt > latest.createdAt) {
        latest = snapshot;
      }
    }
    return latest;
  }

  function currentCollabLocation(): {
    fileId?: import('./lib/types').FileId;
    snapshotId?: import('./lib/types').SnapshotId;
    path?: string;
  } | null {
    const snapshot = latestSnapshotForCurrentFile();
    const path = activePath || snapshot?.ownerDisplayPath;
    const fileId = reviewStore.currentFileId ?? snapshot?.fileId;
    if (!fileId && !path) return null;
    return {
      ...(fileId ? { fileId } : {}),
      ...(snapshot?.snapshotId ? { snapshotId: snapshot.snapshotId } : {}),
      ...(path ? { path } : {}),
    };
  }

  let collabSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function handleCollabDocChange(): void {
    // Reviewer views consume owner broadcasts read-only. A remote transaction
    // must never become a local submission or reach the owner's save path.
    if (collabRole !== 'owner') return;
    collabController?.onLocalChange();
    // The owner persists the converged live doc to disk (debounced) so a
    // co-typing session isn't lost on close and each save republishes a
    // snapshot capturing the latest state. Reviewers have no local file, so
    // only the owner writes back.
    if (collabRole === 'owner' && collabActive) {
      if (collabSaveTimer !== null) clearTimeout(collabSaveTimer);
      collabSaveTimer = setTimeout(() => {
        collabSaveTimer = null;
        saveEdits();
      }, 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // Suggestion composer (attn-nnj.4.5)
  //
  // Cmd+Shift+. opens a popover composer anchored to the current PM
  // selection. The composer needs a snapshot-scoped ConstructAnchorContext
  // (FileId + SnapshotId + AnchorIndex + baseHash) which we resolve at
  // open-time from the review store. If no active review room / snapshot is
  // bound, the binding is a no-op — there's nothing to suggest against.
  // ---------------------------------------------------------------------------

  interface CommentComposerState {
    view: EditorView;
    from: number;
    to: number;
    anchorContext: ConstructAnchorContext;
    roomId: import('./lib/types').RoomId;
  }

  interface SuggestionComposerState {
    view: EditorView;
    from: number;
    to: number;
    anchorContext: ConstructAnchorContext;
    roomId: import('./lib/types').RoomId;
  }

  let commentComposer = $state<CommentComposerState | null>(null);
  let suggestionComposer = $state<SuggestionComposerState | null>(null);

  function isReviewErrorStatus(
    payload: ReviewStatus | ReviewErrorStatus,
  ): payload is ReviewErrorStatus {
    return payload.kind === 'error' && 'code' in payload && 'message' in payload;
  }

  /**
   * Resolve the snapshot the suggestion should be authored against. Prefers
   * the explicitly-locked `currentSnapshotId`; otherwise the most recently
   * imported snapshot for the current file.
   */
  function resolveActiveSnapshotForCompose(): import('./lib/types').ReviewSnapshot | null {
    const fileId = reviewStore.currentFileId;
    const roomId = reviewStore.currentRoomId;
    if (!fileId || !roomId) return null;
    const lockedId = reviewStore.currentSnapshotId;
    const candidates = reviewStore.snapshots.filter(
      (s) => s.roomId === roomId && s.fileId === fileId,
    );
    if (candidates.length === 0) return null;
    if (lockedId) {
      const locked = candidates.find((s) => s.snapshotId === lockedId);
      if (locked) return locked;
    }
    // Fallback: latest by createdAt.
    return [...candidates].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  function openCommentComposer(): void {
    const view = pmViewForReview;
    if (!view) return;
    if (!hasTextSelection(view)) return;
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    const snapshot = resolveActiveSnapshotForCompose();
    if (!snapshot || !snapshot.anchorIndex) return;
    const { from, to } = view.state.selection;
    commentComposer = {
      view,
      from,
      to,
      roomId,
      anchorContext: {
        index: snapshot.anchorIndex,
        fileId: snapshot.fileId,
        snapshotId: snapshot.snapshotId,
        baseHash: snapshot.baseHash,
      },
    };
  }

  function openSuggestionComposer(): void {
    if (reviewStore.localGrantTier !== 'suggest') return;
    const view = pmViewForReview;
    if (!view) return;
    if (!hasTextSelection(view)) return;
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    const snapshot = resolveActiveSnapshotForCompose();
    if (!snapshot || !snapshot.anchorIndex) return;
    const { from, to } = view.state.selection;
    suggestionComposer = {
      view,
      from,
      to,
      roomId,
      anchorContext: {
        index: snapshot.anchorIndex,
        fileId: snapshot.fileId,
        snapshotId: snapshot.snapshotId,
        baseHash: snapshot.baseHash,
      },
    };
  }

  function closeCommentComposer(): void {
    commentComposer = null;
  }

  function closeSuggestionComposer(): void {
    suggestionComposer = null;
  }

  /**
   * Submit-only reset (attn-2aj): after a comment/suggestion is CREATED,
   * collapse the editor selection so the floating Comment|Suggest toolbar
   * doesn't resurrect over the just-annotated text the instant the
   * composer unmounts. Collapsing the PM selection is the load-bearing
   * part — clearing `toolbarSelection` alone gets re-derived from the
   * still-live selection on the next scroll/selectionchange. Cancel paths
   * deliberately do NOT call this, so Escape keeps the selection for a
   * retry or a switch to the other composer.
   */
  function collapseComposeSelection(): void {
    toolbarSelection = null;
    const view = pmViewForReview;
    if (!view) return;
    // A mid-compose file switch re-creates the editor (collabEpoch bump);
    // only collapse the view the composer was opened against — the old
    // selection died with the old view, and the new file's selection is
    // not ours to touch (a stray dispatch would also broadcast a caret
    // move to peers).
    const composerView = commentComposer?.view ?? suggestionComposer?.view;
    if (composerView !== undefined && view !== composerView) return;
    try {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, view.state.selection.to),
        ),
      );
    } catch {
      // The view can be mid-teardown on a file/tab switch; the selection
      // dies with it, which is exactly the outcome we wanted anyway.
    }
  }

  // Floating selection toolbar (attn-bit): the discoverable surface for the
  // otherwise keyboard-only comment/suggest actions. We track the live editor
  // selection and expose {from,to} when — and only when — composing is
  // actually possible (a room is active and we hold a snapshot with an anchor
  // index to author against). The buttons call the same open* paths the
  // shortcuts use.
  let toolbarSelection = $state<{ from: number; to: number } | null>(null);

  function refreshSelectionToolbar(): void {
    const view = pmViewForReview;
    if (!view || !hasTextSelection(view)) {
      toolbarSelection = null;
      return;
    }
    if (!reviewStore.currentRoomId) {
      toolbarSelection = null;
      return;
    }
    const snapshot = resolveActiveSnapshotForCompose();
    if (!snapshot || !snapshot.anchorIndex) {
      toolbarSelection = null;
      return;
    }
    const { from, to } = view.state.selection;
    toolbarSelection = { from, to };
  }

  // Owner-facing accept/reject popover for the inline suggestion under the
  // cursor (attn-07i.2 Phase 2). Reviewers suggest; only the owner disposes.
  let activeSuggestion = $state<SuggestionInfo | null>(null);

  // Click-driven (Google-Docs style): clicking a suggestion shows the popover;
  // clicking elsewhere dismisses it. Owner-only — reviewers suggest, they don't
  // dispose. We don't gate on collabActive (the owner stays on its local doc,
  // attn-0wa); findSuggestionAt returns null off a suggestion, the real gate.
  function handleSuggestionClick(id: string | null): void {
    const view = pmViewForReview;
    if (!view || collabRole !== 'owner' || id === null) {
      activeSuggestion = null;
      return;
    }
    activeSuggestion = findSuggestionById(view.state, id);
  }

  function acceptActiveSuggestion(): void {
    const view = pmViewForReview;
    const info = activeSuggestion;
    if (!view || !info) return;
    applySuggestion(info.id)(view.state, (tr) => view.dispatch(tr));
    activeSuggestion = null;
  }

  function rejectActiveSuggestion(): void {
    const view = pmViewForReview;
    const info = activeSuggestion;
    if (!view || !info) return;
    revertSuggestion(info.id)(view.state, (tr) => view.dispatch(tr));
    activeSuggestion = null;
  }

  function commentOnActiveSuggestion(): void {
    const view = pmViewForReview;
    const info = activeSuggestion;
    if (!view || !info) return;
    // Select the suggestion's range, then open the comment composer on it.
    const sel = TextSelection.create(view.state.doc, info.from, info.to);
    view.dispatch(view.state.tr.setSelection(sel));
    activeSuggestion = null;
    openCommentComposer();
  }

  $effect(() => {
    // `selectionchange` covers both mouse and keyboard selection. We read the
    // ProseMirror state (not the raw DOM selection) so the captured range
    // matches what the composer will author against.
    //
    // We ALSO re-anchor on scroll + resize: the toolbar is placed at the
    // selection's on-screen coordinates, so scrolling the editor (or resizing)
    // moves the selected text out from under it. Without this the toolbar
    // stayed frozen at its original spot while the text scrolled away. Scroll
    // is captured (true) so it catches the editor's inner scroll container,
    // whose scroll events don't bubble to the document.
    const handler = () => {
      refreshSelectionToolbar();
    };
    document.addEventListener('selectionchange', handler);
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      document.removeEventListener('selectionchange', handler);
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  });

  // Resolve every comment/suggestion anchor against the active snapshot so
  // the inline decorations + margin cards have positions to render at.
  // Without this nothing in the review surface is visible even though the
  // events have arrived — the resolver maps each anchor's authored
  // baseHash onto the current document. For events anchored to the
  // snapshot the reviewer/owner is viewing, this is the exact (base-hash
  // match) path and returns the anchor's own position.
  $effect(() => {
    const roomId = reviewStore.currentRoomId;
    const fileId = reviewStore.currentFileId;
    const events = reviewStore.events;
    if (!roomId || !fileId) return;
    // Latest snapshot for the active file provides the anchor index +
    // content hash the resolver needs.
    const snaps = reviewStore.snapshots.filter(
      (s) => s.roomId === roomId && s.fileId === fileId && s.anchorIndex,
    );
    if (snaps.length === 0) return;
    const snapshot = snaps.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    if (!snapshot.anchorIndex || typeof snapshot.content !== 'string') return;
    const ctx = {
      currentIndex: snapshot.anchorIndex,
      currentMarkdownBytes: new TextEncoder().encode(snapshot.content),
      currentHash: snapshot.baseHash,
    };
    for (const event of events) {
      const body = event.body;
      const anchor =
        body.type === 'comment_created' || body.type === 'suggestion_created'
          ? body.anchor
          : null;
      if (!anchor) continue;
      // Skip if we already resolved this event against this snapshot.
      const existing = reviewStore.anchorResolutions[event.meta.eventId];
      if (existing) continue;
      const resolved = resolveAnchor(anchor, ctx);
      reviewStore.applyAnchorResolution({
        roomId,
        fileId,
        eventId: event.meta.eventId,
        resolved,
      });
    }
  });

  // Touch reactive store reads here so Svelte schedules a rebuild whenever
  // the anchor-resolution map, event log, or focus target changes.
  $effect(() => {
    void reviewStore.anchorResolutions;
    void reviewStore.events;
    void reviewStore.focusEventId;
    void reviewStore.hoveredEventId;
    if (!pmViewForReview) return;
    requestReviewDecorationsRebuild(pmViewForReview);
  });

  function emptyPlanStructure(): PlanStructure {
    return { phases: [], tasks: [], file_refs: [] };
  }

  function normalizeFsPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function patchTreeChildren(
    nodes: TreeNode[],
    parentPath: string,
    children: TreeNode[],
  ): { next: TreeNode[]; applied: boolean } {
    let applied = false;
    const parentKey = normalizeFsPath(parentPath);
    const next = nodes.map((node) => {
      const nodePath = normalizeFsPath(node.path);
      if (nodePath === parentKey) {
        applied = true;
        return { ...node, children };
      }
      if (!node.children?.length) {
        return node;
      }
      const patched = patchTreeChildren(node.children, parentPath, children);
      if (!patched.applied) return node;
      applied = true;
      return { ...node, children: patched.next };
    });
    return { next, applied };
  }

  function applyTreePatch(patch: TreePatch): void {
    const parentKey = normalizeFsPath(patch.parentPath);
    const rootKey = normalizeFsPath(rootPath);
    if (parentKey === rootKey) {
      fileTree = patch.children;
      return;
    }
    const patched = patchTreeChildren(fileTree, patch.parentPath, patch.children);
    if (patched.applied) {
      fileTree = patched.next;
    }
  }

  function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
    return [...nodes].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  function upsertNodeIntoChildren(children: TreeNode[], node: TreeNode): TreeNode[] {
    const idx = children.findIndex((entry) => normalizeFsPath(entry.path) === normalizeFsPath(node.path));
    if (idx >= 0) {
      const next = [...children];
      next[idx] = node;
      return sortTreeNodes(next);
    }
    return sortTreeNodes([...children, node]);
  }

  function applyTreeOps(ops: TreeOp[]): void {
    if (ops.length === 0) return;
    let next = fileTree;
    const rootKey = normalizeFsPath(rootPath);
    const removeSet = new Set<string>();
    const upsertsByParent = new Map<string, Map<string, TreeNode>>();

    for (const op of ops) {
      if (op.op === 'remove') {
        removeSet.add(normalizeFsPath(op.path));
        continue;
      }
      const parent = normalizeFsPath(op.parentPath);
      const path = normalizeFsPath(op.node.path);
      const bucket = upsertsByParent.get(parent) ?? new Map<string, TreeNode>();
      bucket.set(path, op.node);
      upsertsByParent.set(parent, bucket);
    }

    for (const removedPath of removeSet) {
      loadedDirPaths.delete(removedPath);
    }

    function visit(nodes: TreeNode[]): { nodes: TreeNode[]; changed: boolean } {
      let changed = false;
      const out: TreeNode[] = [];

      for (const node of nodes) {
        const nodePath = normalizeFsPath(node.path);
        if (removeSet.has(nodePath)) {
          changed = true;
          continue;
        }

        let nextNode = node;
        if (node.children) {
          const childResult = visit(node.children);
          if (childResult.changed) {
            changed = true;
            nextNode = { ...nextNode, children: childResult.nodes };
          }
        }

        const pending = upsertsByParent.get(nodePath);
        if (pending && pending.size > 0) {
          const currentChildren = nextNode.children ?? [];
          const merged = new Map<string, TreeNode>();
          for (const child of currentChildren) {
            merged.set(normalizeFsPath(child.path), child);
          }
          for (const [path, upsertNode] of pending.entries()) {
            merged.set(path, upsertNode);
          }
          const nextChildren = sortTreeNodes(Array.from(merged.values()));
          nextNode = { ...nextNode, children: nextChildren };
          changed = true;
          upsertsByParent.delete(nodePath);
        }

        out.push(nextNode);
      }

      return { nodes: changed ? out : nodes, changed };
    }

    const rootVisited = visit(next);
    next = rootVisited.nodes;
    let rootChanged = rootVisited.changed;

    const rootUpserts = upsertsByParent.get(rootKey);
    if (rootUpserts && rootUpserts.size > 0) {
      const merged = new Map<string, TreeNode>();
      for (const node of next) {
        merged.set(normalizeFsPath(node.path), node);
      }
      for (const [path, upsertNode] of rootUpserts.entries()) {
        merged.set(path, upsertNode);
      }
      next = sortTreeNodes(Array.from(merged.values()));
      rootChanged = true;
    } else if (removeSet.size > 0) {
      const filtered = next.filter((node) => !removeSet.has(normalizeFsPath(node.path)));
      if (filtered.length !== next.length) {
        next = filtered;
        rootChanged = true;
      }
    }

    if (rootChanged) {
      fileTree = next;
    }
  }

  function pruneTabsForRemovedPaths(paths: string[]): void {
    if (paths.length === 0 || tabs.length === 0) return;

    const removed = new Set(paths.map((path) => normalizeFsPath(path)));
    const prevTabs = tabs;
    const nextTabs = prevTabs.filter((tab) => !removed.has(normalizeFsPath(tab.path)));
    if (nextTabs.length === prevTabs.length) return;

    tabs = nextTabs;

    if (nextTabs.length === 0) {
      activeTabId = '';
      pendingFrontendNav = false;
      rawMarkdown = '';
      structure = emptyPlanStructure();
      return;
    }

    const activeStillExists = nextTabs.some((tab) => tab.id === activeTabId);
    if (activeStillExists) {
      return;
    }

    const nextActive = nextTabs[0];
    activeTabId = nextActive.id;

    if (nextActive.fileType === 'markdown') {
      pendingFrontendNav = false;
      navigate(nextActive.path);
    } else {
      rawMarkdown = '';
      structure = emptyPlanStructure();
    }
  }

  function getProjectScopeKey(
    projectPath: string | undefined = activeProjectPath,
    root: string | undefined = rootPath,
  ): string {
    const key = (projectPath ?? '').trim() || (root ?? '').trim();
    return key || '__default__';
  }

  function cloneTabsForScope(input: Tab[]): Tab[] {
    return input.map((tab) => ({ ...tab }));
  }

  function persistCurrentTabScope(): void {
    scopedTabsByProject.set(activeTabScopeKey, {
      tabs: cloneTabsForScope(tabs),
      activeTabId,
    });
  }

  function applyTabScopeForProject(
    projectPath: string | undefined = activeProjectPath,
    root: string | undefined = rootPath,
  ): void {
    const nextScopeKey = getProjectScopeKey(projectPath, root);
    if (nextScopeKey === activeTabScopeKey) return;

    persistCurrentTabScope();
    activeTabScopeKey = nextScopeKey;

    const scoped = scopedTabsByProject.get(nextScopeKey);
    if (scoped) {
      tabs = cloneTabsForScope(scoped.tabs);
      activeTabId = scoped.activeTabId;
      const restoredTab = tabs.find((tab) => tab.id === activeTabId);
      if (restoredTab?.fileType === 'markdown') {
        pendingFrontendNav = false;
        navigate(restoredTab.path);
      } else if (!restoredTab) {
        rawMarkdown = '';
        structure = emptyPlanStructure();
      }
      return;
    }

    tabs = [];
    activeTabId = '';
    rawMarkdown = '';
    structure = emptyPlanStructure();
  }

  function slugifyHeading(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function isExternalLinkHref(href: string): boolean {
    if (!href) return false;
    if (href.startsWith('//')) return true;
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href);
  }

  function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  function dirname(path: string): string {
    const normalized = normalizePath(path);
    const idx = normalized.lastIndexOf('/');
    if (idx < 0) return '';
    return normalized.slice(0, idx);
  }

  function resolvePath(baseFilePath: string, hrefPath: string): string {
    const normalizedHref = normalizePath(hrefPath);
    if (normalizedHref.startsWith('/')) {
      // Treat `/foo.md` as project-root-relative (common in markdown docs),
      // not filesystem-root absolute.
      const normalizedRoot = normalizePath(rootPath);
      if (normalizedRoot) {
        const trimmedRoot = normalizedRoot.replace(/\/+$/, '');
        return `${trimmedRoot}${normalizedHref}`;
      }
      return normalizedHref;
    }
    if (/^[a-zA-Z]:\//.test(normalizedHref)) return normalizedHref;
    const baseDir = dirname(baseFilePath);
    const joined = baseDir ? `${baseDir}/${normalizedHref}` : normalizedHref;
    const parts = joined.split('/');
    const stack: string[] = [];
    const hasLeadingSlash = joined.startsWith('/');
    const driveMatch = parts[0]?.match(/^[a-zA-Z]:$/);
    const drivePrefix = driveMatch ? parts.shift()! : '';
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0 && stack[stack.length - 1] !== '..') {
          stack.pop();
        } else if (!hasLeadingSlash) {
          stack.push(part);
        }
      } else {
        stack.push(part);
      }
    }
    if (drivePrefix) {
      return `${drivePrefix}/${stack.join('/')}`;
    }
    return `${hasLeadingSlash ? '/' : ''}${stack.join('/')}`;
  }

  function splitLinkTarget(href: string): { path: string; fragment: string } {
    const hashIdx = href.indexOf('#');
    if (hashIdx < 0) return { path: href, fragment: '' };
    return {
      path: href.slice(0, hashIdx),
      fragment: href.slice(hashIdx + 1),
    };
  }

  function scrollToHeadingFragment(fragment: string): boolean {
    if (!contentViewport) return false;
    const normalized = decodeURIComponent(fragment).trim().toLowerCase();
    if (!normalized) {
      contentViewport.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    }
    const domHeadings = Array.from(
      contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    if (domHeadings.length === 0) return false;
    const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
    const idx = idsByDomOrder.findIndex((id) => id === normalized);
    if (idx < 0) return false;
    activeOutlineId = normalized;
    domHeadings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function handleEditorLinkNavigate(href: string): void {
    const trimmed = href.trim();
    if (!trimmed) return;

    if (isExternalLinkHref(trimmed)) {
      openExternal(trimmed);
      return;
    }

    const { path: rawPath, fragment } = splitLinkTarget(trimmed);
    if (!rawPath) {
      requestAnimationFrame(() => {
        scrollToHeadingFragment(fragment);
      });
      return;
    }

    const resolvedPath = resolvePath(activePath, decodeURIComponent(rawPath));
    if (!resolvedPath) return;

    if (fragment) {
      pendingLinkAnchor = { path: resolvedPath, fragment };
    }
    openPath(resolvedPath, detectFileType(resolvedPath));
  }

  function extractOutlineHeadings(markdown: string): OutlineHeading[] {
    if (!markdown) return [];
    const lines = markdown.split(/\r?\n/);
    const slugCounts = new Map<string, number>();
    const result: OutlineHeading[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      const level = match[1].length;
      const text = match[2].trim();
      if (!text) continue;
      const base = slugifyHeading(text) || `section-${i + 1}`;
      const count = (slugCounts.get(base) ?? 0) + 1;
      slugCounts.set(base, count);
      const id = count > 1 ? `${base}-${count}` : base;
      result.push({ id, text, level, line: i + 1 });
    }

    return result;
  }

  function normalizedHeadingKey(text: string, level: number): string {
    return `${level}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  function buildOutlineDomIndex(headings: OutlineHeading[], domHeadings: HTMLElement[]): string[] {
    const outlineBuckets = new Map<string, string[]>();
    for (const heading of headings) {
      const key = normalizedHeadingKey(heading.text, heading.level);
      const bucket = outlineBuckets.get(key) ?? [];
      bucket.push(heading.id);
      outlineBuckets.set(key, bucket);
    }

    const consumed = new Map<string, number>();
    return domHeadings.map((el) => {
      const level = Number(el.tagName.slice(1));
      const key = normalizedHeadingKey(el.textContent ?? '', level);
      const bucket = outlineBuckets.get(key);
      if (!bucket || bucket.length === 0) return '';
      const used = consumed.get(key) ?? 0;
      consumed.set(key, used + 1);
      return bucket[used] ?? '';
    });
  }

  function syncActiveOutlineFromViewport(): void {
    if (!contentViewport || outlineHeadings.length === 0) {
      activeOutlineId = '';
      return;
    }
    const domHeadings = Array.from(
      contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    if (domHeadings.length === 0) {
      activeOutlineId = outlineHeadings[0]?.id ?? '';
      return;
    }

    const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
    const viewportTop = contentViewport.getBoundingClientRect().top + 72;
    let current = idsByDomOrder[0] || outlineHeadings[0]?.id || '';

    for (let i = 0; i < domHeadings.length; i += 1) {
      const id = idsByDomOrder[i];
      if (!id) continue;
      if (domHeadings[i].getBoundingClientRect().top <= viewportTop) {
        current = id;
      } else {
        break;
      }
    }

    activeOutlineId = current;
  }

  function handleOutlineNavigate(id: string): void {
    activeOutlineId = id;
    if (!contentViewport) return;
    requestAnimationFrame(() => {
      if (!contentViewport) return;
      const domHeadings = Array.from(
        contentViewport.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
      );
      if (domHeadings.length === 0) return;
      const idsByDomOrder = buildOutlineDomIndex(outlineHeadings, domHeadings);
      const idx = idsByDomOrder.findIndex((entry) => entry === id);
      if (idx === -1) return;
      domHeadings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function openPath(path: string, fileType?: FileType, newTab = false): void {
    const ft = fileType ?? detectFileType(path);

    // For directories, always (re-)load children so DirectoryOverview shows the full listing.
    // This must run before the early-return below (tab reuse) to ensure children are loaded
    // even when navigating back to an already-open directory tab.
    if (ft === 'directory') {
      loadChildren(path);
    }

    if (!newTab) {
      // Reuse existing tab for this path, or navigate the active tab
      const existing = findTabByPath(tabs, path);
      if (existing) {
        switchTab(existing.id);
        return;
      }
    }

    if (newTab || tabs.length === 0) {
      // Add a new tab
      const tab = createTab(path, ft);
      tabs = [...tabs, tab];
      activeTabId = tab.id;
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = 0;
      });
    } else {
      // Navigate current tab
      saveScrollPosition();
      const tab = activeTab;
      if (tab) {
        tab.path = path;
        tab.fileType = ft;
        tab.label = path.split('/').pop() ?? path;
        tab.scrollY = 0;
        tabs = [...tabs]; // trigger reactivity
      }
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = 0;
      });
    }

    // For markdown files, tell Rust backend to load content
    if (ft === 'markdown') {
      pendingFrontendNav = true;
      navigate(path);
    }
  }

  function switchTab(id: string): void {
    if (id === activeTabId) return;
    saveScrollPosition();
    activeTabId = id;
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      if (tab.fileType === 'markdown') {
        navigate(tab.path);
      }
      // Restore scroll after content renders
      requestAnimationFrame(() => {
        if (contentViewport) contentViewport.scrollTop = tab.scrollY;
      });
    }
  }

  function closeTab(id: string): void {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    tabs = tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) {
      activeTabId = '';
      return;
    }
    if (id === activeTabId) {
      // Activate adjacent tab
      const newIdx = Math.min(idx, tabs.length - 1);
      switchTab(tabs[newIdx].id);
    }
  }

  function saveScrollPosition(): void {
    const tab = activeTab;
    if (tab && contentViewport) tab.scrollY = contentViewport.scrollTop;
  }

  // Gallery navigation: collect supported files from tree
  function collectSupportedFiles(nodes: TreeNode[]): string[] {
    const result: string[] = [];
    for (const node of nodes) {
      if (node.isDir && node.children) {
        result.push(...collectSupportedFiles(node.children));
      } else if (node.fileType !== 'unsupported' && node.fileType !== 'directory') {
        result.push(node.path);
      }
    }
    return result;
  }

  function navigateGallery(direction: -1 | 1): void {
    const files = collectSupportedFiles(fileTree);
    if (files.length === 0) return;
    const currentIdx = files.indexOf(activePath);
    if (currentIdx === -1) return;
    const newIdx = (currentIdx + direction + files.length) % files.length;
    openPath(files[newIdx]);
  }

  function handleEditorDirtyChange(dirty: boolean): void {
    editorDirty = dirty;
  }

  function deferExternalReload(path: string, contentMtimeMs?: number): void {
    if (!path) return;
    deferredReloadMtimeByPath.set(path, typeof contentMtimeMs === 'number' ? contentMtimeMs : null);
    if (deferredReloadNoticeByPath.has(path)) return;
    deferredReloadNoticeByPath.add(path);
    toast.info('File changed on disk. Reload will apply after save or cancel.');
  }

  async function flushDeferredReload(path: string): Promise<void> {
    if (!path || !deferredReloadMtimeByPath.has(path)) return;
    const pendingMtime = deferredReloadMtimeByPath.get(path);
    deferredReloadMtimeByPath.delete(path);
    deferredReloadNoticeByPath.delete(path);
    await loadMarkdownForPath(path, typeof pendingMtime === 'number' ? pendingMtime : undefined);
  }

  function invalidatePathCaches(paths: string[]): void {
    for (const path of paths) {
      if (!path) continue;
      markdownCacheByPath.delete(path);
      loadedMtimeByPath.delete(path);
    }
  }

  async function loadMarkdownForPath(path: string, contentMtimeMs?: number): Promise<void> {
    if (!path || detectFileType(path) !== 'markdown') return;
    const cachedMarkdown = markdownCacheByPath.get(path);
    if (typeof contentMtimeMs === 'number') {
      const lastMtime = loadedMtimeByPath.get(path);
      if (lastMtime === contentMtimeMs && typeof cachedMarkdown === 'string') {
        rawMarkdown = cachedMarkdown;
        structure = extractStructureFromMarkdown(cachedMarkdown);
        return;
      }
    }

    try {
      const markdown = await loadMarkdownFromPath(path);
      const currentPath = tabs.find((t) => t.id === activeTabId)?.path;
      if (currentPath && currentPath !== path) return;

      rawMarkdown = markdown;
      structure = extractStructureFromMarkdown(markdown);
      markdownCacheByPath.set(path, markdown);
      deferredReloadMtimeByPath.delete(path);
      deferredReloadNoticeByPath.delete(path);
      if (typeof contentMtimeMs === 'number') {
        loadedMtimeByPath.set(path, contentMtimeMs);
      }
    } catch (error) {
      console.error('[attn] failed to load markdown via attn protocol', { path, error });
    }
  }

  /** Find the first supported file in the tree (depth-first) */
  function findFirstFile(nodes: TreeNode[]): TreeNode | undefined {
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const found = findFirstFile(node.children);
        if (found) return found;
      } else if (node.fileType !== 'unsupported' && node.fileType !== 'directory') {
        return node;
      }
    }
    return undefined;
  }

  function findTreeNodeByPath(nodes: TreeNode[], path: string): TreeNode | undefined {
    const normalizedTarget = normalizeFsPath(path);
    for (const node of nodes) {
      if (normalizeFsPath(node.path) === normalizedTarget) {
        return node;
      }
      if (node.children && node.children.length > 0) {
        const found = findTreeNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return undefined;
  }

  function inferFileTypeFromTree(path: string): FileType | undefined {
    if (!path) return undefined;
    if (normalizeFsPath(path) === normalizeFsPath(rootPath)) {
      return 'directory';
    }
    return findTreeNodeByPath(fileTree, path)?.fileType;
  }

  function loadInitPayload(): void {
    const init = (window as { __attn_init__?: InitPayload }).__attn_init__;
    if (!init) {
      // Show Svelte app even without init data
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.display = '';
      return;
    }
    // Capture the IPC capability token before we clear the payload — `send()`
    // attaches it to privileged messages so the daemon accepts them.
    setIpcToken(init.ipcToken);
    // DEBUG BUILDS ONLY (daemon sets `debugBuild` from cfg!(debug_assertions),
    // never in release): expose the session token on the main frame so the
    // automation bridge (`attn --eval`, E2E suites) can drive privileged raw
    // `window.ipc.postMessage` calls past the capability gate. Sandboxed
    // HtmlViewer iframes have their own `window` and still never see it.
    if (init.debugBuild && init.ipcToken) {
      (window as { __attn_ipc_token__?: string }).__attn_ipc_token__ = init.ipcToken;
    }

    // Clear so we only process once (prevents $effect re-entry)
    delete (window as { __attn_init__?: InitPayload }).__attn_init__;

    // Seed the onboarding display name (chosen name + git/OS default).
    userProfile.hydrate(init.reviewProfile);
    if (init.resident) {
      residentSettings = { ...init.resident, error: init.resident.error ?? null };
    }

    // Best-effort "update available" nudge: ping npm for the latest attnmd and
    // toast if this build is behind. No auto-install; failures are silent.
    void checkForUpdate(init.version).then((update) => {
      if (!update) return;
      // Homebrew is macOS-only — point Linux at npm only.
      const isMacOS =
        /Mac/i.test(navigator.platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent);
      toast(`attn ${update.latest} is available`, {
        description: `You're on ${update.current}. ${upgradeHint(isMacOS)}`,
        duration: 12000,
      });
    });

    rawMarkdown = init.markdown ?? '';
    structure = init.structure ?? emptyPlanStructure();
    const initialMarkdown = typeof init.markdown === 'string' && init.markdown.length > 0
      ? init.markdown
      : null;
    if (init.filePath && detectFileType(init.filePath) === 'markdown' && initialMarkdown !== null) {
      markdownCacheByPath.set(init.filePath, initialMarkdown);
      if (typeof init.contentMtimeMs === 'number') {
        loadedMtimeByPath.set(init.filePath, init.contentMtimeMs);
      }
    }
    diagMode = init.diagMode ?? 'full';
    if (init.fileTree) {
      fileTree = init.fileTree;
      loadedDirPaths.clear();
    }
    if (init.rootPath) {
      rootPath = init.rootPath;
    }
    if (init.knownProjects) {
      knownProjects = init.knownProjects;
    }
    if (init.activeProjectPath) {
      activeProjectPath = init.activeProjectPath;
    } else if (init.rootPath) {
      activeProjectPath = init.rootPath;
    }
    activeTabScopeKey = getProjectScopeKey(activeProjectPath, rootPath);
    if (init.filePath) {
      const ft = detectFileType(init.filePath);
      const openedDirectory = ft === 'unsupported' && init.rootPath === init.filePath;
      if (!openedDirectory) {
        // Opening a specific file (including unsupported types)
        const tab = createTab(init.filePath, ft);
        tabs = [tab];
        activeTabId = tab.id;
        if (ft === 'markdown' && !init.markdown) {
          void loadMarkdownForPath(init.filePath, init.contentMtimeMs);
        }
      } else if (init.fileTree && init.fileTree.length > 0) {
        // Opening a directory — auto-select first supported file
        const first = findFirstFile(init.fileTree);
        if (first) {
          const tab = createTab(first.path, first.fileType);
          tabs = [tab];
          activeTabId = tab.id;
          pendingAutoNav = first.fileType === 'markdown' ? first.path : null;
        }
      }
    }
    document.documentElement.dataset.theme = init.theme;
    initTheme();

    // Show Svelte app
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.display = '';
  }

  function registerIpcHandlers(): void {
    function applySetContent(data: ContentPayload): void {
      if (data.rootPath) {
        rootPath = data.rootPath;
      }
      if (data.knownProjects) {
        knownProjects = data.knownProjects;
      }
      if (data.activeProjectPath) {
        activeProjectPath = data.activeProjectPath;
      }
      if (data.searchResults) {
        const incomingQuery = data.searchResults.query ?? '';
        const incomingItems = data.searchResults.items ?? [];
        sidebarSearchQuery = incomingQuery;
        sidebarSearchResults = incomingItems;
        if (incomingQuery.trim().toLowerCase() === commandPaletteSearchQuery.trim().toLowerCase()) {
          commandPaletteSearchQuery = incomingQuery;
          commandPaletteSearchResults = incomingItems;
        }
      }
      applyTabScopeForProject(activeProjectPath, rootPath);

      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        if (detectFileType(data.filePath) === 'markdown') {
          markdownCacheByPath.set(data.filePath, data.markdown);
          deferredReloadMtimeByPath.delete(data.filePath);
          deferredReloadNoticeByPath.delete(data.filePath);
          if (typeof data.contentMtimeMs === 'number') {
            loadedMtimeByPath.set(data.filePath, data.contentMtimeMs);
          }
        }
        if (data.structure) {
          structure = data.structure;
        } else {
          structure = extractStructureFromMarkdown(data.markdown);
        }
      } else if (data.structure) {
        structure = data.structure;
      }

      // Seed the HTML viewer's mtime so its iframe src is stable across
      // re-renders and gives live-reload a known baseline to diff against.
      if (
        data.filePath &&
        detectFileType(data.filePath) === 'html' &&
        typeof data.contentMtimeMs === 'number'
      ) {
        htmlMtimeByPath.set(data.filePath, data.contentMtimeMs);
      }

      const wasFrontendNav = pendingFrontendNav;
      if (data.filePath) {
        pendingFrontendNav = false;
      }

      if (data.filePath && data.filePath !== activePath) {
        const ft = detectFileType(data.filePath);

        if (tabs.length === 0) {
          // First tab
          const tab = createTab(data.filePath, ft);
          tabs = [tab];
          activeTabId = tab.id;
        } else if (wasFrontendNav) {
          // Sidebar click: update the active tab
          const tab = activeTab;
          if (tab) {
            tab.path = data.filePath;
            tab.fileType = ft;
            tab.label = data.filePath.split('/').pop() ?? data.filePath;
            tab.scrollY = 0;
            tabs = [...tabs];
            requestAnimationFrame(() => {
              if (contentViewport) contentViewport.scrollTop = 0;
            });
          }
        } else {
          // Daemon socket: add a new tab (or focus existing)
          const existing = findTabByPath(tabs, data.filePath);
          if (existing) {
            activeTabId = existing.id;
          } else {
            const tab = createTab(data.filePath, ft);
            tabs = [...tabs, tab];
            activeTabId = tab.id;
          }
        }
      }
      if (data.fileTree) {
        fileTree = data.fileTree;
        loadedDirPaths.clear();
      }
      if (data.treePatch) {
        applyTreePatch(data.treePatch);
        loadedDirPaths.add(normalizeFsPath(data.treePatch.parentPath));
      }
      if (data.treeOps) {
        applyTreeOps(data.treeOps);
        // Only prune tabs for paths that are genuinely deleted — NOT for a
        // remove+upsert pair, which is a replace/rename (e.g. the owner's atomic
        // temp-file+rename save). Pruning those closed the file the owner was
        // editing and unmounted the editor mid-collab.
        pruneTabsForRemovedPaths(netRemovedPaths(data.treeOps));
      }
      if (detectFileType(data.filePath) === 'markdown' && typeof data.markdown !== 'string') {
        if (!wasFrontendNav && mode === 'edit' && data.filePath === activePath && editorDirty) {
          deferExternalReload(data.filePath, data.contentMtimeMs);
          return;
        }
        if (wasFrontendNav) {
          editorDirty = false;
        }
        void loadMarkdownForPath(data.filePath, data.contentMtimeMs);
      }
    }

    function applyUpdateContent(data: UpdatePayload): void {
      if (data.rootPath) {
        rootPath = data.rootPath;
      }
      if (data.knownProjects) {
        knownProjects = data.knownProjects;
      }
      if (data.activeProjectPath) {
        activeProjectPath = data.activeProjectPath;
      }
      if (data.searchResults) {
        const incomingQuery = data.searchResults.query ?? '';
        const incomingItems = data.searchResults.items ?? [];
        sidebarSearchQuery = incomingQuery;
        sidebarSearchResults = incomingItems;
        if (incomingQuery.trim().toLowerCase() === commandPaletteSearchQuery.trim().toLowerCase()) {
          commandPaletteSearchQuery = incomingQuery;
          commandPaletteSearchResults = incomingItems;
        }
      }
      applyTabScopeForProject(activeProjectPath, rootPath);
      if (data.fileTree) {
        fileTree = data.fileTree;
        loadedDirPaths.clear();
      }
      if (data.treePatch) {
        applyTreePatch(data.treePatch);
        loadedDirPaths.add(normalizeFsPath(data.treePatch.parentPath));
      }
      if (data.treeOps) {
        applyTreeOps(data.treeOps);
        // Only prune tabs for paths that are genuinely deleted — NOT for a
        // remove+upsert pair, which is a replace/rename (e.g. the owner's atomic
        // temp-file+rename save). Pruning those closed the file the owner was
        // editing and unmounted the editor mid-collab.
        pruneTabsForRemovedPaths(netRemovedPaths(data.treeOps));
      }
      if (data.changedPaths && data.changedPaths.length > 0) {
        invalidatePathCaches(data.changedPaths);
      }

      if (typeof data.markdown === 'string') {
        rawMarkdown = data.markdown;
        const sourcePath = data.filePath ?? activePath;
        if (sourcePath && detectFileType(sourcePath) === 'markdown') {
          markdownCacheByPath.set(sourcePath, data.markdown);
          deferredReloadMtimeByPath.delete(sourcePath);
          deferredReloadNoticeByPath.delete(sourcePath);
          if (typeof data.contentMtimeMs === 'number') {
            loadedMtimeByPath.set(sourcePath, data.contentMtimeMs);
          }
        }
        if (data.structure) {
          structure = data.structure;
        } else {
          structure = extractStructureFromMarkdown(data.markdown);
        }
        return;
      }

      if (data.structure) {
        structure = data.structure;
      }

      // HTML live-reload: when the active html file changes on disk, record its
      // new mtime so HtmlViewer cache-busts its iframe src and refetches. The
      // watcher ships contentMtimeMs for any active file (type-agnostic);
      // markdown is handled below via loadMarkdownForPath.
      {
        let htmlPath = data.filePath;
        if (!htmlPath && data.changedPaths?.includes(activePath)) {
          htmlPath = activePath;
        }
        if (
          htmlPath &&
          detectFileType(htmlPath) === 'html' &&
          typeof data.contentMtimeMs === 'number'
        ) {
          htmlMtimeByPath.set(htmlPath, data.contentMtimeMs);
        }
      }

      let targetPath = data.filePath;
      if (!targetPath && data.changedPaths?.includes(activePath)) {
        targetPath = activePath;
      }
      if (targetPath && targetPath === activePath && detectFileType(targetPath) === 'markdown') {
        if (mode === 'edit' && editorDirty) {
          deferExternalReload(targetPath, data.contentMtimeMs);
          return;
        }
        void loadMarkdownForPath(targetPath, data.contentMtimeMs);
      }
    }

    function consumeNativeRoomFocus(): void {
      const targetWindow = window as Window & { __attn_pending_review_focus__?: string };
      const pending = targetWindow.__attn_pending_review_focus__ ?? null;
      const remaining = consumePendingRoomFocus(reviewStore, pending);
      if (remaining === null) {
        delete targetWindow.__attn_pending_review_focus__;
      } else {
        targetWindow.__attn_pending_review_focus__ = remaining;
      }
    }

    window.__attn__ = {
      setContent(data: ContentPayload) {
        applySetContent(data);
      },
      updateContent(data: UpdatePayload) {
        applyUpdateContent(data);
      },
      increaseFontScale() {
        increaseGlobalFontScale();
      },
      decreaseFontScale() {
        decreaseGlobalFontScale();
      },
      resetFontScale() {
        resetGlobalFontScale();
      },
      // Review callbacks delegate to the global review store.
      reviewStatus(payload: ReviewStatus | ReviewErrorStatus) {
        if (isReviewErrorStatus(payload)) {
          reviewStore.applyError(payload);
          return;
        }
        if (payload.grantTier) {
          reviewStore.setLocalGrantTier(payload.roomId, payload.grantTier);
          return;
        }
        reviewStore.applyStatus(payload);
        consumeNativeRoomFocus();
      },
      // Pushed by Rust right after `Bootstrapper::share` succeeds. Carries
      // the invite URL + owner key, so the Share dialog renders the URL +
      // verify-key fingerprint without a follow-up round-trip and without
      // string-parsing a `Live|<invite>` blob.
      reviewShareReady(payload: import('./lib/types').ReviewShareReady) {
        reviewStore.applyShareReady({
          roomId: payload.roomId,
          inviteUrl: payload.inviteUrl,
          browserInviteUrl: payload.browserInviteUrl,
          viewInviteUrl: payload.viewInviteUrl,
          suggestInviteUrl: payload.suggestInviteUrl,
          browserViewInviteUrl: payload.browserViewInviteUrl,
          browserSuggestInviteUrl: payload.browserSuggestInviteUrl,
          ownerDisplayPath: payload.ownerDisplayPath,
          ownerSigningKey: payload.ownerSigningKey,
          mode: payload.mode,
          expiresAt: payload.expiresAt,
        });
        consumeNativeRoomFocus();
      },
      reviewEvent(payload: ReviewEvent) {
        reviewStore.applyEvent(payload);
        consumeNativeRoomFocus();
      },
      reviewSnapshot(snapshot: ReviewSnapshot) {
        reviewStore.applySnapshot(snapshot);
        consumeNativeRoomFocus();
      },
      reviewAnchorResolution(update: ReviewAnchorResolutionUpdate) {
        reviewStore.applyAnchorResolution(update);
      },
      // Live presence: relay `hello` (full roster) and `presence`
      // (join/leave) frames, translated by the daemon into face-chip deltas
      // that feed `reviewStore.peers` → PeerStrip.
      reviewPresence(payload: import('./lib/types').ReviewPresenceChanged) {
        // Clear any live caret for a peer that just went offline so a
        // departed reviewer's cursor doesn't linger for the rest of the
        // session. Join/leave deltas arrive as `replace=false` with the
        // peer's `online` flag flipped.
        if (!payload.replace) {
          for (const peer of payload.peers) {
            if (!peer.online) collabController?.removeCursorsForDevice(peer.deviceId);
          }
        }
        reviewStore.applyPresence(payload);
      },
      // Live transport state: `mailbox` on relay subscribe, `offline` on
      // disconnect. Drives the ConnectionBadge.
      reviewConnection(payload: import('./lib/types').ReviewConnectionChanged) {
        const reconnecting =
          payload.roomId === reviewStore.currentRoomId &&
          reviewStore.connection === 'offline' &&
          payload.connection !== 'offline';
        reviewStore.applyConnection(payload);
        if (reconnecting) collabController?.onTransportConnected();
      },
      reviewUnread(payload: ReviewUnreadChanged) {
        reviewStore.applyUnread(payload);
        consumeNativeRoomFocus();
      },
      reviewNotificationMute(payload: ReviewNotificationMuteChanged) {
        reviewStore.applyNotificationMute(payload);
      },
      // Inbound live co-typing steps — route into the active collab session.
      reviewCollab(payload: import('./lib/types').ReviewCollabSignal) {
        collabController?.onInbound(payload.payload, payload.from);
      },
      // Per planning/collab/ui/review-panel-design.md §6: ReviewMargin
      // exposes `focusCard(eventId)` on the bridge so the editor's
      // inline-decoration click handler (10.2) and E2E automation can
      // scroll/highlight the matching margin card. The margin's own
      // $effect already watches `reviewStore.focusEventId`, so this is
      // a thin pass-through.
      reviewFocusCard(eventId: string) {
        reviewStore.setFocusEventId(eventId);
      },
    };

    // E2E helper: expose the global review store so daemon `--eval` channels
    // (scripts/test-review-e2e.sh, attn-nnj.11.4 / 4.14) can drive the panel
    // selection model directly — e.g. `reviewStore.setCurrentFile(...)`
    // before playing a scripted scenario. The same store instance is in use
    // by the rest of the app; no shadow copy.
    //
    // @see planning/collab/data-model.md §Review Store
    (window as Window & { __attn_review_store__?: typeof reviewStore })
      .__attn_review_store__ = reviewStore;
    // Same rationale for the onboarding profile: E2E drives `save(name)` to set
    // the display name deterministically before sharing/joining.
    (window as Window & { __attn_user_profile__?: typeof userProfile })
      .__attn_user_profile__ = userProfile;

    type QueuedMessage =
      | { kind: 'set'; data: ContentPayload }
      | { kind: 'update'; data: UpdatePayload }
      | {
          kind: 'review';
          callback:
            | 'reviewStatus'
            | 'reviewShareReady'
            | 'reviewEvent'
            | 'reviewSnapshot'
            | 'reviewAnchorResolution'
            | 'reviewPresence'
            | 'reviewConnection'
            | 'reviewCollab'
            | 'reviewUnread'
            | 'reviewNotificationMute';
          data: unknown;
        };
    const w = window as Window & { __attn_queue__?: QueuedMessage[] };
    const queued = w.__attn_queue__ ?? [];
    for (const item of queued) {
      if (item.kind === 'set') {
        applySetContent(item.data);
      } else if (item.kind === 'update') {
        applyUpdateContent(item.data);
      } else if (item.kind === 'review') {
        // Native can resume rooms before the Svelte bridge mounts. Replay the
        // queued callback through the newly-installed bridge so early status,
        // events, and unread hydration are not lost at boot.
        const bridge = window.__attn__ as unknown as Record<
          typeof item.callback,
          ((payload: unknown) => void) | undefined
        >;
        bridge[item.callback]?.(item.data);
      }
    }
    w.__attn_queue__ = [];
    // A native notification can be clicked while the Svelte bridge is still
    // mounting. Apply that focus only after queued room hydration has run.
    consumeNativeRoomFocus();
  }

  function saveEdits(): void {
    if (editorRef) {
      const md = editorRef.getMarkdown();
      if (activePath && detectFileType(activePath) === 'markdown') {
        rawMarkdown = md;
        markdownCacheByPath.set(activePath, md);
      }
      structure = extractStructureFromMarkdown(md);
      editSave(md);
      editorRef.commitSaved();
      editorDirty = false;
      if (activePath) {
        deferredReloadMtimeByPath.delete(activePath);
        deferredReloadNoticeByPath.delete(activePath);
      }
    }
  }

  function cancelEdit(): void {
    if (editorRef) {
      editorRef.resetToMarkdown(rawMarkdown);
    }
    editorDirty = false;
    if (activePath && detectFileType(activePath) === 'markdown') {
      void flushDeferredReload(activePath);
    }
    toast.info('Edits reverted');
  }

  function isShortcutsHelpHotkey(e: KeyboardEvent): boolean {
    if (e.repeat) return false;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return false;
    return (
      e.code === 'Slash'
      || e.code === 'NumpadDivide'
      || e.code === 'IntlRo'
      || e.code === 'IntlYen'
      || e.key === '/'
      || e.key === '?'
      || e.key === '÷'
    );
  }

  function isEditableShortcutElement(el: HTMLElement | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return Boolean(
      el.closest('[contenteditable="true"]')
      || el.closest('[role="textbox"]')
      || el.closest('.cm-editor')
      || el.closest('.monaco-editor')
      || el.closest('.ProseMirror'),
    );
  }

  function isEditableShortcutTarget(target: EventTarget | null): boolean {
    const targetEl = target as HTMLElement | null;
    if (isEditableShortcutElement(targetEl)) return true;
    const activeEl = document.activeElement as HTMLElement | null;
    return isEditableShortcutElement(activeEl);
  }

  // Window/document title tracks the open file (Theme v2, attn-u5c): the
  // native titlebar is hidden on macOS by design, but document.title feeds
  // assistive tech, automation, and the window switcher.
  $effect(() => {
    const name = activePath ? activePath.split('/').filter(Boolean).at(-1) : null;
    document.title = name ? `${name} — attn` : 'attn';
  });

  // Palette commands (Theme v2, attn-n9j): the palette runs the reviewer's
  // verbs, not just file opens. Handlers are the same ones the keyboard
  // chords call, so palette and shortcuts can never drift apart.
  const paletteMod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const paletteCommands: PaletteCommand[] = [
    {
      id: 'comment',
      label: 'Comment on selection',
      hint: [paletteMod, '.'],
      keywords: 'comment annotate note review thread',
      icon: MessageSquareTextIcon,
      run: () => openCommentComposer(),
    },
    {
      id: 'suggest',
      label: 'Suggest an edit',
      hint: [paletteMod, '⇧', '.'],
      keywords: 'suggest edit replace propose change',
      icon: PenLineIcon,
      run: () => openSuggestionComposer(),
    },
    {
      id: 'share',
      label: 'Share this file for review…',
      hint: [paletteMod, '⇧', 'S'],
      keywords: 'share review link encrypted room invite',
      icon: Share2Icon,
      run: () => openShareDialog(),
    },
    {
      id: 'review-panel',
      label: 'Toggle review panel',
      hint: [paletteMod, 'J'],
      keywords: 'review panel rail threads margin toggle',
      icon: PanelRightIcon,
      run: () => reviewStore.togglePanel(),
    },
    {
      id: 'theme',
      label: 'Switch theme (Paper / Ink)',
      hint: ['T'],
      keywords: 'theme dark light paper ink appearance',
      icon: SunMoonIcon,
      run: () => cycleTheme(),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: [paletteMod, '/'],
      keywords: 'keyboard shortcuts help keys bindings',
      icon: KeyboardIcon,
      run: () => {
        shortcutsOpen = true;
      },
    },
  ];

  function handleGlobalShortcutsHelpHotkey(e: KeyboardEvent): void {
    if (!isShortcutsHelpHotkey(e)) return;
    if (isEditableShortcutTarget(e.target)) return;
    e.preventDefault();
    shortcutsOpen = !shortcutsOpen;
    if (shortcutsOpen) commandPaletteOpen = false;
  }

  function isRightRailHotkey(e: KeyboardEvent): boolean {
    if (e.repeat) return false;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return false;
    if (e.altKey || e.shiftKey) return false;
    return e.key === 'j' || e.key === 'J' || e.code === 'KeyJ';
  }

  // Placeholder shortcut for the right-rail toggle. Real wiring (with proper
  // help text, focus management, and review-mode gating) lands in 12.9.
  function handleGlobalRightRailHotkey(e: KeyboardEvent): void {
    if (!isRightRailHotkey(e)) return;
    if (isEditableShortcutTarget(e.target)) return;
    e.preventDefault();
    reviewStore.togglePanel();
  }

  /**
   * Open the Share-for-review modal (attn-nnj.4.10). Triggered by the
   * ReviewBar's [Share] button click handler and by the Cmd+Shift+S
   * binding routed through initKeyboard. We gate on an active markdown
   * tab — sharing a directory or a non-markdown asset is meaningless.
   */
  function openShareDialog(): void {
    if (!activePath) return;
    openShareDialogForPath(activePath);
  }

  function openShareDialogForPath(path: string, isDir = false): void {
    if (!path) return;
    const ft = detectFileType(path);
    // A folder share enumerates its markdown files on the daemon side, so the
    // path itself isn't a markdown file — only gate single-file shares on type.
    if (!isDir && ft !== 'markdown') return;
    // First-time onboarding: confirm/set the display name BEFORE the first
    // share so the published participant carries it (and so the prompt doesn't
    // stack on top of the ShareDialog). Stash the path; resume after the prompt.
    if (!userProfile.isSet && !namePrompted) {
      namePrompted = true;
      pendingSharePath = path;
      pendingShareIsDir = isDir;
      namePromptMode = 'onboard';
      namePromptOpen = true;
      return;
    }
    shareTargetPath = path;
    // Navigate to a single file so the owner sees what they're sharing; a
    // folder isn't a document, so leave the owner on their current file.
    if (!isDir && (path !== activePath || activeFileType !== 'markdown')) {
      openPath(path, ft, false);
    }
    shareDialogOpen = true;
  }

  function handleLeaveRoom(roomId: import('./lib/types').RoomId): void {
    void reviewStop(roomId);
  }

  // Handle sidebar navigation events
  function handleSidebarNavigate(path: string, newTab: boolean): void {
    openPath(path, undefined, newTab);
  }

  function handleProjectSwitch(path: string): void {
    if (!path || path === activeProjectPath) return;
    pendingFrontendNav = false;
    switchProject(path);
  }

  function handleTreeExpand(path: string): void {
    if (!path) return;
    const normalized = normalizeFsPath(path);
    if (loadedDirPaths.has(normalized)) return;
    loadedDirPaths.add(normalized);
    loadChildren(path);
  }

  function handleSidebarSearchQuery(query: string): void {
    searchFiles(query);
  }

  function handleCommandPaletteSearchQuery(query: string): void {
    commandPaletteSearchQuery = query;
    searchFiles(query);
  }

  $effect(() => {
    if (activeFileType !== 'markdown') {
      outlineHeadings = [];
      activeOutlineId = '';
      editorDirty = false;
      return;
    }

    const headings = extractOutlineHeadings(rawMarkdown);
    outlineHeadings = headings;
    activeOutlineId = headings[0]?.id ?? '';
    requestAnimationFrame(() => {
      syncActiveOutlineFromViewport();
    });
  });

  $effect(() => {
    const pending = pendingLinkAnchor;
    if (!pending) return;
    if (activePath !== pending.path) return;
    if (activeFileType !== 'markdown') {
      pendingLinkAnchor = null;
      return;
    }
    requestAnimationFrame(() => {
      scrollToHeadingFragment(pending.fragment);
      if (pendingLinkAnchor?.path === pending.path && pendingLinkAnchor?.fragment === pending.fragment) {
        pendingLinkAnchor = null;
      }
    });
  });

  $effect(() => {
    if (!contentViewport) return;
    const viewport = contentViewport;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncActiveOutlineFromViewport();
      });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(() => {
      syncActiveOutlineFromViewport();
    });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  });

  $effect(() => {
    initFontScale();
    loadInitPayload();
    registerIpcHandlers();
    // Handle deferred auto-navigation (directory opened, first file selected)
    if (pendingAutoNav) {
      navigate(pendingAutoNav);
      pendingAutoNav = null;
    }
    if (diagMode === 'minimal') {
      return;
    }
    const cleanup = initKeyboard({
      onTabClose: () => { if (activeTabId) closeTab(activeTabId); },
      onTabPrev: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) switchTab(tabs[idx - 1].id);
      },
      onTabNext: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
      },
      onGalleryPrev: () => navigateGallery(-1),
      onGalleryNext: () => navigateGallery(1),
      onUndo: () => {
        if (mode !== 'edit' || activeFileType !== 'markdown') return;
        editorRef?.undoStep();
      },
      onRedo: () => {
        if (mode !== 'edit' || activeFileType !== 'markdown') return;
        editorRef?.redoStep();
      },
      onCommandPalette: () => {
        commandPaletteOpen = !commandPaletteOpen;
        if (commandPaletteOpen) shortcutsOpen = false;
      },
      onShareOpen: () => {
        openShareDialog();
      },
      onCommentComposer: () => {
        openCommentComposer();
      },
      onSuggestionComposer: () => {
        openSuggestionComposer();
      },
      // Three-way apply hooks (attn-nnj.8.3). Read the verdict from the
      // store each time so we always operate on the currently-open card;
      // mirror the same accept/keep/edit-trigger/cancel semantics the
      // component implements.
      isApplyExpandOpen: () => reviewStore.activeThreeWayApply !== null,
      onAcceptApply: () => {
        const v = reviewStore.activeThreeWayApply;
        if (!v) return;
        void reviewAcceptSuggestion(v.roomId, v.suggestionId);
        reviewStore.clearThreeWayApply();
      },
      onKeepMine: () => {
        reviewStore.clearThreeWayApply();
      },
      onEditApply: () => {
        // The component owns the textarea; the global handler only needs
        // to ensure focus reaches the card. The Svelte component reads the
        // store and renders accordingly — we toggle a state flag exposed
        // through a separate path. For now, focusing the card via its
        // `data-testid` triggers the existing onkeydown to handle `e`.
        const card = document.querySelector<HTMLElement>(
          '[data-testid="three-way-apply-expand"]',
        );
        card?.focus();
      },
      onCancelApply: () => {
        reviewStore.clearThreeWayApply();
      },
    });
    return () => {
      cleanup();
    };
  });
</script>

{#snippet mainContent()}
  {#if showTabBar}
    <TabBar
      {tabs}
      {activeTabId}
      reviewUnreadCount={reviewStore.currentRoomUnread}
      onSwitch={switchTab}
      onClose={closeTab}
    />
  {/if}
  <div class="relative shrink-0">
    <PathBreadcrumb
      path={activePath}
      {rootPath}
      avoidWindowControls={!hasSidebar}
      fixed={!hasSidebar}
      topOffsetPx={34}
      rightInsetPx={showReviewChrome && reviewStore.railMode !== 'expanded'
        ? 328 - (hasSidebar ? RAIL_WIDTH_PX[reviewStore.railMode] : 0)
        : 16}
      onNavigate={(dir) => openPath(dir, inferFileTypeFromTree(dir))}
      onShare={showBreadcrumbShare ? openShareDialog : undefined}
      shareEnabled={showBreadcrumbShare}
      onOpenInBrowser={activeFileType === 'html' ? () => openExternal(activePath) : undefined}
    />
  </div>
  {#if !hasSidebar}
    <div class="h-[40px] shrink-0"></div>
  {/if}

  <ScrollArea
    class="attn-content-viewport min-h-0 flex-1 {isReviewerViewingSnapshot ? 'shared-doc-viewport' : ''}"
    orientation="vertical"
    bind:viewportRef={contentViewport}
  >

    {#if isReviewerWaiting}
      <!-- Reviewer joined a room but the owner's snapshot for the focused
           file hasn't landed yet. Show a clear waiting state instead of
           leaving them on whatever local file they had open. -->
      <div
        class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
        data-slot="reviewer-waiting"
      >
        <span class="inline-block size-3 animate-pulse rounded-full bg-primary/60" aria-hidden="true"></span>
        <p class="text-sm font-medium text-foreground">Connected to the shared room</p>
        <p class="text-sm opacity-75">Waiting for the shared document…</p>
      </div>
    {:else if isReviewerViewingHtmlSnapshot}
      <!-- Reviewer mode, HTML doc: render the owner's shared HTML snapshot
           read-only in a sandboxed iframe (srcdoc — the reviewer has no local
           file on disk). No editor, no collab, no comment anchors yet. -->
      <ReviewFileNav />
      <HtmlViewer content={reviewSnapshotContent ?? ''} />
    {:else if isReviewerViewingSnapshot}
      <!-- Reviewer mode: render the owner's shared snapshot. Read-only
           normally; during a live session collab makes it editable so the
           reviewer can co-type. The ReviewMargin overlay (right rail) still
           mounts so comments anchor against this content. -->
      <!-- Folder-share file switcher; self-gates to nothing for single-file shares. -->
      <ReviewFileNav />
      <Editor
        bind:this={editorRef}
        markdown={collabActive ? (collabSeedMarkdown || effectiveMarkdown) : effectiveMarkdown}
        editable={false}
        onLinkNavigate={handleEditorLinkNavigate}
        onSuggestionClick={handleSuggestionClick}
        onSave={saveEdits}
        onCancel={cancelEdit}
        onDirtyChange={handleEditorDirtyChange}
        plugins={editorPlugins}
        onReady={handleEditorReady}
        collabClientId={collabClientId ?? undefined}
        {collabEpoch}
        onCollabDocChange={handleCollabDocChange}
        onCollabSelectionChange={handleCollabSelectionChange}
        suggesting={false}
        suggestionAuthor={userProfile.effectiveName}
      />
    {:else if !hasActiveTab}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <p class="text-sm font-medium text-foreground">No file selected</p>
        {#if hasSidebar}
          <p class="text-sm opacity-75">Choose a file from the sidebar to begin.</p>
        {:else}
          <p class="text-sm opacity-75">Launch with a file or directory path, or open this app from a project folder.</p>
        {/if}
      </div>
    {:else if activeFileType === 'markdown'}
      <Editor
        bind:this={editorRef}
        markdown={collabActive ? (collabSeedMarkdown || effectiveMarkdown) : effectiveMarkdown}
        editable={(collabActive && collabRole === 'owner') || mode === 'edit'}
        onLinkNavigate={handleEditorLinkNavigate}
        onSuggestionClick={handleSuggestionClick}
        onSave={saveEdits}
        onCancel={cancelEdit}
        onDirtyChange={handleEditorDirtyChange}
        plugins={editorPlugins}
        onReady={handleEditorReady}
        collabClientId={collabClientId ?? undefined}
        {collabEpoch}
        onCollabDocChange={handleCollabDocChange}
        onCollabSelectionChange={handleCollabSelectionChange}
        suggesting={false}
        suggestionAuthor={userProfile.effectiveName}
      />
    {:else if activeFileType === 'image'}
      <ImageViewer src={markdownSourceUrl(activePath)} />
    {:else if activeFileType === 'video' || activeFileType === 'audio'}
      <MediaPlayer src={markdownSourceUrl(activePath)} fileType={activeFileType} />
    {:else if activeFileType === 'html'}
      <HtmlViewer path={activePath} mtime={htmlMtimeByPath.get(activePath)} />
    {:else if activeFileType === 'directory'}
      <DirectoryOverview
        path={activePath}
        {rootPath}
        entries={fileTree}
        onOpen={(path, fileType) => openPath(path, fileType)}
      />
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p>This file type is not supported for preview.</p>
        <p class="text-sm opacity-60">{activePath}</p>
      </div>
    {/if}
  </ScrollArea>
{/snippet}

{#snippet sharedDocBanner()}
  {#if isReviewerViewingSnapshot}
    <!--
      Shared-document banner. Keep this as quiet app chrome: it needs to
      distinguish reviewer mode from a local file without adding a hard color
      stripe through the reading surface. Rendered ABOVE the content+rail row
      (attn-42y) so it spans the full window width and the rail starts
      beneath it.
    -->
    <div
      class="shared-doc-banner flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/25 px-4 text-xs font-medium text-muted-foreground"
      data-slot="shared-doc-banner"
    >
      <Users class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="text-foreground/80">Shared document</span>
      <span class="text-muted-foreground/45" aria-hidden="true">·</span>
      <span class="font-normal text-muted-foreground">
        {collabActive && collabRole === 'owner' ? 'owner editing' : 'read-only'} · end-to-end encrypted
      </span>
    </div>
  {/if}
{/snippet}

{#snippet rightRailPlaceholder()}
  <!--
    Default right-rail content: mounts the Google-Docs-style margin overlay
    (attn-nnj.4.3). The margin renders its own empty state when no review
    threads exist for the active file, so this is the right level to mount
    it unconditionally.

    Callers that pass an explicit `rightRail` snippet prop override this
    (used by tests or alternative shells).
  -->
  <ReviewMargin view={pmViewForReview} />
{/snippet}

{#snippet reviewChrome()}
  <ReviewBar
    shareOpen={shareDialogOpen}
    isOwner={reviewStore.currentRoomId === null || collabRole === 'owner'}
    saveState={mode === 'edit' && activeFileType === 'markdown' ? (editorDirty ? 'dirty' : 'saved') : null}
    onShareClick={openShareDialog}
    onLeaveRoom={handleLeaveRoom}
  />
{/snippet}

{#snippet workspaceSidebar()}
  <Sidebar
    entries={fileTree}
    reviewMode={isReviewerInRoom}
    {activePath}
    {rootPath}
    {knownProjects}
    {activeProjectPath}
    remoteSearchQuery={sidebarSearchQuery}
    remoteSearchItems={sidebarSearchResults}
    outline={outlineHeadings}
    {activeOutlineId}
    {sharedPaths}
    onProjectSwitch={handleProjectSwitch}
    onNavigate={handleSidebarNavigate}
    onExpand={handleTreeExpand}
    onShare={openShareDialogForPath}
    onSearchQuery={handleSidebarSearchQuery}
    onOutlineNavigate={handleOutlineNavigate}
  />
{/snippet}

{#snippet workspaceRail()}
  {#if rightRail}
    {@render rightRail()}
  {:else}
    {@render rightRailPlaceholder()}
  {/if}
{/snippet}

{#snippet minimalDiagnosticContent()}
  <div class="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-foreground">
    <p class="mb-2 font-semibold">Diagnostic mode: minimal</p>
    <p class="mb-3 text-muted-foreground">Path: {activePath || '(none)'}</p>
    <pre class="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3">{rawMarkdown}</pre>
  </div>
{/snippet}

{#snippet editorOnlyContent()}
  <div class="min-h-0 flex-1 overflow-auto">
    {#if !hasActiveTab}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <p class="text-sm font-medium text-foreground">No file selected</p>
        <p class="text-sm opacity-75">Launch with a markdown file path for editor-only diagnostics.</p>
      </div>
    {:else if activeFileType === 'markdown'}
      <Editor
        bind:this={editorRef}
        markdown={rawMarkdown}
        editable={mode === 'edit'}
        onLinkNavigate={handleEditorLinkNavigate}
        onSuggestionClick={handleSuggestionClick}
        onSave={saveEdits}
        onCancel={cancelEdit}
        onDirtyChange={handleEditorDirtyChange}
        plugins={editorPlugins}
        onReady={handleEditorReady}
      />
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p>Editor-only mode supports markdown files.</p>
        <p class="text-sm opacity-60">{activePath}</p>
      </div>
    {/if}
  </div>
{/snippet}

{#if diagMode === 'minimal'}
  <main class="flex h-screen flex-col overflow-hidden">
    <div
      class="h-[46px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render minimalDiagnosticContent()}
  </main>
{:else if diagMode === 'editor_only'}
  <main class="flex h-screen flex-col overflow-hidden">
    <div
      class="h-[46px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render editorOnlyContent()}
  </main>
{:else if hasSidebar}
  <WorkspaceEditorFrame
    sidebar={workspaceSidebar}
    banner={sharedDocBanner}
    chrome={reviewChrome}
    content={mainContent}
    rail={workspaceRail}
    railMode={reviewStore.railMode}
    panelOpen={reviewStore.panelOpen}
    unreadCount={reviewStore.currentRoomUnread}
    onToggleRail={() => reviewStore.togglePanel()}
    onRailWheel={(deltaY) => {
      if (contentViewport) contentViewport.scrollTop += deltaY;
    }}
  />
{:else}
  <main class="relative flex h-screen flex-col overflow-hidden">
    {@render reviewChrome()}
    <div
      class="h-[34px] shrink-0"
      style="-webkit-user-select: none"
      role="button"
      aria-label="Drag window"
      tabindex="-1"
      onmousedown={dragWindow}
    ></div>
    {@render mainContent()}
  </main>
{/if}

<svelte:window
  onkeydown={(e) => { handleGlobalShortcutsHelpHotkey(e); handleGlobalRightRailHotkey(e); }}
  onfocus={() => { windowFocused = true; }}
  onblur={() => { windowFocused = false; }}
/>
<svelte:document
  onvisibilitychange={() => {
    documentVisible = document.visibilityState === 'visible';
  }}
/>
<KeyboardShortcutsDialog
  bind:open={shortcutsOpen}
  hasCommentComposer={true}
  hasSuggestionComposer={true}
  hasToggleReviewPanel={true}
/>
<ShareDialog
  bind:open={shareDialogOpen}
  filePath={shareTargetPath ?? activePath}
  existingInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.inviteUrl ?? '') : ''}
  existingBrowserInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.browserInviteUrl ?? '') : ''}
  existingViewInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.viewInviteUrl ?? '') : ''}
  existingSuggestInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.suggestInviteUrl ?? '') : ''}
  existingBrowserViewInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.browserViewInviteUrl ?? '') : ''}
  existingBrowserSuggestInviteUrl={shareTargetIsCurrent ? (reviewStore.currentShare?.browserSuggestInviteUrl ?? '') : ''}
  ownerSigningKey={shareTargetIsCurrent ? (reviewStore.currentShare?.ownerSigningKey ?? '') : ''}
  existingRoomId={shareTargetIsCurrent ? (reviewStore.currentShare?.roomId ?? null) : null}
  shareErrorMessage={reviewStore.lastError?.message ?? ''}
  onClearError={() => reviewStore.clearLastError()}
/>
<NamePrompt
  bind:open={namePromptOpen}
  suggestion={userProfile.suggestion}
  mode={namePromptMode}
  onConfirm={handleNameConfirm}
  onSkip={handleNameSkip}
/>
<ReviewApplyExpand />
{#if toolbarSelection && pmViewForReview && !commentComposer && !suggestionComposer && !activeSuggestion}
  <SelectionToolbar
    view={pmViewForReview}
    from={toolbarSelection.from}
    to={toolbarSelection.to}
    onComment={openCommentComposer}
    onSuggest={openSuggestionComposer}
    canSuggest={reviewStore.localGrantTier === 'suggest'}
  />
{/if}
{#if activeSuggestion && pmViewForReview && !commentComposer}
  <SuggestionPopover
    view={pmViewForReview}
    info={activeSuggestion}
    onAccept={acceptActiveSuggestion}
    onReject={rejectActiveSuggestion}
    onComment={commentOnActiveSuggestion}
  />
{/if}
{#if commentComposer}
  <CommentComposer
    view={commentComposer.view}
    from={commentComposer.from}
    to={commentComposer.to}
    anchorContext={commentComposer.anchorContext}
    roomId={commentComposer.roomId}
    onClose={closeCommentComposer}
    onSubmitted={collapseComposeSelection}
  />
{/if}

{#if suggestionComposer}
  <SuggestionComposer
    view={suggestionComposer.view}
    from={suggestionComposer.from}
    to={suggestionComposer.to}
    anchorContext={suggestionComposer.anchorContext}
    roomId={suggestionComposer.roomId}
    onClose={closeSuggestionComposer}
    onSubmit={() => collapseComposeSelection()}
  />
{/if}
<CommandPalette
  bind:open={commandPaletteOpen}
  {rootPath}
  remoteSearchQuery={commandPaletteSearchQuery}
  remoteSearchItems={commandPaletteSearchResults}
  commands={paletteCommands}
  onSearchQuery={handleCommandPaletteSearchQuery}
  onSelect={(path) => openPath(path, detectFileType(path))}
/>
<!-- closeButton: every toast (update nudge, file-changed, etc.) gets a
     dismiss ✕ instead of forcing the user to wait out the timeout. -->
<Toaster closeButton />
<ResidentSettings
  active={residentSettings.active}
  installed={residentSettings.installed}
  loaded={residentSettings.loaded}
  degraded={residentSettings.degraded}
  statusError={residentSettings.error}
  supported={residentSettings.supported}
  roomId={reviewStore.currentRoomId}
  notificationMuted={reviewStore.currentRoomNotificationMuted}
/>
