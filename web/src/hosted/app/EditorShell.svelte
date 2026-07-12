<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import BottomSheet from './BottomSheet.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import ShareSheet from './ShareSheet.svelte';
  import { AutosaveController } from './autosave';
  import { buildManifest, buildWorkspaceZip, triggerDownload, zipFileName } from './export-zip';
  import { expandPicked, toImportFiles, type PickedFile } from './import-files';
  import type {
    EditingSession,
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
  import type { RequiresThreeWayVerdict, Thread } from '../../lib/types';

  interface Props {
    service: WorkspaceAppService;
    workspace: WorkspaceDetail;
    activePath: string | undefined;
    /** Decoded head body when the active entry is Markdown; null otherwise. */
    bodyText?: string | null;
    isNewDraft?: boolean;
  }

  const { service, workspace, activePath, bodyText = null, isNewDraft = false }: Props = $props();

  const health: StorageHealth = $derived(service.storageHealth());
  const activeEntry = $derived(
    workspace.entries.find((entry) => entry.path === activePath) ?? workspace.entries[0],
  );
  let shareOpen = $state(false);
  let filesSheetOpen = $state(false);
  let reviewSheetOpen = $state(false);
  let shareButton = $state<HTMLButtonElement | undefined>();
  let dockShareButton = $state<HTMLButtonElement | undefined>();
  let shareReturnFocus = $state<HTMLButtonElement | undefined>();
  let dockFilesButton = $state<HTMLButtonElement | undefined>();
  let dockReviewButton = $state<HTMLButtonElement | undefined>();
  let desktopLayout = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 901px)').matches,
  );
  let desktopEditRequested = $state(false);
  let HostedDesktopWorkspaceFrame = $state<typeof HostedDesktopWorkspaceFrameType | null>(null);

  $effect(() => {
    const query = window.matchMedia('(min-width: 901px)');
    const update = (): void => {
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
  // Workspace leases live for 15 seconds. A browser normally releases one on
  // pagehide, but WebKit may discard the closing document before that async
  // IndexedDB transaction completes. An explicit retry therefore spans one
  // full lease window plus scheduling grace; every attempt still goes through
  // the atomic fenced acquisition, so concurrent waiters elect one writer.
  const LEASE_HANDOFF_TIMEOUT_MS = 16_500;
  const LEASE_HANDOFF_INITIAL_DELAY_MS = 150;
  const LEASE_HANDOFF_MAX_DELAY_MS = 1_000;

  // svelte-ignore state_referenced_locally — props seed the initial values.
  let displayText = $state<string | null>(bodyText);
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
  let ReviewApplyExpandComponent = $state<typeof ReviewApplyExpandComponentType | null>(null);
  let editorRef = $state<EditorExports | undefined>();
  let pmViewForReview = $state<EditorView | undefined>();
  // Watches every document change (onDirtyChange only fires on transitions).
  let changeWatcher = $state<unknown[]>([]);
  let session = $state<EditingSession | null>(null);
  let ownerState = $state<BrowserOwnerWorkspaceRuntimeState | null>(null);
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
  const ownerRoomStatus = $derived.by(() => {
    const state = ownerState;
    if (!state) return null;
    if (state.leaseRole === 'passive') return 'Read-only tab';
    if (!state.roomId) return null;
    if (!state.liveEditingAvailable) return 'Live review paused';
    return state.authority?.session?.connection === 'live_direct'
      ? 'Shared · Direct'
      : 'Shared · Encrypted relay';
  });

  // ————— multi-file rail state (attn-7xl.3.4) —————
  let addingMarkdown = $state(false);
  let newMarkdownPath = $state('');
  let renamingEntry = $state(false);
  let renameEntryValue = $state('');
  let confirmingEntryDelete = $state(false);
  let railError = $state<string | null>(null);
  let assetInput = $state<HTMLInputElement | undefined>();
  let newMarkdownInput = $state<HTMLInputElement | undefined>();
  let newMarkdownButton = $state<HTMLButtonElement | undefined>();
  let renameEntryInput = $state<HTMLInputElement | undefined>();
  let renameEntryButton = $state<HTMLButtonElement | undefined>();
  let deleteEntryTrigger: HTMLButtonElement | null = null;
  let deleteCancelButton = $state<HTMLButtonElement | undefined>();
  let previewUrl = $state<string | null>(null);

  // ————— iOS reader behaviors (attn-7xl.3.7) —————
  let canvasEl = $state<HTMLElement | undefined>();
  let lightboxOpen = $state(false);
  let lightboxTrigger: HTMLElement | null = null;

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
    if (window.location.hash.length <= 1) {
      try {
        const saved = Number(sessionStorage.getItem(key) ?? '');
        if (Number.isFinite(saved) && saved > 0) scroller.scrollTop = saved;
      } catch {
        // Session storage may be blocked; reading position is best-effort.
      }
    }
    let ticking = false;
    const onScroll = (): void => {
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
    return () => listenTarget.removeEventListener('scroll', onScroll);
  });

  let lightboxClose = $state<HTMLButtonElement | undefined>();

  // ————— iOS editing (attn-7xl.3.5) —————
  // The formatting bar rides directly above the visual keyboard using
  // visualViewport, never a guessed keyboard height.
  let editBarOffset = $state(0);
  let renamingTitle = $state(false);
  let titleValue = $state('');
  let titleInput = $state<HTMLInputElement | undefined>();
  let titleButton = $state<HTMLButtonElement | undefined>();

  async function focusAndSelect(input: HTMLInputElement | undefined): Promise<void> {
    await tick();
    input?.focus();
    input?.select();
  }

  async function beginTitleRename(): Promise<void> {
    titleValue = workspace.name;
    renamingTitle = true;
    await tick();
    await focusAndSelect(titleInput);
  }

  async function cancelTitleRename(): Promise<void> {
    renamingTitle = false;
    await tick();
    titleButton?.focus();
  }

  async function beginEntryRename(): Promise<void> {
    renameEntryValue = activeEntry?.path ?? '';
    renamingEntry = true;
    await tick();
    await focusAndSelect(renameEntryInput);
  }

  async function cancelEntryRename(): Promise<void> {
    renamingEntry = false;
    await tick();
    renameEntryButton?.focus();
  }

  async function beginAddMarkdown(): Promise<void> {
    addingMarkdown = true;
    await tick();
    await focusAndSelect(newMarkdownInput);
  }

  async function cancelAddMarkdown(): Promise<void> {
    addingMarkdown = false;
    await tick();
    newMarkdownButton?.focus();
  }

  async function beginEntryDelete(trigger: HTMLButtonElement): Promise<void> {
    deleteEntryTrigger = trigger;
    confirmingEntryDelete = true;
    await tick();
    deleteCancelButton?.focus();
  }

  async function cancelEntryDelete(): Promise<void> {
    confirmingEntryDelete = false;
    await tick();
    deleteEntryTrigger?.focus();
  }

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

  async function commitTitleRename(): Promise<void> {
    renamingTitle = false;
    const next = titleValue.trim();
    if (next.length === 0 || next === workspace.name) return;
    try {
      if (!await flushPendingEditor()) return;
      await service.renameWorkspace(workspace.id, next);
      window.location.reload();
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
      if (!await flushPendingEditor()) return;
      await service.createMarkdownEntry(workspace.id, path);
      window.location.assign(`/app/w/${workspace.id}/${path}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function onAssetsPicked(): Promise<void> {
    const files = assetInput?.files;
    if (!files || files.length === 0) return;
    railError = null;
    try {
      const picked: PickedFile[] = [];
      for (const file of Array.from(files)) {
        picked.push({
          name: file.name,
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      if (!await flushPendingEditor()) return;
      await service.addAssetFiles(workspace.id, toImportFiles(await expandPicked(picked)));
      window.location.reload();
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    } finally {
      if (assetInput) assetInput.value = '';
    }
  }

  async function commitEntryRename(): Promise<void> {
    const entry = activeEntry;
    const target = renameEntryValue.trim();
    renamingEntry = false;
    if (!entry || target.length === 0 || target === entry.path) return;
    railError = null;
    try {
      if (!await flushPendingEditor()) return;
      await service.renameEntry(workspace.id, entry.path, target);
      window.location.assign(`/app/w/${workspace.id}/${target}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function deleteActiveEntry(): Promise<void> {
    const entry = activeEntry;
    confirmingEntryDelete = false;
    if (!entry) return;
    railError = null;
    try {
      if (!await flushPendingEditor()) return;
      await service.deleteEntry(workspace.id, entry.path);
      window.location.assign(`/app/w/${workspace.id}`);
    } catch (error) {
      railError = error instanceof Error ? error.message : String(error);
    }
  }

  async function downloadActiveEntry(): Promise<void> {
    const entry = activeEntry;
    if (!entry) return;
    if (!await flushPendingEditor()) return;
    const result = await service.readEntryBytes(workspace.id, entry.path);
    if (!result) return;
    const basename = entry.path.split('/').pop() ?? entry.path;
    triggerDownload(document, basename, result.bytes, result.mediaType);
  }

  async function exportZip(): Promise<void> {
    railError = null;
    try {
      if (!await flushPendingEditor()) return;
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

  async function ensureEditorGraph(includeReview = false): Promise<void> {
    const imports: Promise<unknown>[] = [];
    if (!EditorComponent) {
      imports.push(Promise.all([
        import('../../lib/Editor.svelte'),
        import('prosemirror-state'),
        import('./desktop-editor-styles'),
      ]).then(([editorModule, pmState]) => {
        EditorComponent = editorModule.default;
        changeWatcher = [
          new pmState.Plugin({
            view: () => ({
              update: (view, prevState) => {
                if (!view.state.doc.eq(prevState.doc)) onEditorChanged();
              },
            }),
          }),
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
    }
    await Promise.all(imports);
  }

  function installOwnerSession(granted: EditingSession): void {
    session = granted;
    unsubscribeOwner?.();
    unsubscribeOwner = granted.subscribeOwner((state) => {
      ownerState = state;
      editDenied = state.leaseRole === 'passive';
      if (!state.writable) editing = false;
    });
    if (!autosave && activeEntry?.presentation === 'editable') {
      const path = activeEntry.path;
      autosave = new AutosaveController({
        commit: async (text) => {
          await granted.commitText(path, text);
          commitCount += 1;
        },
        onState: (state) => (saveState = state),
      });
    }
  }

  async function ensureOwnerSession(): Promise<EditingSession | null> {
    if (session) return session;
    if (ownerSessionOpening) return ownerSessionOpening;
    ownerSessionOpening = service.beginEditing(workspace.id).then((granted) => {
      if (!granted) {
        editDenied = true;
        ownerState = null;
        return null;
      }
      installOwnerSession(granted);
      return granted;
    }).finally(() => {
      ownerSessionOpening = null;
    });
    return ownerSessionOpening;
  }

  // Desktop opens editor-first and therefore needs route authority up front.
  // Mobile is deliberately reader-first: merely opening a document must not
  // block a desktop writer in another tab. It asks for authority only when the
  // user explicitly taps Edit.
  $effect(() => {
    void workspace.id;
    if (desktopLayout) untrack(() => { void ensureOwnerSession(); });
    return () => {
      unsubscribeOwner?.();
      unsubscribeOwner = null;
      autosave?.dispose();
      autosave = null;
      void session?.release();
    };
  });

  $effect(() => {
    const currentSession = session;
    const state = ownerState;
    const entry = activeEntry;
    if (!currentSession || !state?.roomId || entry?.presentation !== 'editable') {
      loadedCollabGenerationKey = null;
      if (!state?.roomId) {
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
    const generationKey = `${generation}:${entry.path}`;
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
    // Keep the read-only explanation visible while a requested handoff waits
    // for WebKit's stale lease to expire. Initial edit attempts still start
    // without the banner and reveal it only when another writer is confirmed.
    if (!retryingDeniedLease) editDenied = false;
    try {
      await ensureEditorGraph(ownerState?.roomId != null);
      let granted = await ensureOwnerSession();
      // Closing another tab usually releases its fenced IndexedDB lease
      // immediately. WebKit can drop that cleanup transaction, so an explicit
      // retry also waits through the bounded expiry/election fallback.
      if (!granted && retryingDeniedLease) {
        const deadline = Date.now() + LEASE_HANDOFF_TIMEOUT_MS;
        let delay = LEASE_HANDOFF_INITIAL_DELAY_MS;
        while (!granted) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(delay, remaining)));
          granted = await ensureOwnerSession();
          delay = Math.min(LEASE_HANDOFF_MAX_DELAY_MS, delay * 2);
        }
      }
      if (!granted) {
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
    if (!desktopLayout) {
      desktopEditRequested = false;
      return;
    }
    if (
      desktopEditRequested
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
    const text = editorRef.getMarkdown();
    if (text === displayText) return;
    displayText = text;
    autosave.noteChange(text);
  }

  async function flushPendingEditor(): Promise<boolean> {
    // Pull directly from ProseMirror before every workspace operation. The
    // plugin normally observes the same transaction synchronously, but this
    // keeps the durability boundary correct for programmatic editor commands.
    onEditorChanged();
    const controller = autosave;
    if (!controller) return true;
    const committed = await controller.flush();
    if (!committed) {
      railError = 'Save the current document before continuing.';
    }
    return committed;
  }

  function handleEditorReady(view: EditorView): void {
    pmViewForReview = view;
    readyCollabEpoch = collabEpoch;
  }

  function handleCollabDocChange(): void {
    if (ownerState?.liveEditingAvailable) session?.getController()?.onLocalChange();
    onEditorChanged();
  }

  function handleCollabSelectionChange(head: number): void {
    if (ownerState?.liveEditingAvailable) session?.getController()?.broadcastCursor(head);
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
    if (!await flushPendingEditor()) return;
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
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!autosave?.dirty) return;
      flush();
      // IndexedDB durability cannot be completed after the document is torn
      // down. Keep the page in place (or show the browser's native warning)
      // until the pending revision has landed.
      event.preventDefault();
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      flush();
      void session?.release();
    };
  });

  function entryHref(entry: WorkspaceEntry): string {
    return `/app/w/${workspace.id}/${entry.path}`;
  }

  async function navigateDesktopTree(relativePath: string): Promise<void> {
    if (!relativePath || relativePath === activeEntry?.path) return;
    if (!await flushPendingEditor()) return;
    window.location.assign(`/app/w/${workspace.id}/${relativePath}`);
  }

  function entryGlyph(entry: WorkspaceEntry): string {
    if (entry.presentation === 'editable') return '';
    return entry.presentation === 'preview' ? '▧ ' : '◇ ';
  }

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
    queueMicrotask(() => trigger?.focus());
  }

  async function inspectWorkspaceShare() {
    const granted = await ensureOwnerSession();
    if (!granted) return null;
    return granted.inspectShare();
  }

  async function createWorkspaceShare(request: WorkspaceShareRequest) {
    if (!await flushPendingEditor()) {
      throw new Error('Save the current document before sharing.');
    }
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

{#snippet documentSurface()}
  <div
    class:hosted-native-document={desktopLayout}
    class:hosted-native-editor-document={desktopLayout && activeEntry?.presentation === 'editable'}
    class:writing-sheet={!desktopLayout}
  >
    {#if health.mode !== 'persistent' && health.mode !== 'best-effort'}
      <div class="hosted-document-banner">
        <DegradedBanner mode={health.mode} />
      </div>
    {/if}
    {#if editDenied}
      <div class="degraded-banner hosted-document-banner" role="status" data-degraded="lease-denied">
        <div>
          <strong>Another tab is editing this workspace.</strong>
          <p>This tab stays read-only until the other tab finishes or closes.</p>
        </div>
        {#if desktopLayout}
          <button
            class="hosted-header-button"
            type="button"
            disabled={editorLoading}
            onclick={() => void enterEdit()}
          >{editorLoading ? 'Waiting for tab…' : 'Retry edit'}</button>
        {/if}
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
        <EditorComponent
          bind:this={editorRef}
          markdown={collabSeed?.markdown ?? displayText ?? ''}
          editable={editing && ownerState?.writable !== false}
          plugins={changeWatcher as never}
          onReady={handleEditorReady}
          onCheckboxToggle={onEditorChanged}
          collabClientId={ownerState?.liveEditingAvailable
            ? collabClientId ?? undefined
            : undefined}
          {collabEpoch}
          onCollabDocChange={handleCollabDocChange}
          onCollabSelectionChange={handleCollabSelectionChange}
        />
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

{#snippet desktopHeaderActions()}
  <div class="hosted-header-actions">
    {#if renamingTitle}
      <input
        bind:this={titleInput}
        class="hosted-title-input"
        type="text"
        aria-label="Workspace title"
        bind:value={titleValue}
        onkeydown={(event) => {
          if (event.key === 'Enter') void commitTitleRename();
          if (event.key === 'Escape') void cancelTitleRename();
        }}
        onblur={() => void commitTitleRename()}
      />
    {:else}
      <button
        bind:this={titleButton}
        class="hosted-workspace-title"
        type="button"
        aria-label="Rename workspace"
        title="Rename workspace"
        onclick={() => void beginTitleRename()}
      >{workspace.name}</button>
    {/if}
    <span class="save-state hosted-save-state" data-save-state={saveState} data-commits={commitCount}>
      {ownerRoomStatus ?? saveState}
    </span>
  </div>
{/snippet}

{#snippet desktopSidebarFooter()}
  <div class="hosted-sidebar-footer" aria-label="Workspace actions">
    {#if activeEntry}
      <div class="hosted-entry-actions" aria-label={`Actions for ${activeEntry.path}`}>
        {#if renamingEntry}
          <input
            bind:this={renameEntryInput}
            class="hosted-sidebar-input"
            type="text"
            aria-label="New path"
            bind:value={renameEntryValue}
            onkeydown={(event) => {
              if (event.key === 'Enter') void commitEntryRename();
              if (event.key === 'Escape') void cancelEntryRename();
            }}
          />
        {:else}
          <button
            bind:this={renameEntryButton}
            type="button"
            onclick={() => void beginEntryRename()}
          >Rename</button>
          <button type="button" onclick={() => void downloadActiveEntry()}>Download</button>
          <button class="danger" type="button" onclick={(event) => void beginEntryDelete(event.currentTarget)}>Delete</button>
        {/if}
      </div>
      {#if confirmingEntryDelete}
        <div
          class="hosted-delete-confirm"
          role="alertdialog"
          tabindex="-1"
          aria-label={`Delete ${activeEntry.path}?`}
          onkeydown={(event) => {
            if (event.key === 'Escape') void cancelEntryDelete();
          }}
        >
          <span>Delete {activeEntry.path}?</span>
          <div>
            <button bind:this={deleteCancelButton} type="button" onclick={() => void cancelEntryDelete()}>Cancel</button>
            <button class="danger" type="button" onclick={() => void deleteActiveEntry()}>Delete file</button>
          </div>
        </div>
      {/if}
    {/if}
    {#if addingMarkdown}
      <input
        bind:this={newMarkdownInput}
        class="hosted-sidebar-input"
        type="text"
        aria-label="New Markdown file path"
        placeholder="notes.md"
        bind:value={newMarkdownPath}
        onkeydown={(event) => {
          if (event.key === 'Enter') void createMarkdownFile();
          if (event.key === 'Escape') void cancelAddMarkdown();
        }}
      />
    {:else}
      <button bind:this={newMarkdownButton} class="hosted-sidebar-action" type="button" data-action="new-markdown" onclick={() => void beginAddMarkdown()}>
        <span aria-hidden="true">＋</span>
        <span>New Markdown</span>
      </button>
    {/if}
    <button class="hosted-sidebar-action" type="button" data-action="add-assets" onclick={() => assetInput?.click()}>
      <span aria-hidden="true">↑</span>
      <span>Add files or assets</span>
    </button>
    <button class="hosted-sidebar-action" type="button" data-action="export-zip" onclick={() => void exportZip()}>
      <span aria-hidden="true">↓</span>
      <span>Export workspace</span>
    </button>
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
  <div class="hosted-desktop-editor" data-app-view="workspace" data-workspace-id={workspace.id}>
    {#if HostedDesktopWorkspaceFrame}
      <HostedDesktopWorkspaceFrame
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        entries={workspace.entries}
        activeEntryPath={activeEntry?.path}
        {shareOpen}
        actions={desktopHeaderActions}
        footer={desktopSidebarFooter}
        content={documentSurface}
        rail={desktopRail}
        onNavigate={navigateDesktopTree}
        onShare={openShare}
        onViewport={(viewport) => (canvasEl = viewport ?? undefined)}
      />
    {:else}
      <div class="hosted-shell-loading" role="status">Opening workspace…</div>
    {/if}
  </div>
{:else}
<div class="editor-shell" data-app-view="workspace" data-workspace-id={workspace.id}>
  <header class="editor-top">
    <div class="doc-name">
      {#if editing && renamingTitle}
        <input
          bind:this={titleInput}
          class="mobile-title-input"
          type="text"
          aria-label="Workspace title"
          bind:value={titleValue}
          onkeydown={(event) => {
            if (event.key === 'Enter') void commitTitleRename();
            if (event.key === 'Escape') void cancelTitleRename();
          }}
          onblur={() => void commitTitleRename()}
        />
      {:else if editing}
        <button
          bind:this={titleButton}
          class="mobile-workspace-title"
          type="button"
          aria-label="Rename workspace"
          onclick={() => void beginTitleRename()}
        >{workspace.name}</button>
      {:else}
        <strong>{workspace.name}</strong>
      {/if}
      <span class="save-state" data-save-state={saveState} data-commits={commitCount}>· {saveState}</span>
    </div>
    <div class="share-action">
      <button
        class="button primary"
        type="button"
        bind:this={shareButton}
        onclick={() => openShare(shareButton)}
      >
        Share
      </button>
    </div>
  </header>
  <!-- The constrained layout remains reader-first: one document column,
       thumb actions, and bottom sheets for files/review. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <main class="editor-canvas" bind:this={canvasEl} tabindex="0" aria-label="Document">
    {@render documentSurface()}
  </main>
  <nav class="thumb-dock" aria-label="Document actions">
    <button
      type="button"
      bind:this={dockFilesButton}
      onclick={() => {
        blurEditor();
        filesSheetOpen = true;
      }}
    >
      Files
    </button>
    <button
      type="button"
      bind:this={dockReviewButton}
      onclick={() => {
        blurEditor();
        reviewSheetOpen = true;
      }}
    >
      Review · {workspace.reviewCards.length}
    </button>
    {#if editing}
      <button type="button" onclick={() => void exitEdit()}>Done</button>
    {:else if canEdit}
      <button type="button" disabled={editorLoading} onclick={() => void enterEdit()}>{editorLoading && editDenied ? 'Waiting…' : editDenied ? 'Retry edit' : 'Edit'}</button>
    {:else}
      <!-- Editing is unavailable here; the reader stays first-class and the
           native app is the honest handoff (ios-ux.md §6). -->
      <a class="dock-link" href="/#native" data-action="open-native">Open native</a>
    {/if}
    <button
      type="button"
      bind:this={dockShareButton}
      onclick={() => openShare(dockShareButton)}
    >Share</button>
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
    onRequestPersist={() => service.requestPersistence()}
    onBackup={() => exportZip()}
  />
{/if}

{#if filesSheetOpen}
  <BottomSheet title={`Files · ${workspace.entries.length}`} onclose={closeFilesSheet}>
    <ul class="file-list">
      {#each workspace.entries as entry (entry.path)}
        <li>
          <a
            class="file"
            class:asset={entry.presentation !== 'editable'}
            class:active={entry.path === activeEntry?.path}
            href={entryHref(entry)}
            aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
            onclick={(event) => {
              if (entry.path === activeEntry?.path) return;
              event.preventDefault();
              void navigateDesktopTree(entry.path);
            }}
          >
            {entryGlyph(entry)}{entry.path}
            <span class="file-size">{entry.sizeLabel}</span>
          </a>
        </li>
      {/each}
    </ul>
  </BottomSheet>
{/if}

{#if reviewSheetOpen}
  <BottomSheet
    title={ownerState?.roomId ? 'Review' : `Review · ${workspace.reviewCards.length}`}
    onclose={closeReviewSheet}
  >
    {#if ownerState?.roomId && ReviewMarginComponent}
      <div class="review-sheet-margin">
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
