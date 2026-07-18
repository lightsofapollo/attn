<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import BottomSheet from './BottomSheet.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import NamePrompt from '../../lib/NamePrompt.svelte';
  import ShareSheet from './ShareSheet.svelte';
  import { userProfile } from '../../lib/profile.svelte';
  import CommandPalette, { type HostedCommand } from './CommandPalette.svelte';
  import { AutosaveController } from './autosave';
  import type { reviewStore as ReviewStoreInstance } from '../../lib/review/store.svelte';
  import { buildManifest, buildWorkspaceZip, triggerDownload, zipFileName } from './export-zip';
  import { expandPicked, toImportFiles } from './import-files';
  import { fileDrop, filesToPicked } from './file-drop';
  import { autofocus } from '../../lib/hosted/autofocus';
  import type {
    EditingSession,
    LocalCollabJoinHandle,
    LocalCollabJoinState,
    SaveState,
    StorageHealth,
    WorkspaceAppService,
    WorkspaceDetail,
    WorkspaceEntry,
    WorkspaceShareRequest,
  } from './types';
  import type EditorComponentType from '../../lib/Editor.svelte';
  import type ReviewMarginComponentType from '../../lib/ReviewMargin.svelte';
  import type ReviewApplyExpandComponentType from '../../lib/ReviewApplyExpand.svelte';
  import type HostedDesktopWorkspaceFrameType from './HostedDesktopWorkspaceFrame.svelte';
  import type { EditorBridge } from '../../lib/prosemirror/collab-session';
  import type { BrowserOwnerWorkspaceRuntimeState } from '../../lib/review/browser-owner-workspace-runtime';
  import { LEASE_CHANNEL_NAME, openBroadcastChannel } from '../../lib/tab-channels';
  import type { DeviceId, ParticipantId, RequiresThreeWayVerdict, Thread } from '../../lib/types';

  interface Props {
    service: WorkspaceAppService;
    workspace: WorkspaceDetail;
    activePath: string | undefined;
    /** Decoded head body when the active entry is Markdown; null otherwise. */
    bodyText?: string | null;
    isNewDraft?: boolean;
    /** Switch the active file in place (no reload). Provided by AppShell. */
    onSelectEntry?: (path: string) => void;
    /** Refresh the workspace after an entry-list change (no reload). */
    onWorkspaceChanged?: (openPath?: string) => Promise<void>;
    /** Every workspace on the desk, for the sidebar project switcher. */
    workspaces?: { id: string; name: string; sharing?: 'local-only' | 'shared' | 'backed-up' }[];
    /** Open another workspace (full navigation — sessions don't survive it). */
    onSwitchWorkspace?: (workspaceId: string) => void;
  }

  const {
    service,
    workspace,
    activePath,
    bodyText = null,
    isNewDraft = false,
    onSelectEntry,
    onWorkspaceChanged,
    workspaces = [],
    onSwitchWorkspace,
  }: Props = $props();

  const health: StorageHealth = $derived(service.storageHealth());
  const activeEntry = $derived(
    workspace.entries.find((entry) => entry.path === activePath) ?? workspace.entries[0],
  );
  let shareOpen = $state(false);
  let paletteOpen = $state(false);
  let filesSheetOpen = $state(false);
  let reviewSheetOpen = $state(false);
  let shareButton = $state<HTMLButtonElement | undefined>();
  let shareReturnFocus = $state<HTMLButtonElement | undefined>();
  let dockFilesButton = $state<HTMLButtonElement | undefined>();
  let dockReviewButton = $state<HTMLButtonElement | undefined>();
  let desktopLayout = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 901px)').matches,
  );
  // Reactive: resetting it on a later lease win must re-run the desktop
  // auto-edit effect (which short-circuits on this flag and would otherwise
  // never track another dependency again).
  let desktopEditRequested = $state(false);
  let HostedDesktopWorkspaceFrame = $state<typeof HostedDesktopWorkspaceFrameType | null>(null);

  $effect(() => {
    const query = window.matchMedia('(min-width: 901px)');
    const update = (): void => {
      untrack(() => {
        // The layout flip remounts the editor under the other branch. Capture
        // the live buffer first: the committed body can be a debounce behind,
        // and a remount seeded from it would roll back (and then re-commit)
        // stale text.
        if (query.matches !== desktopLayout && editorRef) {
          remountSeed = editorRef.getMarkdown();
          // Rotate the collab identity for the remount: the authority replays
          // the log onto the fresh v0 editor, and steps stamped with the OLD
          // id would be swallowed by prosemirror-collab as own-step
          // confirmations instead of being applied — silently dropping the
          // user's latest typing from their own document.
          if (collabClientId !== null) collabClientId = crypto.randomUUID();
        }
      });
      desktopLayout = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  $effect(() => {
    if (!desktopLayout || HostedDesktopWorkspaceFrame) return;
    untrack(() => {
      void import('./HostedDesktopWorkspaceFrame.svelte').then((module) => {
        HostedDesktopWorkspaceFrame = module.default;
      });
    });
  });

  // ————— editing (attn-7xl.3.3) —————
  // svelte-ignore state_referenced_locally — props seed the initial values.
  let displayText = $state<string | null>(bodyText);
  // Live buffer captured just before a same-file editor remount (layout flip).
  // Non-reactive on purpose: the remount render reads it once; a file switch
  // clears it. Collab remounts ignore it — they must re-seed from the collab
  // base (v0) and catch up by log replay.
  // svelte-ignore non_reactive_update
  let remountSeed: string | null = null;
  // svelte-ignore state_referenced_locally
  let saveState = $state<SaveState>(workspace.saveState);
  let editing = $state(false);
  let editDenied = $state(false);
  let editorLoading = $state(false);
  interface EditorExports {
    getMarkdown(): string;
    hasUnsavedChanges(): boolean;
    resetToMarkdown(nextMarkdown: string): void;
    commitSaved(): void;
    undoStep(): void;
    redoStep(): void;
    toggleBold(): void;
    toggleItalic(): void;
    toggleHeading(level: number): void;
    toggleBulletList(): void;
  }
  let EditorComponent = $state<typeof EditorComponentType | null>(null);
  let ReviewMarginComponent = $state<typeof ReviewMarginComponentType | null>(null);
  /** Lazy store handle — the review store belongs to the editor graph, and
   *  the app entry's static graph must never preload it (route-bundle gate). */
  let reviewStoreRef = $state<typeof ReviewStoreInstance | null>(null);
  let resolveAnchorFn = $state<typeof import('../../lib/review/resolver').resolveAnchor | null>(null);
  let requestDecorationsRebuild = $state<
    typeof import('../../lib/prosemirror/review-decorations').requestReviewDecorationsRebuild | null
  >(null);
  let ReviewApplyExpandComponent = $state<typeof ReviewApplyExpandComponentType | null>(null);
  let editorRef = $state<EditorExports | undefined>();
  let pmViewForReview = $state<EditorView | undefined>();
  // Watches every document change (onDirtyChange only fires on transitions).
  let changeWatcher = $state<unknown[]>([]);
  let session = $state<EditingSession | null>(null);
  let ownerState = $state<BrowserOwnerWorkspaceRuntimeState | null>(null);
  // Local multi-tab co-editing, follower role (attn-47r): a live wire to the
  // lease-holding tab's authorities. Non-null only while this tab is denied
  // the writer lease; becoming the owner closes it.
  let localJoin: LocalCollabJoinHandle | null = null;
  let joinState = $state<LocalCollabJoinState | null>(null);
  let unsubscribeJoin: (() => void) | null = null;
  const joinLive = $derived(joinState?.status === 'live' && !session);
  let collabSeed = $state<{ fileId: string; epoch: string; markdown: string } | null>(null);
  let collabClientId = $state<string | null>(null);
  let collabEpoch = $state(0);
  let readyCollabEpoch = $state(-1);
  let ownerSessionOpening: Promise<EditingSession | null> | null = null;
  let unsubscribeOwner: (() => void) | null = null;
  let collabSeedRequest = 0;
  let loadedCollabGenerationKey: string | null = null;
  let boundCollabKey: string | null = null;
  let autosave: AutosaveController | null = null;
  // Durable commits completed this session — observable for tests/status.
  let commitCount = $state(0);

  const durableReviewAvailable = $derived(
    ownerState?.roomId !== null
      && ownerState?.roomId !== undefined
      && ownerState.authority?.session?.authoringReady === true,
  );
  // Lease/authoring states only — plain share status ("Shared · relay")
  // moved into the ShareChip (desktop) and the masthead Share button
  // (mobile), so the save chip no longer duplicates it.
  const ownerRoomStatus = $derived.by(() => {
    if (joinLive) return 'Live · editing with another tab';
    const state = ownerState;
    if (!state) return null;
    if (state.leaseRole === 'passive') return 'Read-only tab';
    if (!state.roomId) return null;
    if (!state.liveEditingAvailable) return 'Live review paused';
    return null;
  });
  const sharingActive = $derived(
    ownerState?.roomId !== null && ownerState?.roomId !== undefined,
  );

  // ————— multi-file rail state (attn-7xl.3.4) —————
  let addingMarkdown = $state(false);
  let newMarkdownPath = $state('');
  let renamingEntry = $state(false);
  let renameEntryValue = $state('');
  let confirmingEntryDelete = $state(false);
  // Destructive entry actions bind to the path they were opened against.
  // Navigation clears them; the commit-time guard makes a raced switch a
  // no-op instead of renaming/deleting whichever file became active.
  let entryActionPath = $state<string | null>(null);
  let railError = $state<string | null>(null);
  let assetInput = $state<HTMLInputElement | undefined>();
  let previewUrl = $state<string | null>(null);

  // ————— iOS reader behaviors (attn-7xl.3.7) —————
  let canvasEl = $state<HTMLElement | undefined>();
  let lightboxOpen = $state(false);
  let lightboxTrigger: HTMLElement | null = null;

  // ————— mobile masthead + dock state —————
  let headerEl = $state<HTMLElement | undefined>();
  let headerScrolled = $state(false);
  let docTitle = $state('');
  let showDocTitle = $state(false);

  const reviewCount = $derived(
    ownerState?.roomId && reviewStoreRef
      ? reviewStoreRef.threadsForCurrentFile.length
      : workspace.reviewCards.length,
  );
  let badgePop = $state(false);
  let lastReviewCount = -1;
  $effect(() => {
    const count = reviewCount;
    if (lastReviewCount >= 0 && count > lastReviewCount) badgePop = true;
    lastReviewCount = count;
  });

  // Dock glyphs: 24-grid, 1.7 stroke, round joins — the same quiet line
  // vocabulary as the viewing-safely shield.
  const dockGlyphs: Record<string, string[]> = {
    files: [
      'M3.75 7.25a2 2 0 0 1 2-2h3.9a1 1 0 0 1 .77.36l1.56 1.89h6.27a2 2 0 0 1 2 2v7.25a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z',
    ],
    review: [
      'M4.75 7A2.25 2.25 0 0 1 7 4.75h10A2.25 2.25 0 0 1 19.25 7v6A2.25 2.25 0 0 1 17 15.25h-5.9l-3.35 3v-3H7A2.25 2.25 0 0 1 4.75 13z',
      'M8.5 8.9h7',
      'M8.5 11.6h4.6',
    ],
    edit: [
      'M14.4 5.65 18.35 9.6 8.85 19.1l-4.9 1.45a.35.35 0 0 1-.45-.45L4.95 15.2z',
      'M12.9 7.15l3.95 3.95',
    ],
    done: ['M5.25 12.75 10 17.4 18.75 7.4'],
    native: [
      'M10.5 5.75H7.75a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h8.5a2 2 0 0 0 2-2V13.5',
      'M14.5 4.75h4.75V9.5',
      'M19 5 12.5 11.5',
    ],
  };

  // Mobile masthead scroll behaviors: a reading-progress hairline written
  // straight to the header's style (scrolling never re-renders Svelte state),
  // a lifted shadow once scrolled, and the document's own h1 inking into the
  // title slot after its heading scrolls under the chrome (the iOS
  // large-title pattern). Purely cosmetic — no state depends on it.
  $effect(() => {
    const canvas = canvasEl;
    const header = headerEl;
    if (desktopLayout || !canvas || !header) return;
    void activePath; // retrack: a file switch resets title + progress
    const scroller = document.scrollingElement as HTMLElement;
    let ticking = false;
    const update = (): void => {
      ticking = false;
      const max = scroller.scrollHeight - scroller.clientHeight;
      // Short documents get no progress line: it only means something once
      // there is a real reading distance to cover.
      const progress = max > 160 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0;
      header.style.setProperty('--read-progress', progress.toFixed(4));
      headerScrolled = scroller.scrollTop > 4;
      const h1 = canvas.querySelector('h1');
      const text = h1?.textContent?.trim() ?? '';
      if (text !== docTitle) docTitle = text;
      showDocTitle =
        text.length > 0 &&
        h1 !== null &&
        h1.getBoundingClientRect().bottom <= header.getBoundingClientRect().bottom + 8;
    };
    const schedule = (): void => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  });

  // Per-workspace/file reading position: best-effort, explicit anchors win.
  const readPositionKey = $derived(
    `attn-read-pos:${workspace.id}:${activeEntry?.path ?? ''}`,
  );

  $effect(() => {
    const canvas = canvasEl;
    const key = readPositionKey;
    if (!canvas) return;
    // Mobile scrolls the page (iOS address-bar friendly); desktop scrolls the
    // canvas inside the pinned three-column layout.
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const scroller = mobile ? (document.scrollingElement as HTMLElement) : canvas;
    const listenTarget: EventTarget = mobile ? window : canvas;
    // The file body arrives asynchronously (IDB read, editor mount), so a
    // saved offset clamps against a still-short canvas on first apply. A
    // ResizeObserver re-applies it as the canvas grows until the target is
    // reached, the user scrolls, or the retry window closes.
    let restore: ResizeObserver | null = null;
    let restoreTimer = 0;
    let lastApplied = -1;
    const stopRestore = (): void => {
      restore?.disconnect();
      restore = null;
      if (restoreTimer) {
        window.clearTimeout(restoreTimer);
        restoreTimer = 0;
      }
    };

    if (window.location.hash.length <= 1) {
      let saved = 0;
      try {
        const v = Number(sessionStorage.getItem(key) ?? '');
        if (Number.isFinite(v) && v > 0) saved = v;
      } catch {
        // Session storage may be blocked; reading position is best-effort.
      }
      // The canvas survives in-place file switches, so a file with no saved
      // position must reset to the top — never inherit the previous file's
      // scroll offset.
      scroller.scrollTop = saved;
      lastApplied = scroller.scrollTop;
      if (saved > 0 && scroller.scrollTop < saved) {
        restore = new ResizeObserver(() => {
          scroller.scrollTop = saved;
          lastApplied = scroller.scrollTop;
          if (scroller.scrollTop >= saved - 1) stopRestore();
        });
        restore.observe(mobile ? document.body : (canvas.firstElementChild ?? canvas));
        restoreTimer = window.setTimeout(stopRestore, 3000);
      }
    }
    let ticking = false;
    const onScroll = (): void => {
      if (restore) {
        // Our re-applies echo back as scroll events; a user scroll diverges
        // from the last applied value and takes over.
        if (Math.abs(scroller.scrollTop - lastApplied) <= 1) return;
        stopRestore();
      }
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        try {
          sessionStorage.setItem(key, String(Math.round(scroller.scrollTop)));
        } catch {
          // best-effort
        }
      });
    };
    listenTarget.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      stopRestore();
      listenTarget.removeEventListener('scroll', onScroll);
    };
  });

  let lightboxClose = $state<HTMLButtonElement | undefined>();

  // ————— iOS editing (attn-7xl.3.5) —————
  // The formatting bar rides directly above the visual keyboard using
  // visualViewport, never a guessed keyboard height.
  let editBarOffset = $state(0);
  let renamingTitle = $state(false);
  let titleValue = $state('');

  $effect(() => {
    if (!editing) {
      editBarOffset = 0;
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = (): void => {
      editBarOffset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  });

  // Auto-name from the first H1 (Theme v2, attn-cjn): "Untitled" is a
  // transient state, not a permanent pile. Fires once per mount, after a
  // durable commit, and only while the workspace still has the default name;
  // the reactive detail object updates every name usage without a reload.
  let autoNameAttempted = false;
  async function maybeAutoNameFromHeading(text: string): Promise<void> {
    if (autoNameAttempted || workspace.name !== 'Untitled') return;
    const match = text.match(/^#\s+(.+)$/m);
    const heading = match?.[1]?.trim().replace(/[#*`_]/g, '').trim().slice(0, 80);
    if (!heading) return;
    autoNameAttempted = true;
    try {
      const { dedupeWorkspaceName } = await import('./import-files');
      const names = (await service.listWorkspaces())
        .filter((candidate) => candidate.id !== workspace.id)
        .map((candidate) => candidate.name);
      const next = dedupeWorkspaceName(heading, names);
      await service.renameWorkspace(workspace.id, next);
      // AppShell owns the workspace detail; let it re-read rather than
      // mutating the prop (ownership_invalid_mutation).
      await onWorkspaceChanged?.();
    } catch {
      // Transient failure — retry on a later commit.
      autoNameAttempted = false;
    }
  }

  // Transient inputs must not strand keyboard focus on <body> when cancelled:
  // return it to the sidebar control that owns the flow (the project picker
  // for workspace-level flows, the active tree row for entry renames).
  function focusSidebarAnchor(selector: string): void {
    queueMicrotask(() => document.querySelector<HTMLElement>(selector)?.focus());
  }

  async function commitTitleRename(): Promise<void> {
    renamingTitle = false;
    const next = titleValue.trim();
    if (next.length === 0 || next === workspace.name) return;
    try {
      await service.renameWorkspace(workspace.id, next);
      if (onWorkspaceChanged) await onWorkspaceChanged();
      else window.location.reload();
    } catch {
      // Rename failures surface on the next durable state read.
    }
  }

  /** Sheets must never stack under the keyboard: blur first (ios-ux §6). */
  function blurEditor(): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  $effect(() => {
    if (lightboxOpen) lightboxClose?.focus();
  });

  function openLightbox(event: MouseEvent): void {
    lightboxTrigger = event.currentTarget as HTMLElement;
    lightboxOpen = true;
  }

  function closeLightbox(): void {
    lightboxOpen = false;
    lightboxTrigger?.focus();
  }

  // Inline preview: decrypt safe raster bytes into a short-lived blob URL.
  $effect(() => {
    const entry = activeEntry;
    if (!entry || entry.presentation !== 'preview') {
      previewUrl = null;
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    void service.readEntryBytes(workspace.id, entry.path).then((result) => {
      if (!result || cancelled) return;
      const copy = new Uint8Array(result.bytes);
      const blob = new Blob([copy.buffer as ArrayBuffer], {
        type: result.mediaType ?? 'application/octet-stream',
      });
      url = URL.createObjectURL(blob);
      previewUrl = url;
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      previewUrl = null;
    };
  });

  async function createMarkdownFile(): Promise<void> {
    const raw = newMarkdownPath.trim();
    if (raw.length === 0) return;
    const path = /\.(?:md|markdown)$/iu.test(raw) ? raw : `${raw}.md`;
    railError = null;
    try {
      await service.createMarkdownEntry(workspace.id, path);
      if (onWorkspaceChanged) {
        newMarkdownPath = '';
        addingMarkdown = false;
        await onWorkspaceChanged(path);
      } else {
        window.location.assign(`/app/w/${workspace.id}/${path}`);
      }
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function importFiles(files: Iterable<File>): Promise<void> {
    railError = null;
    try {
      await service.addAssetFiles(workspace.id, toImportFiles(await expandPicked(await filesToPicked(files))));
      if (onWorkspaceChanged) await onWorkspaceChanged();
      else window.location.reload();
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    } finally {
      if (assetInput) assetInput.value = '';
    }
  }

  function onAssetsPicked(): void {
    const files = assetInput?.files;
    if (files && files.length > 0) void importFiles(Array.from(files));
  }

  async function commitEntryRename(): Promise<void> {
    const entry = activeEntry;
    const target = renameEntryValue.trim();
    renamingEntry = false;
    if (!entry || entry.path !== entryActionPath) return;
    entryActionPath = null;
    if (target.length === 0 || target === entry.path) return;
    railError = null;
    try {
      await service.renameEntry(workspace.id, entry.path, target);
      if (onWorkspaceChanged) await onWorkspaceChanged(target);
      else window.location.assign(`/app/w/${workspace.id}/${target}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function deleteActiveEntry(): Promise<void> {
    const entry = activeEntry;
    confirmingEntryDelete = false;
    if (!entry || entry.path !== entryActionPath) return;
    entryActionPath = null;
    railError = null;
    try {
      await service.deleteEntry(workspace.id, entry.path);
      if (onWorkspaceChanged) await onWorkspaceChanged();
      else window.location.assign(`/app/w/${workspace.id}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function downloadActiveEntry(): Promise<void> {
    const entry = activeEntry;
    if (!entry) return;
    const result = await service.readEntryBytes(workspace.id, entry.path);
    if (!result) return;
    const basename = entry.path.split('/').pop() ?? entry.path;
    triggerDownload(document, basename, result.bytes, result.mediaType);
  }

  async function exportZip(): Promise<void> {
    railError = null;
    try {
      const files = await service.exportWorkspace(workspace.id);
      const manifest = buildManifest(workspace.name, files, Date.now());
      const zip = await buildWorkspaceZip(files, manifest);
      triggerDownload(document, zipFileName(workspace.name), zip, 'application/zip');
      await service.markBackedUp(workspace.id);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  const canEdit = $derived(
    activeEntry?.presentation === 'editable' &&
      health.mode !== 'unavailable' &&
      health.mode !== 'quota-pressure',
  );

  // A Markdown entry that would normally be editable but whose device storage
  // mode blocks authoring — the honest "you can still read/review" state that
  // the iOS reader surfaces as a "Viewing safely" banner.
  const editingUnavailable = $derived(
    activeEntry?.presentation === 'editable' && !canEdit,
  );

  async function ensureEditorGraph(includeReview = false): Promise<void> {
    const imports: Promise<unknown>[] = [];
    if (!EditorComponent) {
      imports.push(Promise.all([
        import('../../lib/Editor.svelte'),
        import('prosemirror-state'),
        import('./desktop-editor-styles'),
        import('../../lib/prosemirror/review-decorations'),
      ]).then(([editorModule, pmState, , decorationsModule]) => {
        EditorComponent = editorModule.default;
        requestDecorationsRebuild = decorationsModule.requestReviewDecorationsRebuild;
        changeWatcher = [
          new pmState.Plugin({
            view: () => ({
              update: (view, prevState) => {
                if (!view.state.doc.eq(prevState.doc)) onEditorChanged();
              },
            }),
          }),
          // Inline anchor highlights for review threads (attn-o0d): the same
          // decoration layer the reviewer page installs. Inert until the
          // store holds resolved anchors for the current room/file.
          decorationsModule.reviewDecorationsPlugin(),
        ];
      }));
    }
    if (includeReview && (!ReviewMarginComponent || !ReviewApplyExpandComponent)) {
      imports.push(Promise.all([
        import('../../lib/ReviewMargin.svelte'),
        import('../../lib/ReviewApplyExpand.svelte'),
      ]).then(([marginModule, applyModule]) => {
        ReviewMarginComponent = marginModule.default;
        ReviewApplyExpandComponent = applyModule.default;
      }));
      imports.push(Promise.all([
        import('../../lib/review/store.svelte'),
        import('../../lib/review/resolver'),
      ]).then(([mod, resolverModule]) => {
        resolveAnchorFn = resolverModule.resolveAnchor;
        reviewStoreRef = mod.reviewStore;
      }));
    }
    await Promise.all(imports);
  }

  // Resolve every comment/suggestion anchor against the latest published
  // snapshot for the active file, exactly like the native shell does — the
  // margin cards and inline decorations have no positions without it
  // (attn-o0d: the owner document showed no highlight for anchored threads).
  $effect(() => {
    const store = reviewStoreRef;
    const resolve = resolveAnchorFn;
    if (!store || !resolve) return;
    const roomId = store.currentRoomId;
    const fileId = store.currentFileId;
    const events = store.events;
    if (!roomId || !fileId) return;
    const snaps = store.snapshots.filter(
      (s) => s.roomId === roomId && s.fileId === fileId && s.anchorIndex,
    );
    if (snaps.length === 0) return;
    const snapshot = snaps.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    if (!snapshot.anchorIndex || typeof snapshot.content !== 'string') return;
    untrack(() => {
      const ctx = {
        currentIndex: snapshot.anchorIndex!,
        currentMarkdownBytes: new TextEncoder().encode(snapshot.content as string),
        currentHash: snapshot.baseHash,
      };
      for (const event of events) {
        const body = event.body;
        const anchor =
          body.type === 'comment_created' || body.type === 'suggestion_created'
            ? body.anchor
            : null;
        if (!anchor) continue;
        if (store.anchorResolutions[event.meta.eventId]) continue;
        store.applyAnchorResolution({
          roomId,
          fileId,
          eventId: event.meta.eventId,
          resolved: resolve(anchor, ctx),
        });
      }
    });
  });

  // Keep the shared connection badge honest on the hosted owner. The store's
  // transport field is daemon-fed on native and nothing set it here, so the
  // ReviewBar chip sat on "Offline" while the header pill said Shared · Direct.
  $effect(() => {
    const store = reviewStoreRef;
    if (!store) return;
    const state = ownerState;
    const connection = state?.authority?.session?.connection
      ?? (state?.roomId ? 'mailbox' : 'offline');
    untrack(() => {
      store.connection = connection;
    });
  });

  // Feed the peer roster the same way (attn-sjz). Native gets peers from the
  // daemon's status/presence payloads; the hosted owner's authority session
  // exposes the registered device directory + live presence, and the store's
  // ParticipantJoined event log owns display names. The fingerprint guard
  // matters: ownerState republishes on every session tick, and blindly
  // assigning a fresh array would re-render PeerStrip/ShareChip each time.
  let lastPeerFingerprint = '';
  $effect(() => {
    const store = reviewStoreRef;
    if (!store) return;
    // Native presence semantics: the roster is who is here NOW (the daemon
    // deletes leavers from the roster). The session's device directory keeps
    // every registration ever made — ephemeral /s/ joiners mint a new device
    // per visit — so feeding it unfiltered piled up dead "away" rows.
    const sessionPeers = (ownerState?.authority?.session?.peers ?? []).filter((p) => p.online);
    void store.events; // re-resolve names when a ParticipantJoined arrives
    untrack(() => {
      const mapped = sessionPeers.map((peer) => {
        const resolved = store.displayNameFor(peer.participantId);
        const displayName =
          resolved === peer.participantId
            ? peer.kind === 'agent'
              ? 'Agent'
              : peer.kind === 'owner'
                ? 'Owner'
                : 'Reviewer'
            : resolved;
        return {
          participantId: peer.participantId as ParticipantId,
          deviceId: peer.deviceId as DeviceId,
          displayName,
          kind: peer.kind,
          online: peer.online,
        };
      });
      const fingerprint = mapped
        .map((p) => `${p.deviceId}:${p.online}:${p.displayName}:${p.kind}`)
        .join('|');
      if (fingerprint === lastPeerFingerprint) return;
      lastPeerFingerprint = fingerprint;
      store.peers = mapped;
    });
  });

  // ---------------------------------------------------------------------------
  // Owner display name (attn-sur). The genesis ParticipantJoined announces
  // this name to every reviewer, so confirm it when a room first exists —
  // and honor the ShareChip popover's Edit affordance, which sets
  // `userProfile.editRequested` (it was a dead button on the hosted shell).
  // ---------------------------------------------------------------------------

  let namePromptOpen = $state(false);
  let namePromptMode = $state<'onboard' | 'edit'>('onboard');
  let namePrompted = $state(false);

  $effect(() => {
    if (
      ownerState?.roomId &&
      !shareOpen && // never stack over the share sheet — ask after it closes
      !userProfile.isSet &&
      !namePrompted &&
      !namePromptOpen
    ) {
      namePrompted = true;
      namePromptMode = 'onboard';
      namePromptOpen = true;
    }
  });

  $effect(() => {
    if (userProfile.editRequested) {
      userProfile.editRequested = false;
      namePromptMode = 'edit';
      namePromptOpen = true;
    }
  });

  // Auto-expand the review rail the first time the room has UNRESOLVED
  // feedback (ports App.svelte's native rule). Without this the hosted
  // owner's rail sat in its collapsed 48px gutter and a reviewer's incoming
  // comment landed as a barely-visible avatar chip — feedback effectively
  // arrived invisibly. One-shot per room so a deliberate collapse sticks.
  let reviewRailAutoOpenedRoom: string | null = null;
  $effect(() => {
    const store = reviewStoreRef;
    if (!store) return;
    const roomId = store.currentRoomId;
    if (roomId === null) return;
    if (store.marginActiveThreadCount > 0 && reviewRailAutoOpenedRoom !== roomId) {
      reviewRailAutoOpenedRoom = roomId;
      if (!store.panelOpen) store.panelOpen = true;
    }
  });

  // Rebuild the inline decorations whenever resolutions, events, or the
  // focused thread change (mirrors the reviewer page's trigger).
  $effect(() => {
    const store = reviewStoreRef;
    if (!store) return;
    void store.anchorResolutions;
    void store.events;
    void store.focusEventId;
    const view = pmViewForReview;
    const rebuild = requestDecorationsRebuild;
    if (!view || !rebuild) return;
    rebuild(view);
  });

  function installOwnerSession(granted: EditingSession): void {
    session = granted;
    // A tab that was denied (read-only or live co-editing follower) and later
    // won the lease must re-enter the desktop editor-first posture — the
    // auto-edit latch below already fired and lost.
    desktopEditRequested = false;
    unsubscribeOwner?.();
    unsubscribeOwner = granted.subscribeOwner((state) => {
      ownerState = state;
      editDenied = state.leaseRole === 'passive';
      if (!state.writable) editing = false;
    });
    ensureAutosaveForActiveFile();
  }

  // (Re)create the autosave controller bound to the CURRENT active file. Called
  // on session install and on every in-place file switch, so autosave always
  // commits to the file on screen — never the previously open one.
  function ensureAutosaveForActiveFile(): void {
    const granted = session;
    const entry = activeEntry;
    if (!granted || entry?.presentation !== 'editable') return;
    autosave?.dispose();
    const path = entry.path;
    autosave = new AutosaveController({
      commit: async (text) => {
        await granted.commitText(path, text);
        commitCount += 1;
        displayText = text;
        void maybeAutoNameFromHeading(text);
        // Keep entry metadata (sizes, updated-at) current for the sidebar and
        // share sheet — a fresh draft otherwise advertises "0 B" until reload.
        void onWorkspaceChanged?.();
      },
      onState: (state) => (saveState = state),
    });
  }

  async function ensureOwnerSession(): Promise<EditingSession | null> {
    if (session) return session;
    if (ownerSessionOpening) return ownerSessionOpening;
    ownerSessionOpening = service.beginEditing(workspace.id).then(async (granted) => {
      if (!granted) {
        editDenied = true;
        ownerState = null;
        return null;
      }
      // Takeover while live co-editing: this editor holds the converged doc
      // (possibly ahead of the dead owner's last commit). Commit it BEFORE
      // any collab binding so the new hub's seed cache reads this exact
      // content — otherwise later joiners would seed from a stale base.
      if (
        joinState?.status === 'live'
        && editorRef
        && activeEntry?.presentation === 'editable'
      ) {
        try {
          await granted.commitText(activeEntry.path, editorRef.getMarkdown());
        } catch {
          // The head stays at the last owner commit; co-editing still starts.
        }
      }
      closeLocalJoin();
      installOwnerSession(granted);
      return granted;
    }).finally(() => {
      ownerSessionOpening = null;
    });
    return ownerSessionOpening;
  }

  function closeLocalJoin(): void {
    unsubscribeJoin?.();
    unsubscribeJoin = null;
    localJoin?.close();
    localJoin = null;
    joinState = null;
  }

  // Multi-tab auto-recovery: the passive (read-only) tab listens for the
  // owning tab releasing the workspace lease and re-attempts ownership, so the
  // "another tab is editing" banner clears on its own when the other tab
  // closes — delivering the banner's promise without a manual "Retry edit".
  $effect(() => {
    const wsId = workspace.id;
    const channel = openBroadcastChannel(LEASE_CHANNEL_NAME);
    if (!channel) return;
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as { workspaceId?: string; event?: string } | null;
      if (message?.workspaceId !== wsId || message.event !== 'released') return;
      // Re-attempt ownership; ensureOwnerSession is a no-op if we already hold it.
      untrack(() => { void ensureOwnerSession(); });
    };
    return () => channel.close();
  });

  // The doorbell above is best-effort: a tab that crashes — or whose pagehide
  // close never finishes its async release — leaves the lease dangling and
  // never broadcasts. The lease still expires (15s), so while denied, wait on
  // that exact deadline and re-attempt takeover; also re-attempt when this tab
  // regains focus, so returning to it clears the banner immediately.
  $effect(() => {
    const wsId = workspace.id;
    if (!editDenied) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = async (): Promise<void> => {
      const granted = await untrack(() => ensureOwnerSession());
      if (!disposed && !granted) armExpiryTimer();
    };
    const armExpiryTimer = (): void => {
      void service.peekWriterLease(wsId).then((expiresAt) => {
        if (disposed || timer !== null) return;
        const delayMs = Math.max(expiresAt === null ? 0 : expiresAt - Date.now(), 250);
        timer = setTimeout(() => {
          timer = null;
          void attempt();
        }, delayMs);
      });
    };
    const onFocus = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void attempt();
    };

    armExpiryTimer();
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  });

  // Local multi-tab co-editing (attn-47r), follower role: while another tab
  // holds the writer lease, join its authorities as a live CollabClient
  // instead of settling for the read-only mirror. The handle reconnects on
  // its own; becoming the owner (ensureOwnerSession) closes it.
  $effect(() => {
    const wsId = workspace.id;
    if (!editDenied || session) return;
    untrack(() => {
      if (localJoin) return;
      void service.joinLocalCollab(wsId).then((handle) => {
        if (!handle) return;
        // The deny may have resolved (owner takeover) while we connected.
        if (session || localJoin || workspace.id !== wsId) {
          handle.close();
          return;
        }
        localJoin = handle;
        unsubscribeJoin = handle.subscribe((state) => {
          joinState = state;
        });
      });
    });
  });

  // The hub left (owner tab closed or is transitioning): unbind the collab
  // editor and fall back to the read-only banner until the join reconnects
  // to a new generation or this tab wins the lease itself.
  $effect(() => {
    const state = joinState;
    if (session || state?.status !== 'connecting') return;
    untrack(() => {
      collabSeedRequest += 1;
      collabSeed = null;
      collabClientId = null;
      boundCollabKey = null;
      loadedCollabGenerationKey = null;
      collabEpoch += 1;
      editing = false;
    });
  });

  // Follower seed: fetch the authority's base for the active file whenever
  // the hub generation or the file changes, then remount the editor at v0.
  $effect(() => {
    const state = joinState;
    const entry = activeEntry;
    if (session || state?.status !== 'live' || entry?.presentation !== 'editable') return;
    const join = localJoin;
    if (!join) return;
    const generationKey = `join:${state.generation}:${entry.path}`;
    if (loadedCollabGenerationKey === generationKey) return;
    loadedCollabGenerationKey = generationKey;
    untrack(() => { void ensureEditorGraph(false); });
    const request = ++collabSeedRequest;
    void join.getSeed(entry.path).then((seed) => {
      if (
        request !== collabSeedRequest
        || joinState?.generation !== state.generation
        || activeEntry?.path !== entry.path
      ) return;
      if (!seed) {
        if (loadedCollabGenerationKey === generationKey) loadedCollabGenerationKey = null;
        return;
      }
      untrack(() => {
        collabSeed = seed;
        collabClientId = crypto.randomUUID();
        boundCollabKey = null;
        collabEpoch += 1;
        // Same editor-first posture as the owning desktop tab; mobile stays
        // reader-first and promotes through its Edit action.
        if (desktopLayout) editing = true;
      });
    });
  });

  // Follower binding: attach the freshly seeded (v0) editor to the join
  // controller, which resyncs the file's full step log from the hub.
  $effect(() => {
    const state = joinState;
    const seed = collabSeed;
    const view = pmViewForReview;
    const epoch = collabEpoch;
    if (session || state?.status !== 'live' || !seed || !view || readyCollabEpoch !== epoch) return;
    const controller = localJoin?.getController();
    if (!controller) return;
    const key = `join:${state.generation}:${seed.fileId}:${seed.epoch}:${epoch}`;
    if (boundCollabKey === key) return;
    const bridge: EditorBridge = {
      getState: () => view.state,
      apply: (transaction) => view.dispatch(transaction),
    };
    controller.setActiveFile(seed.fileId, bridge, seed.epoch);
    boundCollabKey = key;
  });

  // Desktop opens editor-first and therefore needs route authority up front.
  // Mobile is deliberately reader-first: merely opening a document must not
  // block a desktop writer in another tab. It asks for authority only when the
  // user explicitly taps Edit.
  // Teardown is keyed to the workspace ID VALUE alone — a $derived memoizes
  // by value, so neither a viewport flip nor a refreshed workspace detail
  // object (autosave commits re-read it for entry metadata) re-runs this
  // cleanup. Reading `workspace.id` directly would track the PROP identity:
  // every detail refresh then released the owner session mid-edit, and the
  // share room silently lost its host (attn-707).
  const sessionWorkspaceId = $derived(workspace.id);
  $effect(() => {
    void sessionWorkspaceId;
    return () => {
      unsubscribeOwner?.();
      unsubscribeOwner = null;
      autosave?.dispose();
      autosave = null;
      closeLocalJoin();
      void session?.release();
      session = null;
      ownerState = null;
    };
  });

  $effect(() => {
    void sessionWorkspaceId;
    if (desktopLayout) untrack(() => { void ensureOwnerSession(); });
  });

  $effect(() => {
    const currentSession = session;
    const state = ownerState;
    const entry = activeEntry;
    const collabHosted = Boolean(state && (state.roomId || state.localCollab));
    if (!currentSession || !state || !collabHosted || entry?.presentation !== 'editable') {
      // While joined as a local co-editing follower, the join effects own
      // the collab binding state — do not clear it from the owner path.
      if (joinState) return;
      loadedCollabGenerationKey = null;
      if (!collabHosted) {
        untrack(() => {
          collabSeedRequest += 1;
          collabSeed = null;
          collabClientId = null;
          boundCollabKey = null;
          collabEpoch += 1;
        });
      }
      return;
    }
    untrack(() => { void ensureEditorGraph(true); });
    if (!state.liveEditingAvailable) return;
    const generation = state.controllerGeneration;
    // The binding epoch rotates on every published-epoch transition (accepted
    // suggestions, the idle share republish). It must key the seed: an editor
    // left on the old epoch keeps hosting/broadcasting into a dead epoch that
    // room reviewers no longer follow.
    const bindingEpoch = state.bindings.find((binding) => binding.path === entry.path)?.epoch ?? 'unbound';
    const generationKey = `${generation}:${bindingEpoch}:${entry.path}`;
    if (loadedCollabGenerationKey === generationKey) return;
    loadedCollabGenerationKey = generationKey;
    const request = ++collabSeedRequest;
    void currentSession.getCollabSeed(entry.path).then((seed) => {
      if (
        request !== collabSeedRequest
        || ownerState?.controllerGeneration !== generation
        || activeEntry?.path !== entry.path
      ) return;
      collabSeed = seed;
      collabClientId = seed ? crypto.randomUUID() : null;
      boundCollabKey = null;
      collabEpoch += 1;
    }).catch((error) => {
      if (loadedCollabGenerationKey === generationKey) loadedCollabGenerationKey = null;
      railError = error instanceof Error ? error.message : String(error);
    });
  });

  $effect(() => {
    const currentSession = session;
    const state = ownerState;
    const seed = collabSeed;
    const view = pmViewForReview;
    const epoch = collabEpoch;
    if (
      !currentSession
      || !state?.liveEditingAvailable
      || !seed
      || !view
      || readyCollabEpoch !== epoch
    ) return;
    const controller = currentSession.getController();
    if (!controller) return;
    const key = `${state.controllerGeneration}:${seed.fileId}:${seed.epoch}:${epoch}`;
    if (boundCollabKey === key) return;
    const bridge: EditorBridge = {
      getState: () => view.state,
      apply: (transaction) => view.dispatch(transaction),
    };
    controller.setActiveFile(seed.fileId, bridge, seed.epoch);
    boundCollabKey = key;
  });

  async function enterEdit(): Promise<void> {
    if (editing || editorLoading || !activeEntry) return;
    const retryingDeniedLease = editDenied;
    editorLoading = true;
    editDenied = false;
    try {
      await ensureEditorGraph(ownerState?.roomId != null);
      let granted = await ensureOwnerSession();
      // Live local co-editing needs no lease: edit through the other tab's
      // authority instead of retrying for ownership.
      if (!granted && joinLive) {
        editing = true;
        return;
      }
      // Closing another tab releases its fenced IndexedDB lease
      // asynchronously. An explicit retry should absorb that brief handoff
      // instead of making the user click repeatedly.
      if (!granted && retryingDeniedLease) {
        for (let attempt = 0; attempt < 7 && !granted; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 150));
          granted = await ensureOwnerSession();
        }
      }
      if (!granted) {
        if (joinLive) {
          editing = true;
          return;
        }
        editDenied = true;
        return;
      }
      if (!granted.getOwnerState().writable) {
        editDenied = true;
        return;
      }
      editing = true;
    } finally {
      editorLoading = false;
    }
  }

  // Re-seed the reader/editor when the active file changes IN PLACE (no reload).
  // Depends only on the activePath/bodyText props, so live edits never trip it.
  // The editor DOM remounts via `{#key activeEntry.path}`; here we reset the
  // per-file script state (view text, edit mode, autosave binding).
  // svelte-ignore state_referenced_locally — seed the switch tracker with the
  // initial path; subsequent changes are observed inside the effect below.
  let lastActivePath = activePath;
  $effect(() => {
    const path = activePath;
    const body = bodyText;
    untrack(() => {
      displayText = body;
      if (path === lastActivePath) {
        // Same file, new body: another tab committed and AppShell re-read it
        // (follow mode). The mounted editor seeds `markdown` once, so push
        // the fresh document in — but never while this tab is editing or a
        // live collab binding owns the view.
        if (
          !editing
          && body !== null
          && editorRef
          && ownerState?.liveEditingAvailable !== true
          && !joinLive
        ) {
          editorRef.resetToMarkdown(body);
        }
        return;
      }
      lastActivePath = path;
      remountSeed = null;
      editing = false;
      desktopEditRequested = false;
      // A pending rename/delete opened on the previous file must not survive
      // the switch and operate on this one.
      renamingEntry = false;
      confirmingEntryDelete = false;
      entryActionPath = null;
      ensureAutosaveForActiveFile();
    });
  });

  // Mobile is reader-first, but it is still a rendered Markdown reader. Load
  // the shared document surface without granting editability; the Edit action
  // later promotes this same view after the owner lease is confirmed.
  $effect(() => {
    if (desktopLayout || activeEntry?.presentation !== 'editable' || EditorComponent) return;
    untrack(() => { void ensureEditorGraph(false); });
  });

  // Desktop browser authoring opens directly into the same editor-first
  // posture as native attn. Mobile intentionally remains reader-first and
  // enters editing only from its thumb dock.
  $effect(() => {
    if (
      !desktopLayout
      || desktopEditRequested
      || editing
      || editorLoading
      || !canEdit
      || ownerState?.leaseRole === 'passive'
    ) return;
    desktopEditRequested = true;
    untrack(() => { void enterEdit(); });
  });

  function onEditorChanged(): void {
    if (!editorRef || !autosave) return;
    // Defer the (potentially large) markdown serialization to the debounced
    // commit — running it per keystroke made typing latency scale with doc
    // size. `displayText` is refreshed on commit and on blur (exitEdit).
    autosave.noteChange(() => editorRef?.getMarkdown() ?? '');
  }

  function handleEditorReady(view: EditorView): void {
    // A same-file remount (layout flip) delivers a new view while the collab
    // binding key is unchanged. Clear it so the binding effect re-attaches the
    // controller to this view — the old bridge closed over a destroyed one.
    if (pmViewForReview !== undefined && pmViewForReview !== view) boundCollabKey = null;
    remountSeed = null;
    pmViewForReview = view;
    readyCollabEpoch = collabEpoch;
  }

  function activeCollabController() {
    if (session) {
      return ownerState?.liveEditingAvailable ? session.getController() : null;
    }
    return joinLive ? localJoin?.getController() ?? null : null;
  }

  function handleCollabDocChange(): void {
    activeCollabController()?.onLocalChange();
    onEditorChanged();
  }

  function handleCollabSelectionChange(head: number): void {
    activeCollabController()?.broadcastCursor(head);
  }

  async function acceptSuggestion(thread: Thread): Promise<unknown> {
    const currentSession = session;
    const entry = activeEntry;
    const root = thread.rootEvent.body;
    if (
      !currentSession
      || !entry
      || root.type !== 'suggestion_created'
      || !thread.resolvedAnchor
    ) throw new Error('Suggestion is not ready for owner review.');
    const result = await currentSession.acceptSuggestion({
      path: entry.path,
      suggestionId: root.suggestionId,
      operation: root.operation,
      resolvedAnchor: thread.resolvedAnchor,
    });
    if (result.status === 'needs_review' && result.verdict.kind === 'requires_three_way') {
      const { reviewStore } = await import('../../lib/review/store.svelte');
      reviewStore.openThreeWayApply(result.verdict);
    }
    return result;
  }

  async function rejectSuggestion(thread: Thread): Promise<unknown> {
    const currentSession = session;
    const entry = activeEntry;
    const root = thread.rootEvent.body;
    if (!currentSession || !entry || root.type !== 'suggestion_created') {
      throw new Error('Suggestion is not available.');
    }
    return currentSession.rejectSuggestion({
      path: entry.path,
      suggestionId: root.suggestionId,
    });
  }

  async function applyReviewedSuggestion(
    verdict: RequiresThreeWayVerdict,
    replacement: string,
  ): Promise<unknown> {
    const currentSession = session;
    const entry = activeEntry;
    if (!currentSession || !entry) throw new Error('Owner apply is unavailable.');
    return currentSession.applySuggestion({
      path: entry.path,
      suggestionId: verdict.suggestionId,
      replacement,
    });
  }

  async function replyToReview(anchor: import('../../lib/types').Anchor, body: string, threadId: string): Promise<void> {
    const currentSession = session;
    if (!currentSession) throw new Error('Review authoring is unavailable.');
    await currentSession.replyToComment(anchor, body, threadId);
  }

  async function resolveReview(threadId: string): Promise<void> {
    const currentSession = session;
    if (!currentSession) throw new Error('Review authoring is unavailable.');
    await currentSession.resolveComment(threadId);
  }

  // Surface mailbox/transport failures (attn-9ua): a dead owner session
  // previously showed an empty rail while the 400 hid in the console. The
  // encrypted mailbox is the product's core promise — its failures are
  // first-class UI.
  const reviewTransportError = $derived.by(() => {
    const authority = ownerState?.authority;
    if (authority?.session?.status === 'error') {
      return authority.session.error?.message
        ?? 'Couldn\u2019t reach your encrypted mailbox \u2014 review updates are paused.';
    }
    if (authority?.status === 'paused' && authority.pauseReason) return authority.pauseReason;
    return null;
  });

  async function retryReviewDelivery(): Promise<void> {
    const currentSession = session;
    if (!currentSession) return;
    railError = null;
    try {
      await currentSession.retryReviewOutbox();
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function exitEdit(): Promise<void> {
    if (!editing) return;
    if (editorRef) displayText = editorRef.getMarkdown();
    await autosave?.flush();
    editing = false;
  }

  // Flush on tab hide / page unload so no committed-looking text is lost.
  $effect(() => {
    const flush = (): void => {
      if (autosave?.dirty) void autosave.flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = (): void => {
      flush();
      // The route runtime owns pagehide lease cleanup. EditingSession.release
      // only exits the editor surface; it intentionally keeps route authority.
      void session?.release();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      flush();
      void session?.release();
    };
  });

  function entryHref(entry: WorkspaceEntry): string {
    return `/app/w/${workspace.id}/${entry.path}`;
  }

  /**
   * AppShell calls this before a back/forward (popstate) navigation swaps the
   * active file, so history navigation drains debounce-pending edits exactly
   * like an in-app tree switch does.
   */
  export async function flushPendingEdits(): Promise<void> {
    await autosave?.flush();
  }

  // Switch files in place (no page reload). Flush the current file's autosave
  // first so nothing is lost, then let AppShell swap activePath/bodyText.
  async function switchTo(path: string): Promise<void> {
    if (!path || path === activeEntry?.path) return;
    await autosave?.flush();
    if (onSelectEntry) onSelectEntry(path);
    else window.location.assign(`/app/w/${workspace.id}/${path}`);
  }

  function navigateDesktopTree(relativePath: string): void {
    void switchTo(relativePath);
  }

  // Tree context-menu Rename/Delete: switch to the target file (in place), then
  // open the existing footer rename input / delete confirm once it's active.
  // The pending flag + effect absorbs the async switch (activePath updates a
  // tick later via AppShell), so the UI opens against the right file.
  let pendingRename = $state<string | null>(null);
  let pendingDelete = $state<string | null>(null);
  async function requestTreeRename(relativePath: string): Promise<void> {
    if (relativePath !== activeEntry?.path) await switchTo(relativePath);
    pendingRename = relativePath;
  }
  async function requestTreeDelete(relativePath: string): Promise<void> {
    if (relativePath !== activeEntry?.path) await switchTo(relativePath);
    pendingDelete = relativePath;
  }
  $effect(() => {
    if (pendingRename && activeEntry?.path === pendingRename) {
      renameEntryValue = pendingRename;
      confirmingEntryDelete = false;
      entryActionPath = pendingRename;
      renamingEntry = true;
      pendingRename = null;
    }
  });
  $effect(() => {
    if (pendingDelete && activeEntry?.path === pendingDelete) {
      renamingEntry = false;
      entryActionPath = pendingDelete;
      confirmingEntryDelete = true;
      pendingDelete = null;
    }
  });

  function entryGlyph(entry: WorkspaceEntry): string {
    if (entry.presentation === 'editable') return '';
    return entry.presentation === 'preview' ? '▧ ' : '◇ ';
  }

  // Files-sheet grouping (attn-7xl / iOS parity): a monospace badge, the file
  // basename, a capability subtitle, and the size — grouped Markdown vs Assets.
  function entryBadge(entry: WorkspaceEntry): string {
    if (entry.kind === 'markdown') return 'MD';
    return entry.presentation === 'preview' ? 'IMG' : 'BIN';
  }
  function entryBasename(entry: WorkspaceEntry): string {
    return entry.path.split('/').pop() ?? entry.path;
  }
  function entrySubtitle(entry: WorkspaceEntry): string {
    if (entry.presentation === 'preview') return 'Preview inline';
    if (entry.presentation === 'download-only') return 'Download only';
    const slash = entry.path.lastIndexOf('/');
    return slash > 0 ? entry.path.slice(0, slash) : 'Markdown';
  }
  const markdownEntries = $derived(workspace.entries.filter((e) => e.kind === 'markdown'));
  const assetEntries = $derived(workspace.entries.filter((e) => e.kind === 'asset'));

  function openShare(trigger: HTMLButtonElement | undefined): void {
    blurEditor();
    filesSheetOpen = false;
    reviewSheetOpen = false;
    shareReturnFocus = trigger;
    shareOpen = true;
  }

  function closeShare(): void {
    shareOpen = false;
    const trigger = shareReturnFocus ?? shareButton;
    shareReturnFocus = undefined;
    // The pre-share breadcrumb icon unmounts while the sheet is open (the
    // ShareChip anchors it instead), so the captured trigger may be a
    // detached node by now — focus() on it silently no-ops and keyboard
    // focus strands at <body>. Wait for re-render, then focus the live
    // trigger: the original if it survived, else the chip / remounted icon.
    void tick().then(() => {
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      const fallback =
        document.querySelector<HTMLButtonElement>('[data-slot="share-chip"]') ??
        document.querySelector<HTMLButtonElement>('button[aria-label="Share for review"]');
      fallback?.focus();
    });
  }

  // ————— command palette (⌘K) —————
  const paletteCommands = $derived.by<HostedCommand[]>(() => {
    const cmds: HostedCommand[] = [
      { id: 'share', label: 'Share for review', keywords: 'invite link publish reviewer',
        run: () => openShare(shareButton) },
      { id: 'new', label: 'New Markdown file', keywords: 'create add document',
        // Open the sidebar name field (autofocused) — calling
        // createMarkdownFile() directly here would no-op on an empty name.
        run: () => { addingMarkdown = true; } },
      { id: 'rename-workspace', label: 'Rename workspace', keywords: 'title project name',
        run: () => { titleValue = workspace.name; renamingTitle = true; } },
      { id: 'export', label: 'Export workspace', hint: '.zip', keywords: 'download backup save',
        run: () => void exportZip() },
    ];
    // Desktop is editor-first (no Edit/Done mode); this command only matters
    // where editing hasn't started — mobile, or a denied/lost owner lease.
    if (canEdit && !editing) {
      cmds.push({ id: 'edit', label: 'Edit this document', keywords: 'write compose',
        run: () => void enterEdit() });
    }
    if (activeEntry) {
      cmds.push({ id: 'download', label: `Download ${activeEntry.path}`, hint: activeEntry.sizeLabel,
        keywords: 'save file export single', run: () => void downloadActiveEntry() });
    }
    for (const entry of workspace.entries) {
      if (entry.path === activeEntry?.path) continue;
      cmds.push({
        id: `open:${entry.path}`,
        label: `Open ${entry.path}`,
        hint: entry.sizeLabel,
        keywords: 'file jump go to',
        run: () => navigateDesktopTree(entry.path),
      });
    }
    return cmds;
  });

  function onGlobalKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.code === 'KeyK') {
      // Don't open the palette behind another modal (Share dialog, bottom
      // sheets, lightbox) — it would render under the backdrop and steal focus.
      if (shareOpen || filesSheetOpen || reviewSheetOpen || lightboxOpen) return;
      event.preventDefault();
      paletteOpen = !paletteOpen;
    }
  }

  // ————— arrival toasts (incoming review events) —————
  interface ArrivalToast {
    id: string;
    text: string;
    eventId: string;
  }
  let arrivalToasts = $state<ArrivalToast[]>([]);
  const seenReviewEventIds = new Set<string>();
  let toastsPrimed = false;
  let toastSeq = 0;

  function dismissToast(id: string): void {
    arrivalToasts = arrivalToasts.filter((t) => t.id !== id);
  }

  function pushToast(text: string, eventId: string): void {
    const id = `toast-${toastSeq++}`;
    arrivalToasts = [...arrivalToasts, { id, text, eventId }];
    setTimeout(() => dismissToast(id), 5200);
  }

  function openReviewFromToast(toast: ArrivalToast): void {
    dismissToast(toast.id);
    reviewStoreRef?.setFocusEventId(toast.eventId);
    if (desktopLayout) {
      if (reviewStoreRef) reviewStoreRef.panelOpen = true;
    } else {
      blurEditor();
      filesSheetOpen = false;
      reviewSheetOpen = true;
    }
  }

  // Detect newly-arrived comments/suggestions authored by someone other than
  // the local owner and surface a toast. Seeding walks EVERY file's threads
  // (store.threads), not just the open file's: priming against the current
  // file only would replay another file's whole history as "new" arrivals the
  // first time the user navigates to it. Toasts stay scoped to the open file.
  $effect(() => {
    const store = reviewStoreRef;
    if (!store) return;
    const currentEventIds = new Set<string>();
    for (const thread of store.threadsForCurrentFile) {
      for (const event of [thread.rootEvent, ...thread.replies]) {
        currentEventIds.add(event.meta.eventId);
      }
    }
    const ownerId = store.ownerParticipantId;
    const arrivals: { authorId: string; kind: 'comment' | 'suggestion'; eventId: string }[] = [];
    for (const thread of store.threads) {
      for (const event of [thread.rootEvent, ...thread.replies]) {
        const eventId = event.meta.eventId;
        if (seenReviewEventIds.has(eventId)) continue;
        seenReviewEventIds.add(eventId);
        if (!toastsPrimed) continue;
        if (event.meta.authorId === ownerId) continue;
        if (!currentEventIds.has(eventId)) continue;
        const kind = event.body.type === 'suggestion_created' ? 'suggestion' : 'comment';
        arrivals.push({ authorId: event.meta.authorId, kind, eventId });
      }
    }
    toastsPrimed = true;
    for (const arrival of arrivals) {
      const name = store.displayNameFor(arrival.authorId);
      pushToast(`${name} ${arrival.kind === 'suggestion' ? 'suggested an edit' : 'commented'}`, arrival.eventId);
    }
  });

  // Tapping an inline anchor marker (mobile reader) sets the store's focus
  // target; open the review sheet in response so the thread comes into view.
  let lastFocusForSheet: string | null = null;
  $effect(() => {
    const focus = reviewStoreRef?.focusEventId ?? null;
    if (focus === lastFocusForSheet) return;
    lastFocusForSheet = focus;
    if (!focus || desktopLayout || editing || reviewSheetOpen) return;
    blurEditor();
    filesSheetOpen = false;
    reviewSheetOpen = true;
  });

  async function inspectWorkspaceShare() {
    const granted = await ensureOwnerSession();
    if (!granted) return null;
    return granted.inspectShare();
  }

  async function createWorkspaceShare(request: WorkspaceShareRequest) {
    await autosave?.flush();
    const granted = await ensureOwnerSession();
    if (!granted) throw new Error('Another tab owns this workspace.');
    return granted.ensureShare(request);
  }

  async function stopWorkspaceShare(): Promise<void> {
    const granted = await ensureOwnerSession();
    if (!granted) throw new Error('Another tab owns this workspace.');
    await granted.stopShare();
  }

  function closeFilesSheet(): void {
    filesSheetOpen = false;
    dockFilesButton?.focus();
  }

  function closeReviewSheet(): void {
    reviewSheetOpen = false;
    dockReviewButton?.focus();
  }
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<CommandPalette bind:open={paletteOpen} commands={paletteCommands} />

<NamePrompt
  bind:open={namePromptOpen}
  suggestion={userProfile.suggestion}
  mode={namePromptMode}
  onConfirm={(name) => userProfile.save(name)}
/>

{#if arrivalToasts.length > 0}
  <div class="arrival-toasts" aria-live="polite">
    {#each arrivalToasts as toast (toast.id)}
      <div class="arrival-toast" role="status">
        <button class="arrival-toast-body" type="button" onclick={() => openReviewFromToast(toast)}>
          <span class="arrival-dot"></span>
          <span>{toast.text}</span>
        </button>
        <button class="arrival-toast-close" type="button" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>×</button>
      </div>
    {/each}
  </div>
{/if}

{#snippet documentSurface()}
  <div class:hosted-native-document={desktopLayout} class:writing-sheet={!desktopLayout}>
    {#if health.mode !== 'persistent' && health.mode !== 'best-effort'}
      <div class="hosted-document-banner">
        <DegradedBanner mode={health.mode} />
      </div>
    {/if}
    {#if editDenied && !joinLive}
      <div class="degraded-banner hosted-document-banner" role="status" data-degraded="lease-denied">
        <div>
          <strong>Another tab is editing this workspace.</strong>
          <p>Following its changes read-only — editing returns here when the other tab finishes.</p>
        </div>
        <div class="actions">
          <button class="button" type="button" disabled={editorLoading} onclick={() => void enterEdit()}>
            {editorLoading ? 'Opening…' : 'Retry edit'}
          </button>
        </div>
      </div>
    {/if}
    {#if ownerState?.status === 'error' && !ownerState.roomId}
      <!-- Share resume/publish failed with no room to fall back on (attn-dkr):
           a relay rejection here (expired room, storage cap) used to vanish —
           the ShareChip simply never appeared. Say it, with the actual reason. -->
      <div class="degraded-banner hosted-document-banner" role="alert" data-degraded="share-resume-failed">
        <div>
          <strong>Live sharing is unavailable.</strong>
          <p>
            {(ownerState.reason ?? 'The review room could not be reached.').replace(/[:\s]+$/u, '.')}
            Your document is safe on this device.
          </p>
        </div>
        <div class="actions">
          <button class="button" type="button" onclick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    {/if}
    {#if ownerState?.roomId && !ownerState.liveEditingAvailable}
      <div class="degraded-banner owner-authority-banner hosted-document-banner" role="status" data-degraded="owner-authority-paused">
        <div>
          <strong>Live review is paused.</strong>
          <p>{ownerState.reason ?? 'Your encrypted review remains readable while authority reconnects.'}</p>
        </div>
        {#if ownerState.authority?.session?.authoringError}
          <button class="button" type="button" onclick={() => void retryReviewDelivery()}>Retry delivery</button>
        {/if}
      </div>
    {/if}
    {#if activeEntry?.presentation === 'editable' && EditorComponent}
      <div
        class="hosted-editor-surface"
        class:hosted-mobile-reader={!desktopLayout}
        data-body-text="rendered"
      >
        {#key activeEntry?.path}
          <EditorComponent
            bind:this={editorRef}
            markdown={collabSeed?.markdown ?? remountSeed ?? bodyText ?? displayText ?? ''}
            editable={editing && (ownerState?.writable === true || joinLive)}
            plugins={changeWatcher as never}
            onReady={handleEditorReady}
            onCheckboxToggle={onEditorChanged}
            collabClientId={ownerState?.liveEditingAvailable || joinLive
              ? collabClientId ?? undefined
              : undefined}
            {collabEpoch}
            onCollabDocChange={handleCollabDocChange}
            onCollabSelectionChange={handleCollabSelectionChange}
          />
        {/key}
      </div>
    {:else if desktopLayout && activeEntry?.presentation === 'editable'}
      <div class="hosted-editor-loading" role="status">Opening editor…</div>
    {:else if isNewDraft && (displayText === null || displayText.length === 0)}
      <div class="eyebrow">New workspace</div>
      <h1>Untitled</h1>
      <p class="placeholder">Tap to start writing…</p>
    {:else if activeEntry && activeEntry.presentation !== 'editable'}
      <div class="eyebrow">
        {activeEntry.presentation === 'preview' ? 'Asset preview' : 'Download only'}
      </div>
      <h1>{activeEntry.path}</h1>
      {#if activeEntry.presentation === 'preview' && previewUrl}
        <button
          class="asset-image-button"
          type="button"
          aria-label={`View ${activeEntry.path} full screen`}
          onclick={openLightbox}
        >
          <img class="asset-image" src={previewUrl} alt={activeEntry.path} />
        </button>
      {:else}
        <div class="asset-preview">
          <strong>{activeEntry.path}</strong>
          {#if activeEntry.presentation === 'preview'}
            Decrypting preview… · {activeEntry.sizeLabel}
          {:else}
            This format is never executed here. Download it or open it in native attn ·
            {activeEntry.sizeLabel}
          {/if}
        </div>
        <div class="storage-actions">
          <button class="button" type="button" onclick={() => void downloadActiveEntry()}>
            Download
          </button>
        </div>
      {/if}
    {:else}
      <div class="eyebrow">Working draft</div>
      <h1>{workspace.name}</h1>
      {#if displayText !== null && displayText.length > 0}
        <div class="plain-md" data-body-text>{displayText}</div>
      {:else if displayText !== null}
        <p class="placeholder">Start writing…</p>
      {:else}
        <p class="placeholder">This entry has no Markdown body.</p>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet dockGlyph(paths: string[])}
  <svg class="dock-icon" viewBox="0 0 24 24" aria-hidden="true">
    {#each paths as d (d)}<path {d} />{/each}
  </svg>
{/snippet}

{#snippet desktopHeaderActions()}
  <div class="hosted-header-actions">
    <!-- Quiet chrome: workspace identity (and switching) lives in the sidebar
         project row; renaming lives in ⌘K and on the desk. The input appears
         here only while a rename is in flight. Desktop is editor-first (the
         auto-edit effect), so there is no Edit/Done mode toggle — the only
         edit affordance is the recovery path when the owner lease was denied. -->
    {#if renamingTitle}
      <input
        use:autofocus
        class="hosted-title-input"
        type="text"
        aria-label="Workspace title"
        bind:value={titleValue}
        onkeydown={(event) => {
          if (event.key === 'Enter') void commitTitleRename();
          if (event.key === 'Escape') {
            renamingTitle = false;
            focusSidebarAnchor('.sidebar-project-trigger');
          }
        }}
        onblur={() => { if (renamingTitle) void commitTitleRename(); }}
      />
    {/if}
    <span class="save-state hosted-save-state save-chip" data-save-state={saveState} data-commits={commitCount}>
      {ownerRoomStatus ?? saveState}
    </span>
  </div>
{/snippet}

{#snippet desktopSidebarFooter()}
  <!-- Resting state: a single drop target. Standing actions moved to where
       they belong — per-file Rename/Delete in the tree context menu, New
       Markdown / Export / Download in ⌘K. The inputs below appear only while
       one of those flows is in flight. -->
  <div class="hosted-sidebar-footer" aria-label="Add files">
    {#if renamingEntry && activeEntry}
      <input
        use:autofocus
        class="hosted-sidebar-input"
        type="text"
        aria-label="New path"
        bind:value={renameEntryValue}
        onkeydown={(event) => {
          if (event.key === 'Enter') void commitEntryRename();
          if (event.key === 'Escape') {
            renamingEntry = false;
            focusSidebarAnchor('[data-path][data-active="true"]');
          }
        }}
      />
    {:else if confirmingEntryDelete && activeEntry}
      <div class="hosted-delete-confirm" role="alertdialog" aria-label={`Delete ${activeEntry.path}?`}>
        <span>Delete {activeEntry.path}?</span>
        <div>
          <button type="button" onclick={() => (confirmingEntryDelete = false)}>Cancel</button>
          <button class="danger" type="button" onclick={() => void deleteActiveEntry()}>Delete file</button>
        </div>
      </div>
    {:else if addingMarkdown}
      <input
        use:autofocus
        class="hosted-sidebar-input"
        type="text"
        aria-label="New Markdown file path"
        placeholder="notes.md"
        bind:value={newMarkdownPath}
        onkeydown={(event) => {
          if (event.key === 'Enter') void createMarkdownFile();
          if (event.key === 'Escape') {
            addingMarkdown = false;
            focusSidebarAnchor('.sidebar-project-trigger');
          }
        }}
      />
    {:else}
      <button
        class="hosted-sidebar-dropzone"
        type="button"
        data-action="add-assets"
        onclick={() => assetInput?.click()}
      >
        <span class="hosted-dropzone-glyph" aria-hidden="true">⤓</span>
        <span class="hosted-dropzone-copy">Drop files anywhere<span class="hosted-dropzone-hint">or click to browse</span></span>
      </button>
    {/if}
    <input
      bind:this={assetInput}
      type="file"
      multiple
      class="sr-only"
      aria-hidden="true"
      tabindex="-1"
      onchange={() => void onAssetsPicked()}
    />
    {#if railError}
      <p class="hosted-sidebar-error" role="alert">{railError}</p>
    {/if}
  </div>
{/snippet}

{#snippet desktopRail()}
  {#if ownerState?.roomId && ReviewMarginComponent}
    {#if reviewTransportError}
      <div class="review-delivery-status" role="alert" data-slot="review-transport-error">
        <span>{reviewTransportError}</span>
        <button class="row-action" type="button" onclick={() => window.location.reload()}>
          Reconnect
        </button>
      </div>
    {/if}
    {#if ownerState.authority?.session?.authoringError}
      <div class="review-delivery-status" role="status">
        <span>{ownerState.authority.session.authoringError}</span>
        <button class="row-action" type="button" onclick={() => void retryReviewDelivery()}>Retry</button>
      </div>
    {/if}
    <ReviewMarginComponent
      view={pmViewForReview}
      readOnly={!ownerState.liveEditingAvailable}
      reviewerAuthoring={durableReviewAvailable}
      suggestionActions={ownerState.liveEditingAvailable
        ? { accept: acceptSuggestion, reject: rejectSuggestion }
        : {}}
      onResolveComment={resolveReview}
      onReplyComment={replyToReview}
    />
  {/if}
{/snippet}

{#if desktopLayout}
  <div
    class="hosted-desktop-editor"
    data-app-view="workspace"
    data-workspace-id={workspace.id}
    data-drop-label="Drop files to add to this workspace"
    use:fileDrop={{ onFiles: (files) => void importFiles(files) }}
  >
    {#if HostedDesktopWorkspaceFrame}
      <HostedDesktopWorkspaceFrame
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        entries={workspace.entries}
        {workspaces}
        {onSwitchWorkspace}
        onCreateWorkspace={() => window.location.assign('/app#new')}
        onRenameWorkspace={() => {
          titleValue = workspace.name;
          renamingTitle = true;
        }}
        onOpenDesk={() => window.location.assign('/app')}
        activeEntryPath={activeEntry?.path}
        {shareOpen}
        actions={desktopHeaderActions}
        footer={desktopSidebarFooter}
        content={documentSurface}
        rail={desktopRail}
        onNavigate={navigateDesktopTree}
        onShare={openShare}
        onRename={requestTreeRename}
        onDelete={requestTreeDelete}
        onViewport={(viewport) => (canvasEl = viewport ?? undefined)}
      />
    {:else}
      <div class="hosted-shell-loading" role="status">Opening workspace…</div>
    {/if}
  </div>
{:else}
<div class="editor-shell" data-app-view="workspace" data-workspace-id={workspace.id}>
  <header class="editor-top" bind:this={headerEl} class:is-scrolled={headerScrolled}>
    <div class="doc-name">
      {#if editing && renamingTitle}
        <input
          use:autofocus
          class="mobile-title-input"
          type="text"
          aria-label="Workspace title"
          bind:value={titleValue}
          onkeydown={(event) => {
            if (event.key === 'Enter') void commitTitleRename();
            if (event.key === 'Escape') renamingTitle = false;
          }}
          onblur={() => void commitTitleRename()}
        />
      {:else if editing}
        <button
          class="mobile-workspace-title"
          type="button"
          aria-label="Rename workspace"
          onclick={() => {
            titleValue = workspace.name;
            renamingTitle = true;
          }}
        >{workspace.name}</button>
      {:else}
        <!-- Crossfade stack: the workspace name at rest; the document's own
             h1 once its heading has scrolled under the chrome. Screen readers
             always get the stable workspace name. -->
        <span class="masthead-title" class:doc-active={showDocTitle}>
          <strong class="masthead-workspace">{workspace.name}</strong>
          <strong class="masthead-doc" aria-hidden="true">{docTitle}</strong>
        </span>
      {/if}
      <!-- Same precedence as the desktop chip: a live share outranks the
           local save state, so mobile doesn't claim "Saved on this device"
           while the document is shared. -->
      <span class="save-state save-chip" data-save-state={saveState} data-commits={commitCount}>{ownerRoomStatus ?? saveState}</span>
    </div>
    <div class="share-action">
      <!-- State-aware: once a review room is live the button carries the
           share status (dot + "Sharing") and reopens the sheet to manage. -->
      <button
        class="button primary"
        class:sharing={sharingActive}
        type="button"
        bind:this={shareButton}
        data-sharing={sharingActive}
        onclick={() => openShare(shareButton)}
      >
        {#if sharingActive}<span class="share-live-dot" aria-hidden="true"></span>{/if}
        {sharingActive ? 'Sharing' : 'Share'}
      </button>
    </div>
  </header>
  <!-- The constrained layout remains reader-first: one document column,
       thumb actions, and bottom sheets for files/review. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <main
    class="editor-canvas"
    bind:this={canvasEl}
    tabindex="0"
    aria-label="Document"
    data-drop-label="Drop files to add to this workspace"
    use:fileDrop={{ onFiles: (files) => void importFiles(files) }}
  >
    {#if editingUnavailable}
      <aside class="viewing-safely" role="status">
        <svg class="viewing-safely-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path d="M9.2 12l2 2 3.6-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div>
          <strong>Viewing safely.</strong>
          Editing is unavailable in this browser mode. You can still read, navigate files, review, export, or open native attn.
        </div>
      </aside>
    {/if}
    {@render documentSurface()}
  </main>
  <nav class="thumb-dock" aria-label="Document actions">
    <button
      type="button"
      aria-haspopup="dialog"
      bind:this={dockFilesButton}
      onclick={() => {
        blurEditor();
        filesSheetOpen = true;
      }}
    >
      {@render dockGlyph(dockGlyphs.files)}
      <span class="dock-label">Files</span>
    </button>
    <button
      type="button"
      aria-haspopup="dialog"
      bind:this={dockReviewButton}
      onclick={() => {
        blurEditor();
        reviewSheetOpen = true;
      }}
    >
      <span class="dock-icon-stack">
        {@render dockGlyph(dockGlyphs.review)}
        {#if reviewCount > 0}
          <span
            class="dock-badge"
            class:pop={badgePop}
            aria-hidden="true"
            onanimationend={() => (badgePop = false)}
          >{reviewCount}</span>
        {/if}
      </span>
      <span class="dock-label">Review<span class="sr-only"> · {reviewCount}</span></span>
    </button>
    {#if editing}
      <button type="button" onclick={() => void exitEdit()}>
        {@render dockGlyph(dockGlyphs.done)}
        <span class="dock-label">Done</span>
      </button>
    {:else if canEdit}
      <button type="button" disabled={editorLoading} onclick={() => void enterEdit()}>
        {@render dockGlyph(dockGlyphs.edit)}
        <span class="dock-label">{editDenied ? 'Retry edit' : 'Edit'}</span>
      </button>
    {:else}
      <!-- Editing is unavailable here; the reader stays first-class and the
           native app is the honest handoff (ios-ux.md §6). -->
      <a class="dock-link" href="/#native" data-action="open-native">
        {@render dockGlyph(dockGlyphs.native)}
        <span class="dock-label">Open native</span>
      </a>
    {/if}
    <!-- Share deliberately lives only in the masthead: it is the owner's
         rare, doc-level act, not a thumb-frequency action. -->
  </nav>
</div>
{/if}

{#if editing && !desktopLayout}
  <div class="edit-bar" style={`--kb-offset: ${editBarOffset}px`} role="toolbar" aria-label="Formatting">
    <button type="button" aria-label="Bold" onclick={() => editorRef?.toggleBold()}><strong>B</strong></button>
    <button type="button" aria-label="Italic" onclick={() => editorRef?.toggleItalic()}><em>I</em></button>
    <button type="button" aria-label="Heading" onclick={() => editorRef?.toggleHeading(2)}>H2</button>
    <button type="button" aria-label="Bullet list" onclick={() => editorRef?.toggleBulletList()}>••</button>
    <button type="button" aria-label="Undo" onclick={() => editorRef?.undoStep()}>↺</button>
    <button type="button" aria-label="Redo" onclick={() => editorRef?.redoStep()}>↻</button>
    <span class="edit-bar-state" data-save-state={saveState}>{saveState}</span>
  </div>
{/if}

{#if lightboxOpen && previewUrl && activeEntry}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label={`${activeEntry.path} full screen`}
    onclick={(event) => {
      if (event.target === event.currentTarget) closeLightbox();
    }}
    onkeydown={(event) => {
      if (event.key === 'Escape') closeLightbox();
    }}
  >
    <img src={previewUrl} alt={activeEntry.path} />
    <button class="button lightbox-close" type="button" bind:this={lightboxClose} onclick={closeLightbox}>
      Close
    </button>
  </div>
{/if}

{#if shareOpen}
  <ShareSheet
    {workspace}
    {activeEntry}
    {health}
    ownerStatus={ownerRoomStatus ?? undefined}
    onInspect={inspectWorkspaceShare}
    onCreate={createWorkspaceShare}
    onStop={stopWorkspaceShare}
    onclose={closeShare}
  />
{/if}

{#if filesSheetOpen}
  <BottomSheet
    title="Files"
    subtitle={`${markdownEntries.length} Markdown · ${assetEntries.length} ${assetEntries.length === 1 ? 'asset' : 'assets'}`}
    onclose={closeFilesSheet}
  >
    {#each [{ label: 'Markdown', items: markdownEntries }, { label: 'Assets', items: assetEntries }] as group (group.label)}
      {#if group.items.length > 0}
        <div class="file-group">
          <div class="file-group-label">{group.label}</div>
          <ul class="file-list">
            {#each group.items as entry (entry.path)}
              <li>
                <a
                  class="file-row"
                  class:asset={entry.presentation !== 'editable'}
                  class:active={entry.path === activeEntry?.path}
                  href={entryHref(entry)}
                  aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
                  onclick={(event) => {
                    // Plain left-click switches in place; modifier-clicks keep
                    // the native open-in-new-tab behavior.
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    closeFilesSheet();
                    void switchTo(entry.path);
                  }}
                >
                  <span class="file-badge">{entryBadge(entry)}</span>
                  <span class="file-row-name">
                    <strong>{entryBasename(entry)}</strong>
                    <small>{entrySubtitle(entry)}</small>
                  </span>
                  <span class="file-size">{entry.sizeLabel}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/each}
    <button class="file-add-row" type="button" onclick={() => assetInput?.click()}>
      ＋ Add file or asset
    </button>
    <input
      bind:this={assetInput}
      type="file"
      multiple
      accept=".md,.markdown,image/*,application/zip,.zip,*/*"
      style="display: none"
      aria-hidden="true"
      tabindex="-1"
      onchange={() => void onAssetsPicked()}
    />
  </BottomSheet>
{/if}

{#if reviewSheetOpen}
  <BottomSheet
    title={ownerState?.roomId && reviewStoreRef ? `Review · ${reviewStoreRef.threadsForCurrentFile.length}` : `Review · ${workspace.reviewCards.length}`}
    onclose={closeReviewSheet}
  >
    {#if ownerState?.roomId && ReviewMarginComponent}
      {#if reviewTransportError}
        <div class="review-delivery-status" role="alert" data-slot="review-transport-error">
          <span>{reviewTransportError}</span>
          <button class="row-action" type="button" onclick={() => window.location.reload()}>
            Reconnect
          </button>
        </div>
      {/if}
      <div class="review-sheet-margin">
        <ReviewMarginComponent
          view={pmViewForReview}
          layout="stacked"
          readOnly={!ownerState.liveEditingAvailable}
          reviewerAuthoring={durableReviewAvailable}
          suggestionActions={ownerState.liveEditingAvailable
            ? { accept: acceptSuggestion, reject: rejectSuggestion }
            : {}}
          onResolveComment={resolveReview}
          onReplyComment={replyToReview}
        />
      </div>
    {:else}
      {#each workspace.reviewCards as card (card.author + card.body)}
        <div class="review-card">
          <strong>{card.author} · {card.ageLabel}</strong>
          {card.body}
        </div>
      {:else}
        <p class="review-empty" style="margin-top: 0.5rem;">
          No review yet. Share this workspace to open an encrypted room around it.
        </p>
      {/each}
    {/if}
  </BottomSheet>
{/if}

{#if ownerState?.roomId && ReviewApplyExpandComponent}
  <ReviewApplyExpandComponent onApplySuggestion={applyReviewedSuggestion} />
{/if}
