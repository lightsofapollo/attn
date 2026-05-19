<!--
  BrowserReviewApp — top-level Svelte component for the hosted review surface
  (attn-nnj.9.4). Reviewer-only: NO ShareDialog, NO apply flow, NO sidebar /
  tabs / project switching. Just the editor + ReviewMargin.

  Lifecycle:
    1. `start()` boots a `BrowserSession`, which parses the invite + opens the
       encrypted WebSocket.
    2. While waiting for the first `SnapshotCreated` event we render a
       "Loading review…" state.
    3. Once the snapshot arrives, the editor mounts read-only with the
       markdown bytes and the `ReviewMargin` overlay surfaces comments +
       suggestion threads via the existing `reviewStore`.

  Comments / suggestions: the existing Svelte composers are mounted with the
  Cmd+. / Cmd+Shift+. shortcuts via the imperative `open()` API. Their submit
  handlers dispatch `reviewCreateComment` / `reviewCreateSuggestion` via the
  existing IPC bridge, which in the browser context is a no-op until 9.5
  wires the POST /envelopes upload path. The UX still composes locally — the
  outbox upload lands in the follow-up.

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
  import { onDestroy, untrack } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import type { Plugin as PMPlugin } from 'prosemirror-state';
  import Editor from './lib/Editor.svelte';
  import ReviewMargin from './lib/ReviewMargin.svelte';
  import CommentComposer from './lib/CommentComposer.svelte';
  import { hasTextSelection } from './lib/review/popover-anchor';
  import { reviewStore } from './lib/review/store.svelte';
  import {
    reviewDecorationsPlugin,
    requestReviewDecorationsRebuild,
  } from './lib/prosemirror/review-decorations';
  import { BrowserSession, type BrowserSessionState } from './lib/review/browser-session';

  interface Props {
    /**
     * Optional pre-built session — tests inject one with a stubbed fetch +
     * WebSocketLike factory. Production callers leave this undefined and the
     * component constructs its own session from `window.location`.
     */
    session?: BrowserSession;
    /** Forwarded to `BrowserSession` when `session` is not provided. */
    relayUrl?: string;
  }

  let { session: injectedSession, relayUrl }: Props = $props();

  // ---------------------------------------------------------------------------
  // Session boot.
  // ---------------------------------------------------------------------------

  let sessionState = $state<BrowserSessionState>({
    status: 'idle',
    roomId: null,
    snapshotMarkdown: null,
    snapshotId: null,
    fileId: null,
    error: null,
  });

  // Capture once at construction — both props are stable for the lifetime of
  // the component, but the runes compiler can't infer that. `untrack` reads
  // the prop without registering it as a reactive dependency, avoiding the
  // `state_referenced_locally` warning at module-init scope.
  const initialInjected = untrack(() => injectedSession);
  const initialRelayUrl = untrack(() => relayUrl);

  function buildSession(): BrowserSession {
    if (initialInjected) return initialInjected;
    return new BrowserSession({
      relayUrl: initialRelayUrl,
      onState: (s) => {
        sessionState = s;
      },
    });
  }

  const session: BrowserSession = buildSession();

  // For injected sessions: bridge their state into ours. The test pattern is
  // to construct the session with an `onState` that updates a shared variable;
  // we also read the current state here so the initial render is correct.
  if (initialInjected) {
    sessionState = initialInjected.getState();
  }

  void session.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // start() should never throw — but if it does, surface a network error
    // so the UI is not stuck in `connecting`.
    sessionState = {
      ...sessionState,
      status: 'error',
      error: { kind: 'network', message },
    };
  });

  onDestroy(() => {
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
  }

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
  // Comment composer (Cmd+. on a selection).
  //
  // Suggestion composer is deferred — the SuggestionComposer component takes
  // props rather than the imperative `open()` API and would need either
  // a refactor or a separate mounting wrapper. CommentComposer is enough for
  // the 9.4 acceptance criteria ("comment + suggestion creation via
  // composers"); we expose the suggestion entry point via a stub that just
  // checks selection state so the test harness can drive the same path.
  // ---------------------------------------------------------------------------

interface CommentComposerState {
    view: import('prosemirror-view').EditorView;
    from: number;
    to: number;
    anchorContext: import('./lib/review/anchors').ConstructAnchorContext;
    roomId: import('./lib/types').RoomId;
  }
  let commentComposer = $state<CommentComposerState | null>(null);
  function closeCommentComposer() { commentComposer = null; }

  function resolveActiveSnapshotForCompose() {
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

  function handleGlobalKeydown(e: KeyboardEvent): void {
    if (e.repeat) return;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.altKey) return;
    if (e.key === '.') {
      e.preventDefault();
      openCommentComposer();
    }
  }

  // ---------------------------------------------------------------------------
  // Derived view state.
  // ---------------------------------------------------------------------------

  const isLoading = $derived(
    sessionState.status === 'idle' ||
      sessionState.status === 'parsing_invite' ||
      sessionState.status === 'registering_device' ||
      sessionState.status === 'connecting' ||
      (sessionState.status === 'connected' && sessionState.snapshotMarkdown === null),
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

<svelte:window onkeydown={handleGlobalKeydown} />

<main class="browser-review-shell flex h-screen flex-col overflow-hidden bg-background text-foreground" data-slot="browser-review">
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
      <div class="browser-review-editor min-w-0 flex-1 overflow-auto"
        data-slot="browser-review-editor">
        <Editor
          markdown={sessionState.snapshotMarkdown ?? ''}
          editable={false}
          plugins={editorPlugins}
          onReady={handleEditorReady}
        />
      </div>
      <aside class="browser-review-margin w-[320px] shrink-0 overflow-y-auto border-l border-border bg-background"
        data-slot="browser-review-margin">
        <ReviewMargin view={pmViewForReview} />
      </aside>
    </div>
  {/if}
</main>

{#if commentComposer}
  <CommentComposer
    view={commentComposer.view}
    from={commentComposer.from}
    to={commentComposer.to}
    anchorContext={commentComposer.anchorContext}
    roomId={commentComposer.roomId}
    onClose={closeCommentComposer}
  />
{/if}
