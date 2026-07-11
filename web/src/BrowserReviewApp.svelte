<!--
  BrowserReviewApp — top-level Svelte component for the hosted review surface
  (attn-nnj.9.4). Reviewer-only: NO ShareDialog, NO apply flow, NO sidebar /
  tabs / project switching. Just the editor + ReviewMargin.

  Lifecycle:
    1. `start()` boots a `BrowserSession`, which parses the invite + opens the
       encrypted WebSocket.
    2. While waiting for the first `SnapshotCreated` event we render a
       "Loading review…" state.
    3. Once the snapshot arrives, the editor mounts at that authenticated
       epoch. It becomes live-editable only while the owner is online; durable
       comments and suggestions remain available while the owner is away.

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
  import { CollabController } from './lib/prosemirror/collab-controller';
  import type { EditorBridge } from './lib/prosemirror/collab-session';
  import { remoteCursorsKey } from './lib/prosemirror/remote-cursors';
  import {
    BrowserReviewerCollabGate,
    browserReviewerAvailability,
    browserReviewerViewMatchesEpoch,
    rememberAuthenticatedOwnerDevice,
  } from './lib/review/browser-review-collab';
  import type { ParsedInvite } from './lib/review/browser-invite';
  import { hasTextSelection } from './lib/review/popover-anchor';
  import { resolveAnchor } from './lib/review/resolver';
  import type { ConstructAnchorContext } from './lib/review/anchors';
  import type { Anchor, FileId, RoomId, SuggestionDraft } from './lib/types';

  interface Props {
    /**
     * Optional pre-built session — tests inject one with a stubbed fetch +
     * WebSocketLike factory. Production callers leave this undefined and the
     * component constructs its own session from `window.location`.
     */
    session?: BrowserSession;
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
    outboxPending: 0,
    authoringError: null,
    persistence: 'ephemeral',
    storagePersisted: null,
  });
  let collabSetupError = $state<string | null>(null);
  const authenticatedOwnerDeviceIds = new Set<string>();
  const reviewerCollabGate = new BrowserReviewerCollabGate((error) => {
    collabSetupError = error.message;
  });

  function handleSessionState(state: BrowserSessionState): void {
    sessionState = state;
  }

  async function handleSessionCollab(delivery: BrowserCollabDelivery): Promise<void> {
    // BrowserSession has already bound this immutable Device record to the
    // verified directory entry and envelope signature.
    rememberAuthenticatedOwnerDevice(authenticatedOwnerDeviceIds, delivery);
    await reviewerCollabGate.route(delivery);
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

  function buildSession(): BrowserSession {
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

  const session: BrowserSession = buildSession();
  // The hosted shell dedicates a permanent 320px rail to review threads, so
  // keep the shared margin in its expanded/card mode instead of the native
  // app's collapsed 48px avatar-gutter mode.
  reviewStore.panelOpen = true;

  // For injected sessions: bridge their state into ours. The test pattern is
  // to construct the session with an `onState` that updates a shared variable;
  // we also read the current state here so the initial render is correct.
  if (initialInjected) {
    sessionState = initialInjected.getState();
  }

  void session.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    session.close();
    // start() should never throw — but if it does, surface a network error
    // so the UI is not stuck in `connecting`.
    sessionState = {
      ...sessionState,
      status: 'error',
      error: { kind: 'network', message },
    };
  });

  onDestroy(() => {
    reviewerCollabGate.close();
    if (!initialInjected) {
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
    refreshSelectionToolbar();
  }

  onDestroy(() => {
    const target = window as unknown as { __attnPmView?: EditorView };
    if (target.__attnPmView === pmViewForReview) delete target.__attnPmView;
  });

  // Touch reactive store reads so Svelte schedules a rebuild whenever the
  // anchor resolution map, event log, or focus target changes.
  $effect(() => {
    void reviewStore.anchorResolutions;
    void reviewStore.events;
    void reviewStore.focusEventId;
    void reviewStore.hoveredEventId;
    if (!pmViewForReview) return;
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
  // Reviewer live collaboration.
  //
  // Keep the collab plugin mounted while the owner is away so the editor's
  // confirmed version and any remote state survive presence blips. Presence
  // gates only document editability; durable comments/suggestions continue to
  // use BrowserSession's encrypted outbox independently.
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

  const reviewerAvailability = $derived(browserReviewerAvailability({
    hasMarkdownSnapshot: reviewerCollabSeed !== null && displayedDocType === 'markdown',
    ownerOnline: sessionState.ownerOnline,
    liveEditingAvailable: sessionState.liveEditingAvailable,
    authoringReady: sessionState.authoringReady,
  }));

  $effect(() => {
    const snapshot = displayedSnapshot;
    const roomId = sessionState.roomId;
    if (
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
    if (!seed || !clientId || reviewerCollabController) return;
    reviewerCollabController = new CollabController({
      isOwner: false,
      send: (payload) => session.sendCollab(payload),
      selfClientId: clientId,
      selfLabel: 'Reviewer',
      selfColor: '#2563eb',
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
    reviewerCollabGate.bind((delivery) => {
      controller.onInbound(delivery.payload, delivery.sender.deviceId);
    });
  });

  let previousLiveEditingAvailable = false;
  $effect(() => {
    const liveEditingAvailable = sessionState.liveEditingAvailable;
    const controller = reviewerCollabController;
    if (liveEditingAvailable && !previousLiveEditingAvailable) {
      controller?.onTransportConnected();
    }
    previousLiveEditingAvailable = liveEditingAvailable;
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
    if (reviewerAvailability.liveEditing) reviewerCollabController?.onLocalChange();
  }

  function handleReviewerCollabSelectionChange(head: number): void {
    if (reviewerAvailability.liveEditing) reviewerCollabController?.broadcastCursor(head);
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
      toolbarSelection = null;
      return;
    }
    if (!activeSnapshotForCompose()) {
      toolbarSelection = null;
      return;
    }
    toolbarSelection = { from: view.state.selection.from, to: view.state.selection.to };
  }

  $effect(() => {
    void reviewerAvailability.reviewAuthoring;
    refreshSelectionToolbar();
  });

  function openComposer(kind: 'comment' | 'suggestion'): void {
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
    await session.forgetRoom();
  }

  onMount(() => {
    const refresh = (): void => refreshSelectionToolbar();
    document.addEventListener('selectionchange', refresh);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      document.removeEventListener('selectionchange', refresh);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
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
          class="flex min-h-8 items-center justify-between gap-3 border-b border-border px-3 text-xs text-muted-foreground"
          data-slot="browser-authoring-status"
        >
          <div class="flex min-w-0 items-center gap-2" data-slot="browser-persistence-status">
            {#if sessionState.persistence === 'ephemeral'}
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
            {:else if sessionState.persistence === 'saving'}
              <span role="status">Securing local recovery…</span>
            {:else}
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
          </div>
          <div class="flex min-w-0 items-center justify-end gap-2">
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
            {#if !sessionState.authoringReady}
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
            <OutboxIndicator isOwner={false} onRetry={() => { void session.retryOutbox(); }} />
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
              editable={reviewerAvailability.liveEditing}
              plugins={editorPlugins}
              onReady={handleEditorReady}
              collabClientId={reviewerAvailability.collabReady
                ? reviewerCollabClientId ?? undefined
                : undefined}
              collabEpoch={reviewerCollabEpoch}
              onCollabDocChange={handleReviewerCollabDocChange}
              onCollabSelectionChange={handleReviewerCollabSelectionChange}
              suggesting={reviewerAvailability.liveEditing}
              suggestionAuthor="Reviewer"
            />
          {/if}
        </div>
      </div>
      {#if displayedDocType !== 'html'}
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
  {/if}
</main>

{#if toolbarSelection && pmViewForReview && !commentComposer && !suggestionComposer}
  <SelectionToolbar
    view={pmViewForReview}
    from={toolbarSelection.from}
    to={toolbarSelection.to}
    onComment={() => openComposer('comment')}
    onSuggest={() => openComposer('suggestion')}
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
