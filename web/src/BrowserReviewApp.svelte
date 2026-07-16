<!--
  BrowserReviewApp — top-level Svelte component for the hosted review surface
  (attn-nnj.9.4). Reviewer-only: NO ShareDialog, NO apply flow, NO sidebar /
  tabs / project switching. Just the editor + ReviewMargin.

  Lifecycle:
    1. `start()` boots a `BrowserSession`, which parses the invite + opens the
       encrypted WebSocket.
    2. While waiting for the first `SnapshotCreated` event we render a
       "Loading review…" state.
    3. Once the snapshot arrives, the editor mounts read-only at that
       authenticated epoch. Owner broadcasts keep it converged while durable
       comments and suggestions remain available independently.

  Error states map straight off `session.state.error.kind`:
    - invite_invalid    → "Invalid invite link"
    - admission_rejected → "Access denied"
    - room_deleted      → "Room deleted"
    - room_expired      → "Room expired"
    - cursor_too_old    → "Session expired — please re-open the invite"
    - device_register | network → "Could not reach the review relay"

  No emoji, no window.confirm/alert (per CLAUDE.md).
-->

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import { TextSelection, type Plugin as PMPlugin } from 'prosemirror-state';
  import { getVersion } from 'prosemirror-collab';
  import Editor from './lib/Editor.svelte';
  import HtmlViewer from './lib/HtmlViewer.svelte';
  import ReviewMargin from './lib/ReviewMargin.svelte';
  import BottomSheet from './hosted/app/BottomSheet.svelte';
  import ReviewFileNav from './lib/ReviewFileNav.svelte';
  import CommentComposer from './lib/CommentComposer.svelte';
  import SuggestionComposer from './lib/SuggestionComposer.svelte';
  import SelectionToolbar from './lib/SelectionToolbar.svelte';
  import OutboxIndicator from './lib/OutboxIndicator.svelte';
  import { reviewStore } from './lib/review/store.svelte';
  import {
    reviewDecorationsPlugin,
    requestReviewDecorationsRebuild,
  } from './lib/prosemirror/review-decorations';
  import {
    BrowserSession,
    type BrowserCollabDelivery,
    type BrowserSessionState,
  } from './lib/review/browser-session';
  import type { DurableShareBrowserSessionFacade, RememberedPushShareSessionFacade } from './lib/review/browser-share-production';
  import type { BrowserPushConsentState } from './lib/review/browser-push-consent';
  import { CollabController } from './lib/prosemirror/collab-controller';
  import type { EditorBridge } from './lib/prosemirror/collab-session';
  import { remoteCursorsKey } from './lib/prosemirror/remote-cursors';
  import {
    BrowserReviewerCollabGate,
    browserReviewerAvailability,
    browserReviewerViewMatchesEpoch,
    rememberAuthenticatedOwnerDevice,
    shouldDeferReviewerCollabReseed,
  } from './lib/review/browser-review-collab';
  import type { ParsedInvite } from './lib/review/browser-invite';
  import { hasTextSelection } from './lib/review/popover-anchor';
  import {
    recordReviewSelectionDebug,
    reviewSelectionDebugEnabled,
  } from './lib/review/selection-debug';
  import { resolveAnchor } from './lib/review/resolver';
  import type { ConstructAnchorContext } from './lib/review/anchors';
  import type { Anchor, FileId, RoomId, SuggestionDraft } from './lib/types';

  interface Props {
    /**
     * Optional pre-built session — tests inject one with a stubbed fetch +
     * WebSocketLike factory. Production callers leave this undefined and the
     * component constructs its own session from `window.location`.
     */
    session?: BrowserSession | DurableShareBrowserSessionFacade | RememberedPushShareSessionFacade;
    /** Forwarded to `BrowserSession` when `session` is not provided. */
    relayUrl?: string;
    /** Parsed synchronously by the hosted bootstrap before UI chunks load. */
    parsedInvite?: ParsedInvite;
    /** Parse failure captured by the narrow bootstrap. */
    inviteError?: string;
    /** Clean fragmentless `/review/:roomId` candidate for explicit recovery. */
    rememberedRoomId?: string;
  }

  let {
    session: injectedSession,
    relayUrl,
    parsedInvite,
    inviteError,
    rememberedRoomId,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Session boot.
  // ---------------------------------------------------------------------------

  let sessionState = $state<BrowserSessionState>({
    principal: 'reviewer',
    ownerOnline: false,
    liveEditingAvailable: false,
    status: 'idle',
    connection: 'offline',
    directError: null,
    roomId: null,
    snapshotContent: null,
    snapshotDocType: 'markdown',
    snapshotId: null,
    fileId: null,
    error: null,
    authoringReady: false,
    grantTier: 'suggest',
    outboxPending: 0,
    authoringError: null,
    persistence: 'ephemeral',
    storagePersisted: null,
    canRemember: true,
  });
  let collabSetupError = $state<string | null>(null);
  const authenticatedOwnerDeviceIds = new Set<string>();
  const reviewerCollabGate = new BrowserReviewerCollabGate((error) => {
    collabSetupError = error.message;
  });

  function handleSessionState(state: BrowserSessionState): void {
    sessionState = state;
  }

  // Automation/introspection counters for the reviewer collab pipeline —
  // consumed by staging E2E probes to localize a dark link (delivery →
  // gate → controller) without instrumenting encrypted transport.
  interface ReviewerCollabDebug { received: number; routed: number; bound: number; inbound: number; kinds: string[]; seeds: string[] }
  const collabDebug: ReviewerCollabDebug =
    ((window as unknown as { __attnReviewCollab?: ReviewerCollabDebug }).__attnReviewCollab ??=
      { received: 0, routed: 0, bound: 0, inbound: 0, kinds: [], seeds: [] });

  async function handleSessionCollab(delivery: BrowserCollabDelivery): Promise<void> {
    collabDebug.received += 1;
    // BrowserSession has already bound this immutable Device record to the
    // verified directory entry and envelope signature.
    rememberAuthenticatedOwnerDevice(authenticatedOwnerDeviceIds, delivery);
    await reviewerCollabGate.route(delivery);
    collabDebug.routed += 1;
  }

  // Capture once at construction — both props are stable for the lifetime of
  // the component, but the runes compiler can't infer that. `untrack` reads
  // the prop without registering it as a reactive dependency, avoiding the
  // `state_referenced_locally` warning at module-init scope.
  const initialInjected = untrack(() => injectedSession);
  const initialRelayUrl = untrack(() => relayUrl);
  const initialParsedInvite = untrack(() => parsedInvite);
  const initialInviteError = untrack(() => inviteError);
  const initialRememberedRoomId = untrack(() => rememberedRoomId);

  function buildSession(): BrowserSession | DurableShareBrowserSessionFacade | RememberedPushShareSessionFacade {
    if (initialInjected) return initialInjected;
    return new BrowserSession({
      relayUrl: initialRelayUrl,
      parsedInvite: initialParsedInvite,
      inviteError: initialInviteError,
      rememberedRoomId: initialRememberedRoomId,
      onState: handleSessionState,
      onCollab: handleSessionCollab,
    });
  }

  const session = buildSession();
  const collabCapable = 'sendCollab' in session && typeof session.sendCollab === 'function';
  const pushCapable = 'getPushConsentState' in session && 'setPushConsentObserver' in session &&
    'enablePushFromUserGesture' in session && 'disablePushFromUserGesture' in session;
  let pushConsent = $state<BrowserPushConsentState>({ status: pushCapable ? 'checking' : 'unsupported', message: null, enabled: false });
  // The hosted shell dedicates a permanent 320px rail to review threads, so
  // keep the shared margin in its expanded/card mode instead of the native
  // app's collapsed 48px avatar-gutter mode.
  reviewStore.panelOpen = true;

  // Phones get the document full-width; threads move behind a thumb control
  // that opens the same margin as a bottom sheet (attn-qez). Same 901px
  // breakpoint as the hosted owner shell.
  let desktopLayout = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 901px)').matches,
  );
  let mobileReviewOpen = $state(false);
  $effect(() => {
    const query = window.matchMedia('(min-width: 901px)');
    const update = (): void => {
      desktopLayout = query.matches;
      if (query.matches) mobileReviewOpen = false;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  // For injected sessions: bridge their state into ours. The test pattern is
  // to construct the session with an `onState` that updates a shared variable;
  // we also read the current state here so the initial render is correct.
  if (initialInjected) {
    if ('setStateObserver' in initialInjected) initialInjected.setStateObserver((next) => { sessionState = next; });
    // Durable /s/ sessions surface live collab through an observer instead of
    // a constructor option; wiring it makes owner edits stream into the view.
    if ('setCollabObserver' in initialInjected) initialInjected.setCollabObserver(handleSessionCollab);
    sessionState = initialInjected.getState();
  }
  if (pushCapable) {
    const durable = session as DurableShareBrowserSessionFacade;
    durable.setPushConsentObserver((next) => { pushConsent = next; });
  }

  void session.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const revoked = err instanceof Error && err.name === 'ShareGoneError';
    session.close();
    // start() should never throw — but if it does, surface a terminal error
    // so the UI is not stuck in `connecting`.
    sessionState = {
      ...sessionState,
      status: 'error',
      error: { kind: revoked ? 'share_revoked' : 'network', message },
    };
  });

  onDestroy(() => {
    reviewerCollabGate.close();
    if (!initialInjected || ('closeOnDestroy' in initialInjected && initialInjected.closeOnDestroy === true)) {
      session.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Editor + review margin wiring (mirrors App.svelte but stripped down).
  // ---------------------------------------------------------------------------

  const reviewPlugin: PMPlugin = reviewDecorationsPlugin();
  const editorPlugins: PMPlugin[] = [reviewPlugin];
  let pmViewForReview: EditorView | undefined = $state(undefined);

  function handleEditorReady(view: EditorView): void {
    pmViewForReview = view;
    reviewerCollabReadyEpoch = reviewerCollabEpoch;
    (window as unknown as { __attnPmView?: EditorView }).__attnPmView = view;
    traceReviewSelection('host-view-ready', {}, view);
    refreshSelectionToolbar();
  }

  onDestroy(() => {
    const target = window as unknown as { __attnPmView?: EditorView };
    if (target.__attnPmView === pmViewForReview) delete target.__attnPmView;
  });

  // Touch reactive store reads so Svelte schedules a rebuild whenever the
  // anchor resolution map, event log, or focus target changes. Hover is
  // deliberately NOT a dependency — `buildDecorations` never reads
  // `hoveredEventId` (hover is styled via CSS on `data-event-id`), so
  // including it dispatched a full DecorationSet rebuild on every mouseover
  // for a byte-identical result.
  $effect(() => {
    const resolutions = reviewStore.anchorResolutions;
    const events = reviewStore.events;
    const focusEventId = reviewStore.focusEventId;
    if (!pmViewForReview) return;
    untrack(() => traceReviewSelection('decorations-rebuild', {
      resolutionCount: Object.keys(resolutions).length,
      eventCount: events.length,
      focusEventId: focusEventId?.slice(0, 8) ?? null,
    }));
    requestReviewDecorationsRebuild(pmViewForReview);
  });

  // ---------------------------------------------------------------------------
  // Derived view state.
  // ---------------------------------------------------------------------------

  const displayedSnapshot = $derived.by(() => {
    const roomId = sessionState.roomId;
    const fileId = reviewStore.currentFileId ?? sessionState.fileId;
    if (!roomId || !fileId) return null;
    let latest = null;
    for (const snapshot of reviewStore.snapshots) {
      if (snapshot.roomId !== roomId || snapshot.fileId !== fileId || snapshot.content == null) {
        continue;
      }
      if (latest === null || snapshot.createdAt > latest.createdAt) latest = snapshot;
    }
    return latest;
  });

  const displayedContent = $derived(displayedSnapshot?.content ?? sessionState.snapshotContent);
  const displayedDocType = $derived(
    displayedSnapshot?.docType ?? sessionState.snapshotDocType,
  );

  $effect(() => {
    void sessionState.roomId;
    authenticatedOwnerDeviceIds.clear();
    return () => authenticatedOwnerDeviceIds.clear();
  });

  // -------------------------------------------------------------------------
  // Reviewer read-only convergence.
  //
  // Keep the collab plugin mounted while the owner is away so the editor's
  // confirmed version and any remote state survive presence blips. It never
  // grants document authority; durable comments/suggestions continue to use
  // BrowserSession's encrypted outbox independently.
  // -------------------------------------------------------------------------

  interface ReviewerCollabSeed {
    key: string;
    roomId: RoomId;
    fileId: FileId;
    snapshotId: string;
    markdown: string;
  }

  let reviewerCollabSeed = $state<ReviewerCollabSeed | null>(null);
  let reviewerCollabClientId = $state<string | null>(null);
  let reviewerCollabEpoch = $state(0);
  let reviewerCollabReadyEpoch = $state(-1);
  let reviewerCollabController = $state<CollabController | null>(null);
  let reviewerCollabBoundView: EditorView | undefined;
  let editorPointerSelecting = $state(false);
  let nextDebugViewId = 0;
  const debugViewIds = new WeakMap<EditorView, number>();

  function debugViewId(view: EditorView | undefined): number | null {
    if (!view) return null;
    const existing = debugViewIds.get(view);
    if (existing !== undefined) return existing;
    nextDebugViewId += 1;
    debugViewIds.set(view, nextDebugViewId);
    return nextDebugViewId;
  }

  function traceReviewSelection(
    kind: string,
    detail: Record<string, unknown> = {},
    explicitView?: EditorView,
  ): void {
    if (!reviewSelectionDebugEnabled()) return;
    // Debug reads must never become dependencies of whichever Svelte effect
    // happened to emit the trace; diagnostics should observe, not perturb.
    untrack(() => {
      const view = explicitView ?? pmViewForReview;
      const domSelection = window.getSelection();
      const editorScroller = document.querySelector<HTMLElement>('[data-slot="browser-review-editor"]');
      const marginScroller = document.querySelector<HTMLElement>('[data-slot="browser-review-margin"]');
      const active = document.activeElement as HTMLElement | null;
      const viewRect = view?.dom.getBoundingClientRect();
      recordReviewSelectionDebug(kind, {
        ...detail,
        viewId: debugViewId(view),
        epoch: reviewerCollabEpoch,
        readyEpoch: reviewerCollabReadyEpoch,
        seedSnapshot: reviewerCollabSeed?.snapshotId.slice(0, 8) ?? null,
        latestSnapshot: displayedSnapshot?.snapshotId.slice(0, 8) ?? null,
        pointerSelecting: editorPointerSelecting,
        pm: view ? {
          from: view.state.selection.from,
          to: view.state.selection.to,
          empty: view.state.selection.empty,
        } : null,
        dom: domSelection ? {
          ranges: domSelection.rangeCount,
          collapsed: domSelection.isCollapsed,
          anchorInEditor: Boolean(domSelection.anchorNode && view?.dom.contains(domSelection.anchorNode)),
          focusInEditor: Boolean(domSelection.focusNode && view?.dom.contains(domSelection.focusNode)),
        } : null,
        active: active ? {
          tag: active.tagName.toLowerCase(),
          slot: active.dataset.slot ?? null,
          class: active.className?.toString().slice(0, 80) ?? '',
        } : null,
        scroll: {
          editor: editorScroller?.scrollTop ?? null,
          margin: marginScroller?.scrollTop ?? null,
          window: window.scrollY,
        },
        viewRect: viewRect ? {
          top: Math.round(viewRect.top),
          height: Math.round(viewRect.height),
        } : null,
        focusEventId: reviewStore.focusEventId?.slice(0, 8) ?? null,
        toolbar: toolbarSelection !== null,
      });
    });
  }

  const reviewerAvailability = $derived.by(() => {
    const availability = browserReviewerAvailability({
      hasMarkdownSnapshot:
        collabCapable && reviewerCollabSeed !== null && displayedDocType === 'markdown',
      ownerOnline: sessionState.ownerOnline,
      liveEditingAvailable: sessionState.liveEditingAvailable,
      authoringReady: sessionState.authoringReady,
    });
    return {
      ...availability,
      liveEditing: availability.liveEditing && sessionState.grantTier === 'suggest',
      reviewAuthoring: availability.reviewAuthoring && sessionState.grantTier !== 'view',
    };
  });

  $effect(() => {
    const snapshot = displayedSnapshot;
    const roomId = sessionState.roomId;
    if (
      !collabCapable ||
      !roomId ||
      !snapshot ||
      snapshot.docType !== 'markdown' ||
      typeof snapshot.content !== 'string'
    ) {
      if (reviewerCollabSeed !== null) {
        reviewerCollabGate.reset();
        reviewerCollabSeed = null;
        reviewerCollabClientId = null;
        reviewerCollabController = null;
        reviewerCollabBoundView = undefined;
      }
      return;
    }
    const key = `${roomId}:${snapshot.fileId}:${snapshot.snapshotId}`;
    if (reviewerCollabSeed?.key === key) return;
    if (shouldDeferReviewerCollabReseed(
      editorPointerSelecting,
      reviewerCollabSeed?.fileId,
      snapshot.fileId,
    )) {
      untrack(() => traceReviewSelection('collab-reseed-deferred', {
        fromSnapshot: reviewerCollabSeed?.snapshotId.slice(0, 8) ?? null,
        toSnapshot: snapshot.snapshotId.slice(0, 8),
      }));
      return;
    }
    untrack(() => traceReviewSelection('collab-reseed', {
      fromSnapshot: reviewerCollabSeed?.snapshotId.slice(0, 8) ?? null,
      toSnapshot: snapshot.snapshotId.slice(0, 8),
      sameFile: reviewerCollabSeed?.fileId === snapshot.fileId,
    }));
    reviewerCollabGate.reset();
    reviewerCollabController = null;
    reviewerCollabSeed = {
      key,
      roomId,
      fileId: snapshot.fileId,
      snapshotId: snapshot.snapshotId,
      markdown: snapshot.content,
    };
    reviewerCollabClientId = crypto.randomUUID();
    reviewerCollabEpoch += 1;
    collabSetupError = null;
  });

  $effect(() => {
    const seed = reviewerCollabSeed;
    const clientId = reviewerCollabClientId;
    if (!collabCapable || !seed || !clientId || reviewerCollabController) return;
    reviewerCollabController = new CollabController({
      isOwner: false,
      send: (payload) => {
        if (!('sendCollab' in session)) {
          throw new Error('browser collaboration transport is unavailable');
        }
        return session.sendCollab(payload);
      },
      selfClientId: clientId,
      selfLabel: 'Reviewer',
      selfColor: '#4a7fa5',
      isAuthorityDevice: (deviceId) => authenticatedOwnerDeviceIds.has(deviceId),
      getLocation: () => ({
        fileId: seed.fileId,
        snapshotId: seed.snapshotId,
        path: displayedSnapshot?.ownerDisplayPath,
      }),
      onRemoteCursors: (cursors) => {
        const view = pmViewForReview;
        if (view) view.dispatch(view.state.tr.setMeta(remoteCursorsKey, cursors));
      },
    });
  });

  $effect(() => {
    const seed = reviewerCollabSeed;
    const controller = reviewerCollabController;
    const view = pmViewForReview;
    if (!seed || !controller || !view || view === reviewerCollabBoundView) return;
    if (!browserReviewerViewMatchesEpoch(reviewerCollabReadyEpoch, reviewerCollabEpoch)) return;
    if (!viewHasCollab(view)) return;
    const bridge: EditorBridge = {
      getState: () => view.state,
      apply: (transaction) => view.dispatch(transaction),
    };
    controller.setActiveFile(seed.fileId, bridge, seed.snapshotId);
    reviewerCollabBoundView = view;
    collabDebug.bound += 1;
    if (collabDebug.seeds.length < 20) collabDebug.seeds.push(`${seed.snapshotId.slice(0, 8)}:${seed.markdown.length}b`);
    reviewerCollabGate.bind((delivery) => {
      collabDebug.inbound += 1;
      try {
        const kind = (JSON.parse(delivery.payload) as { kind?: string; epoch?: string }).kind ?? '?';
        const epoch = (JSON.parse(delivery.payload) as { epoch?: string }).epoch?.slice(0, 8) ?? '';
        if (collabDebug.kinds.length < 60) collabDebug.kinds.push(`${kind}@${epoch}`);
      } catch { /* introspection only */ }
      controller.onInbound(delivery.payload, delivery.sender.deviceId);
    });
  });

  let previousCollabTransportAvailable = false;
  $effect(() => {
    const collabTransportAvailable =
      sessionState.ownerOnline &&
      sessionState.status === 'connected' &&
      sessionState.connection !== 'offline';
    const controller = reviewerCollabController;
    if (collabTransportAvailable && !previousCollabTransportAvailable) {
      controller?.onTransportConnected();
    }
    previousCollabTransportAvailable = collabTransportAvailable;
  });

  function viewHasCollab(view: EditorView): boolean {
    try {
      getVersion(view.state);
      return true;
    } catch {
      return false;
    }
  }

  function handleReviewerCollabDocChange(): void {
    // Owner broadcasts may update the rendered document, but reviewer
    // transactions are never submitted back into the authority.
    traceReviewSelection('collab-doc-change');
  }

  function handleReviewerCollabSelectionChange(head: number): void {
    traceReviewSelection('prosemirror-selection', { head });
    if (reviewerAvailability.collabReady) reviewerCollabController?.broadcastCursor(head);
  }

  // Resolve arrived and locally-authored anchors against the active snapshot.
  $effect(() => {
    const roomId = reviewStore.currentRoomId;
    const fileId = reviewStore.currentFileId;
    const events = reviewStore.events;
    if (!roomId || !fileId) return;
    const snapshots = reviewStore.snapshots.filter(
      (snapshot) =>
        snapshot.roomId === roomId && snapshot.fileId === fileId && snapshot.anchorIndex,
    );
    if (snapshots.length === 0) return;
    const snapshot = snapshots.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    if (!snapshot.anchorIndex || typeof snapshot.content !== 'string') return;
    const context = {
      currentIndex: snapshot.anchorIndex,
      currentMarkdownBytes: new TextEncoder().encode(snapshot.content),
      currentHash: snapshot.baseHash,
    };
    for (const event of events) {
      if (event.meta.roomId !== roomId) continue;
      const body = event.body;
      const anchor =
        body.type === 'comment_created' || body.type === 'suggestion_created'
          ? body.anchor
          : null;
      if (
        !anchor ||
        anchor.fileId !== fileId ||
        reviewStore.anchorResolutions[event.meta.eventId]
      ) continue;
      reviewStore.applyAnchorResolution({
        roomId,
        fileId,
        eventId: event.meta.eventId,
        resolved: resolveAnchor(anchor, context),
      });
    }
  });

  interface ComposerState {
    view: EditorView;
    from: number;
    to: number;
    roomId: RoomId;
    anchorContext: ConstructAnchorContext;
  }

  let commentComposer = $state<ComposerState | null>(null);
  let suggestionComposer = $state<ComposerState | null>(null);
  let toolbarSelection = $state<{ from: number; to: number } | null>(null);

  function activeSnapshotForCompose() {
    const snapshot = displayedSnapshot;
    if (!snapshot?.anchorIndex) return null;
    return snapshot;
  }

  function refreshSelectionToolbar(): void {
    const view = pmViewForReview;
    if (!reviewerAvailability.reviewAuthoring || !view || !hasTextSelection(view)) {
      if (toolbarSelection !== null) {
        toolbarSelection = null;
        traceReviewSelection('toolbar-selection-cleared');
      }
      return;
    }
    if (!activeSnapshotForCompose()) {
      if (toolbarSelection !== null) {
        toolbarSelection = null;
        traceReviewSelection('toolbar-selection-cleared-no-snapshot');
      }
      return;
    }
    const { from, to } = view.state.selection;
    if (toolbarSelection?.from === from && toolbarSelection.to === to) return;
    toolbarSelection = { from, to };
    traceReviewSelection('toolbar-selection-updated', { from, to });
  }

  $effect(() => {
    void reviewerAvailability.reviewAuthoring;
    refreshSelectionToolbar();
  });

  function openComposer(kind: 'comment' | 'suggestion'): void {
    if (sessionState.grantTier === 'view') return;
    if (kind === 'suggestion' && sessionState.grantTier !== 'suggest') return;
    const view = pmViewForReview;
    const roomId = sessionState.roomId;
    const snapshot = activeSnapshotForCompose();
    if (!view || !roomId || !snapshot?.anchorIndex || !hasTextSelection(view)) return;
    const state: ComposerState = {
      view,
      from: view.state.selection.from,
      to: view.state.selection.to,
      roomId,
      anchorContext: {
        index: snapshot.anchorIndex,
        fileId: snapshot.fileId,
        snapshotId: snapshot.snapshotId,
        baseHash: snapshot.baseHash,
      },
    };
    if (kind === 'comment') commentComposer = state;
    else suggestionComposer = state;
  }

  function collapseComposeSelection(): void {
    toolbarSelection = null;
    const view = pmViewForReview;
    const composerView = commentComposer?.view ?? suggestionComposer?.view;
    if (!view || (composerView && composerView !== view)) return;
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.to)));
    } catch {
      // The selection disappears with a view that is being replaced.
    }
  }

  async function createBrowserComment(anchor: Anchor, body: string): Promise<void> {
    await session.createComment(anchor, body);
  }

  async function createBrowserSuggestion(draft: SuggestionDraft): Promise<void> {
    await session.createSuggestion(draft);
  }

  async function replyBrowserComment(anchor: Anchor, body: string, threadId: string): Promise<void> {
    await session.replyToComment(anchor, body, threadId);
  }

  async function resolveBrowserComment(threadId: string): Promise<void> {
    await session.resolveComment(threadId);
  }

  async function rememberBrowserRoom(): Promise<void> {
    await session.rememberRoom();
  }

  async function forgetBrowserRoom(): Promise<void> {
    if (pushCapable && pushConsent.enabled) {
      await (session as DurableShareBrowserSessionFacade).disablePushFromUserGesture();
      if ((session as DurableShareBrowserSessionFacade).getPushConsentState().status !== 'off') return;
    }
    await session.forgetRoom();
  }

  async function togglePushConsent(): Promise<void> {
    if (!pushCapable) return;
    const durable = session as DurableShareBrowserSessionFacade;
    if (pushConsent.enabled) {
      await durable.disablePushFromUserGesture();
    } else {
      await durable.enablePushFromUserGesture();
    }
  }

  onMount(() => {
    let refreshRaf = 0;
    const scheduleRefresh = (): void => {
      if (refreshRaf) return;
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = 0;
        refreshSelectionToolbar();
        traceReviewSelection('selection-frame');
      });
    };
    const startsInEditor = (event: PointerEvent): boolean => {
      const target = event.target;
      return event.button === 0 && target instanceof Node && Boolean(pmViewForReview?.dom.contains(target));
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!startsInEditor(event)) return;
      editorPointerSelecting = true;
      traceReviewSelection('pointer-down', { x: Math.round(event.clientX), y: Math.round(event.clientY) });
    };
    const finishPointerSelection = (event: PointerEvent): void => {
      if (!editorPointerSelecting) return;
      traceReviewSelection(event.type === 'pointercancel' ? 'pointer-cancel' : 'pointer-up', {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      });
      editorPointerSelecting = false;
    };
    const handleScroll = (event: Event): void => {
      const view = pmViewForReview;
      if (!reviewSelectionDebugEnabled() || (!editorPointerSelecting && (!view || view.state.selection.empty))) return;
      const target = event.target as HTMLElement | Document | null;
      traceReviewSelection('scroll', {
        source: target instanceof HTMLElement
          ? target.dataset.slot ?? target.className?.toString().slice(0, 60) ?? target.tagName.toLowerCase()
          : 'document',
      });
    };
    // Browsers emit selectionchange for every incremental range while the
    // pointer is moving. Coalesce that burst to one Svelte update per frame;
    // SelectionToolbar owns scroll/resize re-anchoring once it is visible.
    document.addEventListener('selectionchange', scheduleRefresh);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', finishPointerSelection, true);
    document.addEventListener('pointercancel', finishPointerSelection, true);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('selectionchange', scheduleRefresh);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', finishPointerSelection, true);
      document.removeEventListener('pointercancel', finishPointerSelection, true);
      document.removeEventListener('scroll', handleScroll, true);
      if (refreshRaf) cancelAnimationFrame(refreshRaf);
    };
  });

  const isLoading = $derived(
    sessionState.status === 'idle' ||
      sessionState.status === 'parsing_invite' ||
      sessionState.status === 'registering_device' ||
      sessionState.status === 'connecting' ||
      (sessionState.status === 'connected' && displayedContent === null),
  );

  const errorMessage = $derived(formatError(sessionState.error));

  function formatError(err: BrowserSessionState['error']): string | null {
    if (!err) return null;
    switch (err.kind) {
      case 'invite_invalid':
        return 'Invalid invite link';
      case 'admission_rejected':
        return 'Access denied';
      case 'room_deleted':
        return 'This review room has been deleted';
      case 'room_expired':
        return 'This review room has expired';
      case 'cursor_too_old':
        return 'Session expired — please re-open the invite link';
      case 'share_revoked':
        return 'This review has ended';
      case 'device_register':
      case 'network':
      default:
        return 'Could not reach the review relay';
    }
  }
</script>

<main
  class="browser-review-shell flex h-screen flex-col overflow-hidden bg-background text-foreground"
  data-slot="browser-review"
  data-authoring-ready={sessionState.authoringReady ? 'true' : 'false'}
  data-outbox-pending={sessionState.outboxPending}
  data-connection={sessionState.connection}
  data-direct-error={sessionState.directError ?? ''}
  data-grant-tier={sessionState.grantTier}
  data-live-editing={reviewerAvailability.liveEditing ? 'true' : 'false'}
>
  {#if sessionState.error}
    <div class="browser-review-error flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-slot="browser-review-error"
      data-error-kind={sessionState.error.kind}>
      <p class="text-base font-medium text-foreground">{errorMessage}</p>
      <p class="text-sm text-muted-foreground">{sessionState.error.message}</p>
    </div>
  {:else if isLoading}
    <div class="browser-review-loading flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
      data-slot="browser-review-loading"
      data-status={sessionState.status}>
      <p class="text-sm">Loading review…</p>
    </div>
  {:else}
    <div class="browser-review-body flex min-h-0 flex-1 flex-row overflow-hidden">
      <div class="browser-review-editor-col flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Folder-share file switcher; renders nothing for single-file shares. -->
        <ReviewFileNav />
        <div
          class="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-1 text-xs text-muted-foreground"
          data-slot="browser-authoring-status"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-slot="browser-persistence-status">
            <span class="font-medium text-foreground" data-slot="browser-grant-tier">
              {sessionState.grantTier === 'view'
                ? 'View only'
                : sessionState.grantTier === 'comment'
                  ? 'Can comment'
                  : 'Can suggest'}
            </span>
            {#if sessionState.grantTier !== 'view' && !sessionState.canRemember}
              <span>{pushCapable && pushConsent.enabled ? 'Remembered for notifications' : 'Open from this link'}</span>
            {:else if sessionState.grantTier !== 'view' && sessionState.persistence === 'ephemeral'}
              <span>Temporary on this browser</span>
              <button
                type="button"
                class="rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted"
                data-slot="browser-remember-room"
                title="Store a non-extractable room key and encrypted recovery state in this browser profile"
                onclick={() => { void rememberBrowserRoom(); }}
              >
                Remember this room
              </button>
            {:else if sessionState.grantTier !== 'view' && sessionState.persistence === 'saving'}
              <span role="status">Securing local recovery…</span>
            {:else if sessionState.grantTier !== 'view'}
              <span>
                {sessionState.persistence === 'degraded'
                  ? 'Remembered; browser may evict local data'
                  : 'Remembered on this browser'}
              </span>
              <button
                type="button"
                class="rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted"
                data-slot="browser-forget-room"
                onclick={() => { void forgetBrowserRoom(); }}
              >
                Forget
              </button>
            {/if}
            {#if pushCapable && sessionState.grantTier !== 'view'}
              <span class="h-3 w-px bg-border" aria-hidden="true"></span>
              <button
                type="button"
                role="switch"
                aria-checked={pushConsent.enabled}
                aria-describedby={pushConsent.message ? 'browser-push-message' : undefined}
                class="rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                data-slot="browser-push-toggle"
                data-push-status={pushConsent.status}
                disabled={pushConsent.status === 'checking' || pushConsent.status === 'enabling' || pushConsent.status === 'disabling'}
                onclick={() => { void togglePushConsent(); }}
              >
                {pushConsent.status === 'on'
                  ? 'Notifications on'
                  : pushConsent.status === 'enabling'
                    ? 'Enabling notifications…'
                    : pushConsent.status === 'disabling'
                      ? 'Turning notifications off…'
                      : pushConsent.status === 'install_hint'
                        ? 'Install to enable notifications'
                        : pushConsent.enabled
                          ? 'Retry turning notifications off'
                        : 'Remember & notify me'}
              </button>
              {#if pushConsent.message}
                <span
                  id="browser-push-message"
                  class={pushConsent.status === 'error' || pushConsent.status === 'denied' ? 'text-destructive' : ''}
                  role="status"
                  data-slot="browser-push-message"
                >{pushConsent.message}</span>
              {/if}
            {/if}
          </div>
          <div class="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <span data-slot="browser-connection-status">
              {sessionState.connection === 'live_direct'
                ? 'Direct encrypted link'
                : sessionState.connection === 'direct_failed'
                  ? 'Direct unavailable; encrypted mailbox active'
                  : sessionState.connection === 'mailbox'
                    ? 'Encrypted mailbox'
                    : 'Offline'}
            </span>
            {#if reviewerAvailability.ownerStatus}
              <span data-slot="browser-owner-offline-status" role="status">
                {reviewerAvailability.ownerStatus}
              </span>
            {/if}
            {#if collabSetupError}
              <span class="text-destructive" data-slot="browser-collab-error" role="status">
                {collabSetupError}
              </span>
            {/if}
            {#if sessionState.grantTier !== 'view' && !sessionState.authoringReady}
              <span>Preparing encrypted authoring…</span>
            {/if}
            {#if sessionState.authoringError}
              <span class="text-destructive" role="status">{sessionState.authoringError}</span>
              <button
                type="button"
                class="rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted"
                onclick={() => { void session.retryOutbox(); }}
              >
                Retry
              </button>
            {/if}
            {#if sessionState.grantTier !== 'view'}
              <OutboxIndicator isOwner={false} onRetry={() => { void session.retryOutbox(); }} />
            {/if}
          </div>
        </div>
        <div class="browser-review-editor min-w-0 flex-1 overflow-auto"
          data-slot="browser-review-editor">
          {#if displayedDocType === 'html'}
            <!-- Read-only HTML doc: render received bytes in a sandboxed iframe.
                 No editor, no collab, no comment margin (yet). -->
            <HtmlViewer content={displayedContent ?? ''} allowScripts={false} />
          {:else}
            <Editor
              markdown={reviewerCollabSeed?.markdown ?? displayedContent ?? ''}
              editable={false}
              plugins={editorPlugins}
              onReady={handleEditorReady}
              collabClientId={reviewerAvailability.collabReady
                ? reviewerCollabClientId ?? undefined
                : undefined}
              collabEpoch={reviewerCollabEpoch}
              collabContinuityKey={reviewerCollabSeed?.fileId}
              onCollabDocChange={handleReviewerCollabDocChange}
              onCollabSelectionChange={handleReviewerCollabSelectionChange}
              suggesting={false}
              suggestionAuthor="Reviewer"
            />
          {/if}
        </div>
      </div>
      {#if displayedDocType !== 'html' && desktopLayout}
        <aside class="browser-review-margin w-[320px] shrink-0 overflow-y-auto border-l border-border bg-background"
          data-slot="browser-review-margin">
          <ReviewMargin
            view={pmViewForReview}
            readOnly={true}
            reviewerAuthoring={reviewerAvailability.reviewAuthoring}
            onResolveComment={resolveBrowserComment}
            onReplyComment={replyBrowserComment}
          />
        </aside>
      {/if}
    </div>
    {#if displayedDocType !== 'html' && !desktopLayout}
      <button
        type="button"
        class="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface-raised px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg"
        data-slot="browser-review-dock"
        onclick={() => (mobileReviewOpen = true)}
      >
        Review
        {#if reviewStore.marginActiveThreadCount > 0}
          <span class="rounded-full bg-primary px-1.5 py-0.5 text-xs font-bold leading-none text-primary-foreground">
            {reviewStore.marginActiveThreadCount}
          </span>
        {/if}
      </button>
      {#if mobileReviewOpen}
        <BottomSheet
          title="Review"
          subtitle={reviewStore.marginActiveThreadCount === 0
            ? 'Select any text to comment'
            : `${reviewStore.marginActiveThreadCount} open ${reviewStore.marginActiveThreadCount === 1 ? 'thread' : 'threads'}`}
          onclose={() => (mobileReviewOpen = false)}
        >
          <div class="review-sheet-margin">
            <ReviewMargin
              view={pmViewForReview}
              readOnly={true}
              reviewerAuthoring={reviewerAvailability.reviewAuthoring}
              onResolveComment={resolveBrowserComment}
              onReplyComment={replyBrowserComment}
            />
          </div>
        </BottomSheet>
      {/if}
    {/if}
  {/if}
</main>

{#if toolbarSelection && pmViewForReview && !commentComposer && !suggestionComposer}
  <SelectionToolbar
    view={pmViewForReview}
    from={toolbarSelection.from}
    to={toolbarSelection.to}
    onComment={() => openComposer('comment')}
    onSuggest={() => openComposer('suggestion')}
    canSuggest={sessionState.grantTier === 'suggest'}
  />
{/if}

{#if commentComposer}
  <CommentComposer
    view={commentComposer.view}
    from={commentComposer.from}
    to={commentComposer.to}
    anchorContext={commentComposer.anchorContext}
    roomId={commentComposer.roomId}
    onCreateComment={createBrowserComment}
    onClose={() => { commentComposer = null; }}
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
    onCreateSuggestion={createBrowserSuggestion}
    onClose={() => { suggestionComposer = null; }}
    onSubmit={collapseComposeSelection}
  />
{/if}
