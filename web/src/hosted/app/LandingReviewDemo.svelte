<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { TextSelection, type Plugin } from 'prosemirror-state';
  import type { EditorView } from 'prosemirror-view';
  import Editor from '../../lib/Editor.svelte';
  import CommentComposer from '../../lib/CommentComposer.svelte';
  import GuidedDemoCursor from './GuidedDemoCursor.svelte';
  import ReviewMargin from '../../lib/ReviewMargin.svelte';
  import SelectionToolbar from '../../lib/SelectionToolbar.svelte';
  import { hasTextSelection } from '../../lib/review/popover-anchor';
  import { reviewStore } from '../../lib/review/store.svelte';
  import {
    clearPendingAnchorRange,
    pendingAnchorHighlightPlugin,
    requestReviewDecorationsRebuild,
    reviewDecorationsPlugin,
    setPendingAnchorRange,
  } from '../../lib/prosemirror/review-decorations';
  import type {
    Anchor,
    AnchorIndex,
    Participant,
    ReviewEvent,
    ReviewSnapshot,
    Thread,
  } from '../../lib/types';

  const ROOM_ID = 'landing-demo-room';
  const FILE_ID = 'landing-demo-direction';
  const SNAPSHOT_ID = 'landing-demo-snapshot';
  const BASE_HASH = 'landing-demo-base-hash';
  const OWNER_ID = 'landing-demo-owner';
  const CLAUDE_ID = 'landing-demo-claude';
  const CODEX_ID = 'landing-demo-codex';
  const VISITOR_ID = 'landing-demo-visitor';
  const GUIDED_REPLY = 'Exactly — the owner still makes the final call.';

  const MARKDOWN = `# Launch direction

The browser should begin with a decision, not an empty canvas.

## The first minute

A visitor should understand the review loop before they create a workspace. Let the document do the explaining.

Start with a blank editor and explain the review tools around it.

## One shared margin

Human notes and agent suggestions arrive in the same encrypted margin. The owner decides what reaches the source file.`;

  const ANCHOR_INDEX: AnchorIndex = {
    docHash: BASE_HASH,
    canonicalEncoding: 'utf8-bytes',
    lineCount: MARKDOWN.split('\n').length,
    blocks: [],
    headings: [],
  };

  const editorPlugins: Plugin[] = [reviewDecorationsPlugin(), pendingAnchorHighlightPlugin()];
  const participants: Participant[] = [
    {
      participantId: OWNER_ID,
      displayName: 'James',
      kind: 'owner',
      publicSigningKey: 'demo-owner-key',
      capabilities: ['room_admin', 'read_snapshot', 'write_comment', 'resolve_comment', 'accept_suggestion'],
    },
    {
      participantId: CLAUDE_ID,
      displayName: 'Claude',
      kind: 'agent',
      publicSigningKey: 'demo-claude-key',
      capabilities: ['read_snapshot', 'write_comment', 'write_suggestion'],
    },
    {
      participantId: CODEX_ID,
      displayName: 'Codex',
      kind: 'agent',
      publicSigningKey: 'demo-codex-key',
      capabilities: ['read_snapshot', 'write_comment', 'write_suggestion'],
    },
    {
      participantId: VISITOR_ID,
      displayName: 'You',
      kind: 'reviewer',
      publicSigningKey: 'demo-visitor-key',
      capabilities: ['read_snapshot', 'write_comment'],
    },
  ];

  interface ComposerState {
    view: EditorView;
    from: number;
    to: number;
  }

  let pmView = $state<EditorView | undefined>(undefined);
  let toolbarSelection = $state<{ from: number; to: number } | null>(null);
  let commentComposer = $state<ComposerState | null>(null);
  let userHasCommented = $state(false);
  let demoDriving = $state(false);
  let demoCompleted = $state(false);
  let guidedReplyEventId: string | null = null;
  let guidedCursor = $state<{ replay: () => void } | undefined>(undefined);
  let seeded = false;
  let storeReady = false;
  let eventSequence = 0;
  const guidedDemoEnabled = typeof location === 'undefined'
    ? false
    : new URLSearchParams(location.search).get('autoplay') !== '0';

  function event(
    authorId: string,
    body: ReviewEvent['body'],
    createdAt: number,
    snapshotId: string | undefined = SNAPSHOT_ID,
  ): ReviewEvent {
    eventSequence += 1;
    return {
      meta: {
        v: 2,
        eventId: `landing-demo-event-${eventSequence}`,
        roomId: ROOM_ID,
        authorId,
        deviceId: `${authorId}-device`,
        createdAt,
        parentEventIds: [],
        snapshotId,
      },
      body,
      auth: { signature: 'demo', signingKeyId: 'demo' },
    };
  }

  function participantEvent(participant: Participant, createdAt: number): ReviewEvent {
    return event(participant.participantId, {
      type: 'participant_joined',
      participant,
      device: {
        deviceId: `${participant.participantId}-device`,
        participantId: participant.participantId,
        publicEncryptionKey: `demo-${participant.kind}-encryption-key`,
        publicSigningKey: participant.publicSigningKey,
        client: participant.kind === 'agent' ? 'agent-cli' : 'attn-browser',
        createdAt,
      },
    }, createdAt, undefined);
  }

  function anchorFor(view: EditorView, text: string): Anchor | null {
    let range: [number, number] | null = null;
    view.state.doc.descendants((node, position) => {
      if (!node.isText || range) return;
      const index = node.text?.indexOf(text) ?? -1;
      if (index < 0) return;
      range = [position + index, position + index + text.length];
    });
    if (!range) return null;
    return {
      v: 2,
      fileId: FILE_ID,
      snapshotId: SNAPSHOT_ID,
      baseHash: BASE_HASH,
      position: {
        byteRange: [0, new TextEncoder().encode(text).length],
        lineRange: [1, 1],
        pmRange: range,
      },
      quote: {
        exact: text,
        exactHash: `demo-exact-${text.length}`,
        normalized: text.toLowerCase(),
        normalizedHash: `demo-normalized-${text.length}`,
      },
    };
  }

  function resolveEvent(reviewEvent: ReviewEvent, anchor: Anchor): void {
    reviewStore.applyAnchorResolution({
      roomId: ROOM_ID,
      fileId: FILE_ID,
      eventId: reviewEvent.meta.eventId,
      resolved: {
        status: 'exact',
        confidence: 1,
        currentRange: anchor.position,
        reason: 'base_hash_match',
      },
    });
  }

  function seedAgentReview(view: EditorView): void {
    if (seeded) return;
    seeded = true;

    const suggestionAnchor = anchorFor(
      view,
      'Start with a blank editor and explain the review tools around it.',
    );
    const claudeAnchor = anchorFor(view, 'begin with a decision');
    const codexAnchor = anchorFor(view, 'same encrypted margin');
    if (!suggestionAnchor || !claudeAnchor || !codexAnchor) return;

    const now = Date.now();
    const suggestion = event(CLAUDE_ID, {
      type: 'suggestion_created',
      suggestionId: 'landing-demo-suggestion',
      anchor: suggestionAnchor,
      operation: {
        kind: 'replace',
        expectedText: suggestionAnchor.quote?.exact ?? '',
        replacement: 'Open with a working document and one decision ready to make.',
      },
      note: 'Lead with a concrete decision. It teaches the product faster than describing the interface.',
    }, now - 75_000);
    const claudeComment = event(CLAUDE_ID, {
      type: 'comment_created',
      threadId: 'landing-demo-claude-thread',
      anchor: claudeAnchor,
      body: 'Strong opening. The decision is visible before the interface needs explaining.',
    }, now - 42_000);
    const codexComment = event(CODEX_ID, {
      type: 'comment_created',
      threadId: 'landing-demo-codex-thread',
      anchor: codexAnchor,
      body: 'Keep this. It shows agents participate without pretending they own the file.',
    }, now - 18_000);

    for (const reviewEvent of [suggestion, claudeComment, codexComment]) {
      reviewStore.applyEvent(reviewEvent);
    }
    resolveEvent(suggestion, suggestionAnchor);
    resolveEvent(claudeComment, claudeAnchor);
    resolveEvent(codexComment, codexAnchor);
    requestReviewDecorationsRebuild(view);
  }

  function handleEditorReady(view: EditorView): void {
    pmView = view;
    const target = window as unknown as {
      __attnLandingReviewDemoView?: EditorView;
      __attnTextSelection?: typeof TextSelection;
    };
    target.__attnLandingReviewDemoView = view;
    target.__attnTextSelection = TextSelection;
    if (!storeReady) setupDemoStore();
    seedAgentReview(view);
    refreshSelectionToolbar();
  }

  function refreshSelectionToolbar(): void {
    const view = pmView;
    if (!view || !hasTextSelection(view)) {
      toolbarSelection = null;
      return;
    }
    const { from, to } = view.state.selection;
    if (toolbarSelection?.from === from && toolbarSelection.to === to) return;
    toolbarSelection = { from, to };
  }

  function openCommentComposer(): void {
    const view = pmView;
    if (!view || !hasTextSelection(view)) return;
    commentComposer = { view, from: view.state.selection.from, to: view.state.selection.to };
    toolbarSelection = null;
  }

  async function createVisitorComment(anchor: Anchor, body: string): Promise<void> {
    const reviewEvent = event(VISITOR_ID, {
      type: 'comment_created',
      threadId: `landing-demo-visitor-thread-${eventSequence + 1}`,
      anchor,
      body,
    }, Date.now());
    reviewStore.applyEvent(reviewEvent);
    resolveEvent(reviewEvent, anchor);
    reviewStore.panelOpen = true;
    userHasCommented = true;
    if (pmView) requestReviewDecorationsRebuild(pmView);
  }

  function collapseSelection(): void {
    toolbarSelection = null;
    const view = pmView;
    if (!view) return;
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.to)));
    } catch {
      // The frame may be unmounting while a submission resolves.
    }
  }

  async function replyToComment(anchor: Anchor, body: string, threadId: string): Promise<void> {
    const reviewEvent = event(VISITOR_ID, { type: 'comment_created', threadId, anchor, body }, Date.now());
    reviewStore.applyEvent(reviewEvent);
    if (demoDriving) guidedReplyEventId = reviewEvent.meta.eventId;
    else userHasCommented = true;
  }

  function prepareGuidedDemo(): void {
    demoDriving = true;
    demoCompleted = false;
    if (!guidedReplyEventId) return;
    reviewStore.events = reviewStore.events.filter((reviewEvent) => (
      reviewEvent.meta.eventId !== guidedReplyEventId
    ));
    guidedReplyEventId = null;
  }

  function completeGuidedDemo(): void {
    demoDriving = false;
    demoCompleted = true;
  }

  function cancelGuidedDemo(): void {
    demoDriving = false;
  }

  function decideSuggestion(_thread: Thread): { status: 'applied' } {
    return { status: 'applied' };
  }

  function resetDemoStore(): void {
    reviewStore.panelOpen = false;
    reviewStore.currentRoomId = null;
    reviewStore.currentFileId = null;
    reviewStore.currentSnapshotId = null;
    reviewStore.rooms = {};
    reviewStore.events = [];
    reviewStore.snapshots = [];
    reviewStore.anchorResolutions = {};
    reviewStore.pendingOutbox = [];
    reviewStore.peers = [];
    reviewStore.locallyDismissed = new Set<string>();
    reviewStore.focusEventId = null;
    reviewStore.hoveredEventId = null;
    reviewStore.expandedResolvedThreadId = null;
  }

  function setupDemoStore(): void {
    if (storeReady) return;
    resetDemoStore();
    const now = Date.now();
    reviewStore.rooms = {
      [ROOM_ID]: {
        roomId: ROOM_ID,
        status: 'Live',
        role: 'owner',
        connection: 'live_direct',
        peers: participants.map((participant) => ({
          participantId: participant.participantId,
          deviceId: `${participant.participantId}-device`,
          displayName: participant.displayName,
          kind: participant.kind,
          online: true,
          onSnapshotId: SNAPSHOT_ID,
        })),
        outboxPending: 0,
        updatedAt: now,
      },
    };
    const snapshot: ReviewSnapshot = {
      roomId: ROOM_ID,
      fileId: FILE_ID,
      snapshotId: SNAPSHOT_ID,
      ownerDisplayPath: 'direction.md',
      createdAt: now - 120_000,
      createdBy: OWNER_ID,
      baseHash: BASE_HASH,
      byteLength: new TextEncoder().encode(MARKDOWN).length,
      docType: 'markdown',
      content: MARKDOWN,
      anchorIndex: ANCHOR_INDEX,
    };
    reviewStore.applySnapshot(snapshot);
    reviewStore.selectRoom(ROOM_ID);
    reviewStore.setCurrentFile(FILE_ID);
    reviewStore.setCurrentSnapshot(SNAPSHOT_ID);
    reviewStore.panelOpen = true;
    participants.forEach((participant, index) => {
      reviewStore.applyEvent(participantEvent(participant, now - 130_000 + index));
    });
    storeReady = true;
  }

  onMount(() => {
    setupDemoStore();

    let refreshFrame = 0;
    const refresh = (): void => {
      if (refreshFrame) return;
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = 0;
        refreshSelectionToolbar();
      });
    };
    document.addEventListener('selectionchange', refresh);
    return () => {
      document.removeEventListener('selectionchange', refresh);
      if (refreshFrame) cancelAnimationFrame(refreshFrame);
    };
  });

  $effect(() => {
    const active = commentComposer;
    const view = pmView;
    if (!view) return;
    if (active) setPendingAnchorRange(active.view, active.from, active.to);
    else clearPendingAnchorRange(view);
  });

  $effect(() => {
    const resolutions = reviewStore.anchorResolutions;
    const events = reviewStore.events;
    const focusEventId = reviewStore.focusEventId;
    if (!pmView) return;
    untrack(() => {
      void resolutions;
      void events;
      void focusEventId;
      requestReviewDecorationsRebuild(pmView!);
    });
  });

  onDestroy(() => {
    if (pmView) clearPendingAnchorRange(pmView);
    const target = window as unknown as {
      __attnLandingReviewDemoView?: EditorView;
      __attnTextSelection?: typeof TextSelection;
    };
    if (target.__attnLandingReviewDemoView === pmView) delete target.__attnLandingReviewDemoView;
    delete target.__attnTextSelection;
    resetDemoStore();
    storeReady = false;
  });
</script>

<main
  class="landing-review-demo"
  data-user-commented={userHasCommented ? 'true' : 'false'}
  data-demo-state={demoDriving ? 'playing' : demoCompleted ? 'complete' : 'ready'}
>
  <header class="demo-toolbar">
    <div class="demo-file">
      <span class="demo-mark" aria-hidden="true">M↓</span>
      <span><strong>direction.md</strong><small>local working copy</small></span>
    </div>
    <div class="demo-presence" aria-label="James, Claude, and Codex are in this review">
      <span class="demo-avatar owner" title="James · owner">JL</span>
      <span class="demo-avatar agent" title="Claude · agent">✦</span>
      <span class="demo-avatar agent codex" title="Codex · agent">✦</span>
      <span class="demo-live"><i></i> encrypted room</span>
    </div>
  </header>

  <div class="demo-prompt" aria-live="polite">
    {#if userHasCommented}
      <span class="prompt-check" aria-hidden="true">✓</span>
      <strong>You joined the review.</strong> Your note now sits beside the agents’ feedback.
    {:else if demoDriving}
      <span class="prompt-kicker">Demo</span>
      <strong>Watch the real thread.</strong> The cursor is replying to Codex now.
    {:else if demoCompleted}
      <span class="prompt-check" aria-hidden="true">✓</span>
      <strong>That was the real review thread.</strong> Reply, accept, or select text to take over.
      <button class="prompt-replay" type="button" onclick={() => guidedCursor?.replay()}>Replay demo</button>
    {:else}
      <span class="prompt-kicker">Live demo</span>
      <strong>Watch the reply — or take over.</strong> Every control below is real.
    {/if}
  </div>

  <div class="demo-workspace">
    <section class="demo-document" aria-label="Interactive launch direction document">
      <div class="document-kicker">PRODUCT / LAUNCH / DIRECTION.MD</div>
      <Editor
        markdown={MARKDOWN}
        editable={false}
        plugins={editorPlugins}
        onReady={handleEditorReady}
      />
    </section>

    <aside class="demo-margin" aria-label="Review comments and suggestions">
      <div class="margin-title">
        <span>Review</span>
        <strong>{reviewStore.marginActiveThreadCount} open</strong>
      </div>
      <ReviewMargin
        view={pmView}
        layout="stacked"
        readOnly={false}
        reviewerAuthoring={true}
        suggestionActions={{ accept: decideSuggestion, reject: decideSuggestion }}
        onResolveComment={(threadId) => reviewStore.dismissThreadLocally(threadId)}
        onReplyComment={replyToComment}
      />
    </aside>
  </div>

  <footer class="demo-status">
    <span><i></i> Agent review ready</span>
    <span>Your source file stays clean until you accept.</span>
  </footer>
</main>

{#if pmView}
  <GuidedDemoCursor
    bind:this={guidedCursor}
    enabled={guidedDemoEnabled}
    replyText={GUIDED_REPLY}
    onstart={prepareGuidedDemo}
    oncomplete={completeGuidedDemo}
    oncancel={cancelGuidedDemo}
  />
{/if}

{#if toolbarSelection && pmView && !commentComposer}
  <SelectionToolbar
    view={pmView}
    from={toolbarSelection.from}
    to={toolbarSelection.to}
    onComment={openCommentComposer}
    onSuggest={() => undefined}
    canSuggest={false}
  />
{/if}

{#if commentComposer}
  <CommentComposer
    view={commentComposer.view}
    from={commentComposer.from}
    to={commentComposer.to}
    anchorContext={{
      index: ANCHOR_INDEX,
      fileId: FILE_ID,
      snapshotId: SNAPSHOT_ID,
      baseHash: BASE_HASH,
    }}
    roomId={ROOM_ID}
    onCreateComment={createVisitorComment}
    onClose={() => { commentComposer = null; }}
    onSubmitted={collapseSelection}
  />
{/if}

<style>
  :global(html),
  :global(body),
  :global(#app) {
    min-height: 100%;
    margin: 0;
  }

  :global(body[data-surface='landing-review-demo']) {
    overflow: hidden;
    background: var(--background);
  }

  .landing-review-demo {
    --demo-toolbar-height: 62px;
    min-height: 100dvh;
    display: grid;
    grid-template-rows: var(--demo-toolbar-height) auto minmax(0, 1fr) 34px;
    overflow: hidden;
    background: var(--background);
    color: var(--foreground);
    font-family: var(--font-sans, 'Source Sans 3', sans-serif);
  }

  .demo-toolbar,
  .demo-file,
  .demo-file > span:last-child,
  .demo-presence,
  .demo-status,
  .margin-title {
    display: flex;
    align-items: center;
  }

  .demo-toolbar {
    justify-content: space-between;
    gap: 1rem;
    padding: 0 1rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklch, var(--background) 93%, var(--foreground));
  }

  .demo-file { gap: 0.65rem; }
  .demo-file > span:last-child { align-items: flex-start; flex-direction: column; line-height: 1.1; }
  .demo-file strong { font-size: 1rem; }
  .demo-file small { margin-top: 0.28rem; color: var(--muted-foreground); font-size: 0.7rem; }

  .demo-mark {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: color-mix(in oklch, var(--primary) 13%, transparent);
    font: 700 0.7rem var(--font-mono, monospace);
  }

  .demo-presence { padding-left: 7px; }
  .demo-avatar {
    width: 31px;
    height: 31px;
    display: grid;
    place-items: center;
    margin-left: -7px;
    border: 2px solid var(--background);
    border-radius: 50%;
    color: white;
    font-size: 0.6875rem;
    font-weight: 750;
  }
  .demo-avatar.owner { background: var(--peer-avatar-bg-owner); }
  .demo-avatar.agent { background: var(--peer-avatar-bg-agent); }
  .demo-avatar.codex { background: var(--peer-avatar-bg-agent); }

  .demo-live {
    display: flex;
    align-items: center;
    gap: 0.48rem;
    margin-left: 0.7rem;
    color: var(--muted-foreground);
    font: 0.72rem var(--font-mono, monospace);
  }
  .demo-live i,
  .demo-status i {
    width: 7px;
    height: 7px;
    display: inline-block;
    border-radius: 50%;
    background: var(--green);
  }

  .demo-prompt {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.42rem;
    padding: 0.48rem 1rem;
    border-bottom: 1px solid color-mix(in oklch, var(--primary) 24%, var(--border));
    background: color-mix(in oklch, var(--primary) 7%, var(--background));
    color: var(--muted-foreground);
    font-size: 0.85rem;
  }
  .demo-prompt strong { color: var(--foreground); }
  .prompt-kicker {
    margin-right: 0.25rem;
    padding: 0.17rem 0.38rem;
    border-radius: 2px;
    background: var(--primary);
    color: var(--primary-foreground);
    font-size: 0.7rem;
    font-weight: 750;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .prompt-check { color: var(--green); font-weight: 800; }
  .prompt-replay {
    margin-left: 0.3rem;
    padding: 0.22rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--background);
    color: var(--foreground);
    font: 700 0.7rem var(--font-sans, sans-serif);
    cursor: pointer;
  }
  .prompt-replay:hover { border-color: var(--foreground); }
  .prompt-replay:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  .demo-workspace {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 31%);
  }

  .demo-document {
    min-width: 0;
    overflow: auto;
    padding: clamp(2.2rem, 5vw, 4.5rem) clamp(1.2rem, 6vw, 6rem) 4rem;
    background: var(--background);
    scrollbar-width: thin;
  }

  .document-kicker {
    max-width: 46rem;
    margin: 0 auto 1.45rem;
    color: var(--muted-foreground);
    font: 700 0.68rem var(--font-mono, monospace);
    letter-spacing: 0.08em;
  }

  .demo-document :global(.ProseMirror) {
    max-width: 46rem;
    min-height: 0;
    margin: 0 auto;
    padding: 0 !important;
    outline: none;
  }
  .demo-document :global(.ProseMirror h1) { margin-top: 0; }
  .demo-document :global(.ProseMirror p) { cursor: text; }
  .demo-document :global(.ProseMirror ::selection) {
    background: color-mix(in oklch, var(--primary) 24%, transparent);
  }

  .demo-margin {
    min-width: 0;
    overflow: auto;
    padding: 1rem 0.85rem 2rem;
    border-left: 1px solid var(--border);
    background: color-mix(in oklch, var(--background) 91%, var(--foreground));
    scrollbar-width: thin;
  }

  .margin-title {
    justify-content: space-between;
    padding: 0.1rem 0.25rem 0.85rem;
    font-size: 0.7rem;
    font-weight: 700;
  }
  .margin-title strong { color: var(--muted-foreground); font-weight: 600; }
  .demo-margin :global(.review-margin) { min-height: 100%; }
  .demo-margin :global(.review-margin-stack) { gap: 0.72rem; }
  .demo-margin :global(.rmc-kind) { color: var(--foreground); }

  .demo-status {
    justify-content: space-between;
    gap: 1rem;
    padding: 0 0.95rem;
    border-top: 1px solid var(--border);
    color: var(--muted-foreground);
    font: 0.68rem var(--font-mono, monospace);
  }
  .demo-status > span:first-child { display: flex; align-items: center; gap: 0.45rem; }

  @media (max-width: 680px) {
    :global(body[data-surface='landing-review-demo']) { overflow: auto; }
    .landing-review-demo {
      min-height: 100dvh;
      grid-template-rows: auto auto auto auto;
      overflow: visible;
    }
    .demo-toolbar { min-height: 58px; padding: 0.6rem 0.75rem; }
    .demo-live { font-size: 0; margin-left: 0.45rem; }
    .demo-live i { width: 8px; height: 8px; }
    .demo-prompt { align-items: flex-start; justify-content: flex-start; flex-wrap: wrap; line-height: 1.35; }
    .prompt-replay { min-height: 44px; padding-inline: 0.7rem; }
    .demo-workspace { display: block; }
    .demo-document { min-height: 470px; padding: 2.3rem 1.15rem 3.2rem; overflow: visible; }
    .demo-margin { min-height: 420px; border-top: 1px solid var(--border); border-left: 0; overflow: visible; }
    .demo-margin :global(.rmc-btn) { min-height: 44px; padding-inline: 0.75rem; }
    .demo-status { min-height: 54px; align-items: flex-start; flex-direction: column; justify-content: center; gap: 0.2rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .landing-review-demo *,
    .landing-review-demo *::before,
    .landing-review-demo *::after { scroll-behavior: auto !important; }
  }
</style>
