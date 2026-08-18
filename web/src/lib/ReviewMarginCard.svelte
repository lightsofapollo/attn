<!--
  ReviewMarginCard — single Google-Docs-style margin card.

  Per `planning/collab/ui/review-panel-design.md` §1.2 "Card anatomy" the
  card has a header (author chip + meta badge + state badge), the body, and
  an action row whose buttons depend on the kind (`comment` vs
  `suggestion`).

  There is no anchor-quote preview on an anchored card (attn-bb6t.2): the
  quote duplicated text the reader can already see, and hover linking now
  points at the real thing — hovering the card lights up its segment in the
  document, hovering the segment lights up the card. STALE cards are the
  exception and keep their quote, because a stale anchor renders no inline
  mark at all, so the quote is the only surviving trace of what was said
  about what.

  The meta badge is the single right-hand chip (attn-bw2h.2/.3): it
  carries the relative age, the `suggest` word for suggestions, and a
  tick when the thread is resolved. There is deliberately no `comment`
  chip — a card in the comments rail is self-evidently a comment — and
  no `resolved` word next to the tick.

  This component is presentational: the parent `ReviewMargin` resolves the
  thread → kind/state/preview/handlers and feeds them in via `Props`. The
  card never reaches into the review store directly; that keeps the
  component testable in isolation and keeps focus/active styling decisions
  in one place (the parent).

  No emoji, no window.confirm/alert. Action handlers are callbacks; the
  parent wires them to IPC or local state.
-->

<script module lang="ts">
  // ---------------------------------------------------------------------------
  // Shared relative-age ticker (attn-bw2h.2)
  // ---------------------------------------------------------------------------
  //
  // The age moved from loose header text into the meta badge, where it is
  // the thing users scan — so it must not freeze at its mount-time value
  // ("just now" an hour later is a lie). `Date.now()` isn't reactive, so a
  // tick counter drives the recompute.
  //
  // ONE interval for every mounted card, refcounted: the rail renders up
  // to ~50 cards (§6 DOM cap) and 50 independent timers would be 50 wakeups
  // per period for a label that changes at minute granularity.

  const AGE_TICK_MS = 30_000;

  let ageTick = $state(0);
  let ageTimer: ReturnType<typeof setInterval> | null = null;
  let ageSubscribers = 0;

  function subscribeAgeTick(): () => void {
    ageSubscribers += 1;
    if (ageTimer === null) {
      ageTimer = setInterval(() => {
        ageTick += 1;
      }, AGE_TICK_MS);
    }
    return () => {
      ageSubscribers -= 1;
      if (ageSubscribers <= 0 && ageTimer !== null) {
        clearInterval(ageTimer);
        ageTimer = null;
        ageSubscribers = 0;
      }
    };
  }
</script>

<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';

  import AmbiguousAnchorPicker from './AmbiguousAnchorPicker.svelte';
  import { AGENT_GLYPH, monogramFor } from './peer-strip-format';
  import { shouldSubmitOnEnter } from './review/composer-keys';
  import {
    runSuggestionAction,
    type SuggestionActionFeedback,
  } from './review/suggestion-action-port';
  import { reviewStore } from './review/store.svelte';
  import type { ResolvedAnchorCandidate, Thread } from './types';

  type CardKind = 'comment' | 'suggestion';
  type CardState =
    | 'open'
    | 'resolved'
    | 'remapped_moved'
    | 'ambiguous'
    | 'stale';

  interface Props {
    /** The thread this card represents. */
    thread: Thread;
    /** Per-card visual kind — drives chrome + action row. */
    kind: CardKind;
    /** Per-card state — drives badge + opacity. */
    cardState: CardState;
    /** Active card gets full opacity, shadow, accent border (§1.5). */
    active: boolean;
    /** Hovered cross-surface (editor ↔ margin). */
    hovered: boolean;
    /** Card was displaced from anchorY by collision detection. */
    offset: boolean;
    /** Author display name (fallback to participantId). */
    authorName: string;
    /** Author participant id — resolves the personal identity color
     *  (attn-3gdd) so the card border matches the author's chip + caret. */
    authorId: string;
    /** Click target: editor focuses this card's anchor. */
    onActivate: () => void;
    /** Accept a suggestion through the parent-owned action port. */
    onAccept?: () => unknown | Promise<unknown>;
    /** Reject a suggestion through the parent-owned action port. */
    onReject?: () => unknown | Promise<unknown>;
    /** Resolve handler — mints a CommentResolved event (attn-zhr). */
    onResolve?: () => void;
    /** Unresolve handler — mints a CommentReopened event (attn-bb6t.5). */
    onUnresolve?: () => void;
    /** Post a reply to this thread (attn-1rm). Parent wires it to
     *  reviewCreateComment with the root anchor + this thread id. */
    onReply?: (body: string) => Promise<void> | void;
    /** Locally-set marker — true after the user clicked reject/resolve and
     *  the IPC is not yet acknowledged (or doesn't exist yet). */
    pendingDismiss?: boolean;
    /** The initiating author's participant kind (attn-42y). Drives the
     *  card's border color and the header avatar via the
     *  `--peer-avatar-bg-*` tokens, matching carets and peer chips. */
    authorKind?: 'owner' | 'reviewer' | 'agent';
    /** Fires when the embedded AmbiguousAnchorPicker has dispatched a
     *  reviewResolveAnchor IPC. The parent uses this for tests / for
     *  any optimistic local marking until the store gets the
     *  AnchorResolutionChanged update back. */
    onCandidatePicked?: (candidate: ResolvedAnchorCandidate, index: number) => void;
    /** Fires when the user clicks "Re-anchor manually" on a stale card.
     *  ReviewMargin orchestrates the editor select-mode overlay across
     *  all stale cards in response to this. */
    onRequestReanchor?: () => void;
    /** Fires when the user clicks "Discard" on a stale card.
     *  ReviewMargin removes the card from the orphan tray. */
    onDiscardStale?: () => void;
    /** True when *this* stale card is the one currently awaiting a new
     *  anchor — flips the body into a "Select text in the editor…" hint
     *  with a Cancel button. */
    awaitingReanchor?: boolean;
    /** Cancel the in-flight reanchor for this card. */
    onCancelReanchor?: () => void;
    /** Hosted receiver mode: render content/navigation but no mutations. */
    readOnly?: boolean;
    /** Hosted reviewer may reply/resolve comments, but never apply/re-anchor. */
    reviewerAuthoring?: boolean;
  }

  let {
    thread,
    kind,
    cardState,
    active,
    hovered,
    offset,
    authorName,
    authorId,
    onActivate,
    onAccept,
    onReject,
    onResolve,
    onUnresolve,
    onReply,
    pendingDismiss = false,
    authorKind = 'reviewer',
    onCandidatePicked,
    onRequestReanchor,
    onDiscardStale,
    awaitingReanchor = false,
    onCancelReanchor,
    readOnly = false,
    reviewerAuthoring = false,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Ambiguous-picker integration (attn-nnj.4.7)
  // ---------------------------------------------------------------------------
  //
  // When the resolver returns `status: 'ambiguous'`, the orphan-tray card
  // hosts an inline AmbiguousAnchorPicker so the owner can pick which
  // candidate becomes the new resolved anchor.

  const ambiguousCandidates: ResolvedAnchorCandidate[] = $derived(
    extractAmbiguousCandidates(thread),
  );

  const ambiguousReason: string | undefined = $derived(extractAmbiguousReason(thread));

  function extractAmbiguousCandidates(t: Thread): ResolvedAnchorCandidate[] {
    const r = t.resolvedAnchor;
    if (!r || r.status !== 'ambiguous') return [];
    return r.candidates;
  }

  function extractAmbiguousReason(t: Thread): string | undefined {
    const r = t.resolvedAnchor;
    if (!r || r.status !== 'ambiguous') return undefined;
    return r.reason;
  }

  // ---------------------------------------------------------------------------
  // Body extraction
  // ---------------------------------------------------------------------------
  //
  // The body text comes off the root event. CommentCreated carries `body`
  // directly; SuggestionCreated carries an `operation` object whose
  // human-readable form depends on the kind. We compute it here so the
  // template stays dumb.

  const body = $derived(extractBody(thread));

  function extractBody(t: Thread): string {
    const root = t.rootEvent.body;
    if (root.type === 'comment_created') {
      return root.body;
    }
    if (root.type === 'suggestion_created') {
      const op = root.operation;
      switch (op.kind) {
        case 'replace':
          return `replace "${truncate(op.expectedText, 40)}" → "${truncate(op.replacement, 40)}"`;
        case 'insert_before':
          return `insert before: "${truncate(op.text, 60)}"`;
        case 'insert_after':
          return `insert after: "${truncate(op.text, 60)}"`;
        case 'delete':
          return `delete "${truncate(op.expectedText, 60)}"`;
        default:
          return '(unsupported suggestion)';
      }
    }
    return '';
  }

  function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return `${s.slice(0, n - 1)}…`;
  }

  // ---------------------------------------------------------------------------
  // Age helper (mirrors ReviewApplyExpand for visual consistency)
  // ---------------------------------------------------------------------------

  // `void ageTick` is the live-update subscription: the shared 30s ticker
  // (module block) is the only reason this recomputes for an unchanged
  // thread, so "just now" ages into "1m" without a store round-trip.
  const ageLabel = $derived.by(() => {
    void ageTick;
    return formatAge(thread.rootEvent.meta.createdAt);
  });

  $effect(() => subscribeAgeTick());

  /** Absolute creation time — hover affordance behind the relative age. */
  const timestampTitle = $derived(formatTimestamp(thread.rootEvent.meta.createdAt));

  function formatTimestamp(ms: number | undefined): string | undefined {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
    return new Date(ms).toLocaleString();
  }

  function formatAge(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const delta = Math.max(0, Date.now() - ms);
    const s = Math.floor(delta / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Stale-state quote extraction (attn-nnj.4.8)
  // ---------------------------------------------------------------------------
  //
  // When a comment goes stale (resolver couldn't find the anchor anymore)
  // we show the originally-selected quote prominently so the owner can
  // hunt for the equivalent text in the editor and click "Re-anchor
  // manually" to drop a new selection on it. The quote on the original
  // anchor (`thread.anchor.quote.exact`) is the source of truth.

  const staleQuote = $derived(extractStaleQuote(thread));

  function extractStaleQuote(t: Thread): string {
    const q = t.anchor?.quote?.exact ?? '';
    // Trim to ~160 chars to avoid blowing up the card.
    if (q.length <= 160) return q;
    return `${q.slice(0, 159)}…`;
  }

  function handleRequestReanchor(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly) return;
    if (onRequestReanchor) onRequestReanchor();
  }

  function handleDiscardStale(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly) return;
    if (onDiscardStale) onDiscardStale();
  }

  function handleCancelReanchor(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly) return;
    if (onCancelReanchor) onCancelReanchor();
  }

  let suggestionFeedback = $state<SuggestionActionFeedback>({ status: 'idle' });
  const suggestionPending = $derived(suggestionFeedback.status === 'pending');

  function handleAccept(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly || kind !== 'suggestion' || suggestionPending) return;
    void runSuggestionAction(onAccept, 'accept', (feedback) => {
      suggestionFeedback = feedback;
    });
  }

  function handleReject(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly || kind !== 'suggestion' || suggestionPending) return;
    void runSuggestionAction(onReject, 'reject', (feedback) => {
      suggestionFeedback = feedback;
    });
  }

  function handleResolve(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly && !reviewerAuthoring) return;
    if (onResolve) onResolve();
  }

  function handleUnresolve(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly && !reviewerAuthoring) return;
    if (onUnresolve) onUnresolve();
  }

  // --- Replies (attn-1rm) -----------------------------------------------------
  let replying = $state(false);
  let replyBody = $state('');
  let replySubmitting = $state(false);
  let replyError = $state('');

  function toggleReply(e: MouseEvent): void {
    e.stopPropagation();
    if (readOnly && !reviewerAuthoring) return;
    replying = !replying;
    if (!replying) replyBody = '';
  }

  async function submitReply(): Promise<void> {
    if (readOnly && !reviewerAuthoring) return;
    const trimmed = replyBody.trim();
    if (trimmed.length === 0 || !onReply || replySubmitting) return;
    replySubmitting = true;
    replyError = '';
    try {
      await onReply(trimmed);
      replyBody = '';
      replying = false;
    } catch (error) {
      replyError = error instanceof Error ? error.message : 'Could not post reply';
    } finally {
      replySubmitting = false;
    }
  }

  function handleReplyKeydown(e: KeyboardEvent): void {
    // Keys belonging to an in-flight IME composition (e.g. Escape closing
    // the candidate list) are the IME's, not ours.
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      replying = false;
      replyBody = '';
    } else if (shouldSubmitOnEnter(e)) {
      // Enter submits; Shift+Enter inserts a newline (attn-2aj).
      e.preventDefault();
      e.stopPropagation();
      void submitReply();
    }
  }

  /** Display name for a reply's author, mirroring ReviewMargin's resolver. */
  function replyAuthor(participantId: string): string {
    return reviewStore.displayNameFor(participantId);
  }

  /** A reply's body text (replies are always CommentCreated events). */
  function replyText(ev: Thread['replies'][number]): string {
    return ev.body.type === 'comment_created' ? ev.body.body : '';
  }

  function handleCardClick(): void {
    // A mouseup ending a text-selection drag inside the card dispatches a
    // click on the card root. Activating then would be hostile: it moves
    // the editor cursor for active cards and COLLAPSES expanded resolved
    // cards — making comment text impossible to select/copy.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    onActivate();
  }

  // Author identity visuals (attn-42y, personal colors attn-3gdd): the
  // card's accent strip and the header avatar carry the initiating author's
  // personal identity color — same resolution as peer chips and carets.
  // Stale / ambiguous keep their state-colored strip (set by the CSS state
  // rules when no inline value is emitted) — those are alerts, not identity
  // surfaces.
  const authorColor = $derived(reviewStore.colorFor(authorId));
  const authorAccent = $derived(
    cardState === 'stale' || cardState === 'ambiguous' ? undefined : authorColor,
  );
  const avatarGlyph = $derived(
    authorKind === 'agent' ? AGENT_GLYPH : monogramFor(authorName),
  );

  function handleKeydown(e: KeyboardEvent): void {
    // Only the card itself activates on Enter/Space. Ignore keydowns bubbling
    // up from child controls (e.g. the reply textarea) — otherwise this
    // swallowed the space bar and you couldn't type spaces in a reply.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  }

  // ---------------------------------------------------------------------------
  // Hover bridge — wire cross-surface highlight in inline-decorations plugin
  // ---------------------------------------------------------------------------

  function handleMouseEnter(): void {
    reviewStore.setHoveredEventId(thread.rootEvent.meta.eventId);
  }

  function handleMouseLeave(): void {
    // Only clear if we're still the hovered card (avoids racing with another
    // card's mouseenter that already fired in the same frame).
    if (reviewStore.hoveredEventId === thread.rootEvent.meta.eventId) {
      reviewStore.setHoveredEventId(null);
    }
  }
</script>

<!--
  We intentionally render a focusable, clickable `<div>` here so the card
  reads as a group of related controls (the inner buttons own their own
  semantics). `role="group"` keeps it non-interactive for AT while
  preserving keyboard focus + activate behavior; svelte-check warns about
  noninteractive + tabindex, so we silence those warnings explicitly.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="review-margin-card"
  data-testid="review-margin-card"
  data-thread-id={thread.id}
  data-kind={kind}
  data-state={cardState}
  data-active={active ? 'true' : 'false'}
  data-hovered={hovered ? 'true' : 'false'}
  data-offset={offset ? 'true' : 'false'}
  data-pending-dismiss={pendingDismiss ? 'true' : 'false'}
  data-suggestion-pending={suggestionPending ? 'true' : 'false'}
  data-awaiting-reanchor={awaitingReanchor ? 'true' : 'false'}
  style:--rmc-accent={authorAccent}
  onclick={handleCardClick}
  onkeydown={handleKeydown}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  role="group"
  tabindex="0"
  aria-busy={suggestionPending}
  aria-label={`${kind} by ${authorName}, ${cardState}`}
>
  <header class="rmc-header">
    <span
      class="rmc-avatar"
      style:background-color={authorColor}
      data-author-kind={authorKind}
      aria-hidden="true"
    >{avatarGlyph}</span>
    <span class="rmc-author">{authorName}</span>
    <span class="rmc-spacer"></span>
    {#if cardState === 'remapped_moved'}
      <!--
        `attn-moved-badge` is the canonical selector per
        planning/collab/ui/inline-decorations.md §3 (the panel-side moved
        chip). `rmc-badge` + `rmc-badge-moved` are the local styling
        hooks for layout inside this card; both stay so existing CSS keeps
        working and E2E (attn-nnj.4.14) can target `.attn-moved-badge`.
      -->
      <span
        class="rmc-badge rmc-badge-moved attn-moved-badge"
        title="anchor was remapped"
        data-testid="review-margin-card-moved-badge"
      >moved</span>
    {:else if cardState === 'ambiguous'}
      <span class="rmc-badge rmc-badge-ambiguous" title="multiple anchor candidates">amb</span>
    {:else if cardState === 'stale'}
      <span class="rmc-badge rmc-badge-stale" title="anchor lost — needs re-anchor">stale</span>
    {/if}
    <!--
      Meta badge (attn-bw2h.2/.3) — the ONE chip on the right. Carries the
      relative age, `suggest` for suggestions (a suggestion proposes an
      edit; that is real information a comment chip never was), and a tick
      when the thread is resolved. `resolved` as a word is gone: the tick
      plus the sr-only text below say it, and the card's own aria-label
      already spells out the state.
    -->
    {#if ageLabel || kind === 'suggestion' || cardState === 'resolved'}
      <span
        class="rmc-meta"
        data-testid="review-margin-card-meta"
        data-kind={kind}
        data-state={cardState}
        title={timestampTitle}
      >
        {#if kind === 'suggestion'}
          <span class="rmc-meta-kind">suggest</span>
        {/if}
        {#if ageLabel}
          <span class="rmc-meta-age">{ageLabel}</span>
        {/if}
        {#if cardState === 'resolved'}
          <CheckIcon class="rmc-meta-tick" size={12} strokeWidth={2.5} aria-hidden="true" />
          <span class="rmc-sr-only">resolved</span>
        {/if}
      </span>
    {/if}
  </header>

  {#if cardState === 'stale'}
    <!--
      Stale body: show the originally-selected quote so the user can find
      the equivalent text in the editor. Per Decision #15 the inline
      mark is gone (we couldn't anchor), so this is the *only* surface
      that knows what the comment was about.
    -->
    {#if staleQuote}
      <p
        class="rmc-stale-quote"
        data-testid="review-margin-card-stale-quote"
        title={staleQuote}
      >
        “{staleQuote}”
      </p>
    {:else}
      <p class="rmc-stale-quote rmc-stale-quote-empty">
        (no quote captured for this anchor)
      </p>
    {/if}
    <p class="rmc-body" data-testid="review-margin-card-stale-body">{body}</p>
    {#if thread.replies.length > 0}
      <p class="rmc-replies">{thread.replies.length} reply{thread.replies.length === 1 ? '' : 's'}</p>
    {/if}
  {:else}
    <p class="rmc-body">{body}</p>
    {#if thread.replies.length > 0}
      <ul class="rmc-reply-list" data-slot="review-replies">
        {#each thread.replies as reply (reply.meta.eventId)}
          <li class="rmc-reply">
            <span class="rmc-reply-author">{replyAuthor(reply.meta.authorId)}</span>
            <span class="rmc-reply-body">{replyText(reply)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if !readOnly && cardState === 'ambiguous' && ambiguousCandidates.length > 0}
    <AmbiguousAnchorPicker
      roomId={thread.rootEvent.meta.roomId}
      eventId={thread.rootEvent.meta.eventId}
      candidates={ambiguousCandidates}
      reason={ambiguousReason}
      onPicked={(candidate, index) => {
        if (onCandidatePicked) onCandidatePicked(candidate, index);
      }}
    />
  {/if}

  {#if !readOnly && cardState === 'stale' && awaitingReanchor}
    <p
      class="rmc-stale-hint"
      data-testid="review-margin-card-stale-hint"
    >
      Select the new location for this comment in the editor.
    </p>
  {/if}

  {#if !readOnly || reviewerAuthoring}
  <footer class="rmc-actions">
    {#if cardState === 'resolved'}
      <!-- A resolved card used to carry no action row at all (attn-42y).
           It carries exactly one now: Unresolve (attn-bb6t.5). Resolving
           was one-way until `CommentReopened` existed, so "read-only" was
           a statement about the protocol, not a design choice. Clicking the
           card (or Escape) still shrinks it back to its chip. -->
      {#if onUnresolve}
        <button
          type="button"
          class="rmc-btn"
          data-action="unresolve"
          data-testid="review-margin-card-unresolve"
          onclick={handleUnresolve}
          disabled={pendingDismiss}
        >
          Unresolve
        </button>
      {/if}
    {:else if cardState === 'stale' && !readOnly}
      {#if awaitingReanchor}
        <button
          type="button"
          class="rmc-btn"
          data-action="cancel-reanchor"
          data-testid="review-margin-card-cancel-reanchor"
          onclick={handleCancelReanchor}
        >
          Cancel
        </button>
      {:else}
        <button
          type="button"
          class="rmc-btn rmc-btn-primary"
          data-action="reanchor"
          data-testid="review-margin-card-reanchor"
          onclick={handleRequestReanchor}
          disabled={pendingDismiss}
        >
          Re-anchor manually
        </button>
        <button
          type="button"
          class="rmc-btn"
          data-action="discard-stale"
          data-testid="review-margin-card-discard-stale"
          onclick={handleDiscardStale}
          disabled={pendingDismiss}
        >
          Discard
        </button>
      {/if}
    {:else if kind === 'suggestion' && !readOnly}
      {#if onAccept}
        <button
          type="button"
          class="rmc-btn rmc-btn-primary"
          data-action="accept"
          onclick={handleAccept}
          disabled={pendingDismiss || suggestionPending}
        >
          {suggestionFeedback.status === 'pending' && suggestionFeedback.action === 'accept'
            ? 'Accepting…'
            : 'Accept'}
        </button>
      {/if}
      {#if onReject}
        <button
          type="button"
          class="rmc-btn"
          data-action="reject"
          onclick={handleReject}
          disabled={pendingDismiss || suggestionPending}
        >
          {suggestionFeedback.status === 'pending' && suggestionFeedback.action === 'reject'
            ? 'Rejecting…'
            : 'Reject'}
        </button>
      {/if}
    {:else if kind === 'comment'}
      {#if onReply}
        <button
          type="button"
          class="rmc-btn"
          data-action="reply"
          data-slot="review-reply-toggle"
          onclick={toggleReply}
          disabled={pendingDismiss}
        >
          Reply
        </button>
      {/if}
      {#if onResolve}
        <button
          type="button"
          class="rmc-btn"
          data-action="resolve"
          onclick={handleResolve}
          disabled={pendingDismiss}
        >
          Resolve
        </button>
      {/if}
    {/if}
  </footer>
  {/if}

  {#if suggestionFeedback.status === 'error'}
    <p class="rmc-action-feedback rmc-action-error" role="alert">
      {suggestionFeedback.message}
    </p>
  {:else if suggestionFeedback.status === 'delivery_pending'}
    <p class="rmc-action-feedback" role="status">
      {suggestionFeedback.message}
    </p>
  {/if}

  {#if replying && (!readOnly || reviewerAuthoring)}
    <div class="rmc-reply-composer" data-slot="review-reply-composer">
      <textarea
        bind:value={replyBody}
        class="rmc-reply-input"
        placeholder="Reply&hellip;"
        rows="4"
        onkeydown={handleReplyKeydown}
        onclick={(e) => e.stopPropagation()}
        disabled={replySubmitting}
      ></textarea>
      {#if replyError}
        <p class="rmc-reply-error" role="alert">{replyError}</p>
      {/if}
      <div class="rmc-reply-actions">
        <button type="button" class="rmc-btn" onclick={(e) => { e.stopPropagation(); replying = false; replyBody = ''; replyError = ''; }} disabled={replySubmitting}>
          Cancel
        </button>
        <button
          type="button"
          class="rmc-btn rmc-btn-primary"
          onclick={(e) => { e.stopPropagation(); void submitReply(); }}
          disabled={replyBody.trim().length === 0 || replySubmitting}
        >
          {replySubmitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* The accent runs the whole way around the card as a 2px border
     (attn-bb6t.1). It was previously a 3px left-hand strip, drawn as an
     absolutely positioned `::before` because neither of the other two ways
     to paint ONE edge survived the corner radius: `border-left: 3px` mitres
     into the 6px curve and wedges a pointy diagonal of color past the card
     outline, and `inset 3px 0 0 0` is clipped to the rounded padding box,
     tapering into a curved sliver at both ends ("do not make the colored
     edge curved"). Both failure modes are specific to a single edge meeting
     a radius it doesn't span. A uniform border has no mitre and no taper —
     every corner is the same 6px arc in the same color — so the
     pseudo-element, its `z-index: -1` stacking context, and the −1px
     offsets that kept it as tall as the card are all gone with it.
     (History: attn-bw2h.1 "the left hand border isn't as tall as the right
     hand side"; attn-11g4.4 signed off the 3px strip it replaced.)

     `--rmc-accent` still carries the color: set inline to the author's
     personal identity color, or by the kind/state rules below. */
  .review-margin-card {
    display: block;
    position: relative;
    /* Fluid: the margin slot (or orphan-tray list item) defines the
       width, inset 12px from the rail edges (attn-42y). */
    width: 100%;
    box-sizing: border-box;
    /* Symmetric now that no strip overlays the left padding. Border +
       padding keeps content at the same 13px inset it had before. */
    padding: 9px 11px;
    background: var(--review-card-surface, var(--popover, var(--background)));
    color: var(--popover-foreground, inherit);
    /* 2px exactly — thick enough to read as the card's identity, thin
       enough that a rail of cards doesn't become a stack of frames. */
    border: 2px solid var(--rmc-accent, var(--review-card-border, var(--border)));
    border-radius: 6px;
    font-size: 0.85rem;
    line-height: 1.4;
    cursor: pointer;
    text-align: left;
    opacity: 0.94;
    box-shadow: var(--review-card-shadow, 0 10px 28px rgba(0, 0, 0, 0.14));
    backdrop-filter: blur(10px) saturate(1.1);
    transition:
      opacity 120ms ease-out,
      box-shadow 120ms ease-out,
      border-color 120ms ease-out;
  }

  /* Hover — the card half of hover linking (attn-bb6t.2). `data-hovered`
     is also set when the pointer is over this thread's segment in the
     document, so both gestures land on one treatment: a soft halo in the
     card's own accent color. It sits OUTSIDE the border rather than
     recoloring it, because the border is identity and must not change
     meaning on hover. */
  .review-margin-card:hover,
  .review-margin-card[data-hovered='true'] {
    opacity: 1;
    box-shadow:
      var(--review-card-shadow, 0 10px 28px rgba(0, 0, 0, 0.14)),
      0 0 0 3px color-mix(in oklch, var(--rmc-accent, var(--primary)) 24%, transparent);
  }

  /* Active/selected — a harder ring, again outside the identity border.
     Declared after hover so it wins when a card is both. */
  .review-margin-card[data-active='true'] {
    opacity: 1;
    box-shadow:
      var(--review-card-shadow, 0 10px 28px rgba(0, 0, 0, 0.14)),
      0 0 0 2px color-mix(in oklch, var(--primary) 62%, transparent);
  }

  .review-margin-card[data-pending-dismiss='true'] {
    opacity: 0.35;
    pointer-events: none;
  }

  /* Kind accents — fallbacks when no inline author color is set. */
  .review-margin-card[data-kind='comment'] {
    --rmc-accent: var(--review-card-comment-accent, var(--comment-highlight));
  }

  .review-margin-card[data-kind='suggestion'] {
    --rmc-accent: var(--review-card-suggestion-accent, var(--suggestion-bg));
  }

  /* State accents (after the kind rules so they win the cascade; the
     inline author color is deliberately NOT set for these states). Stale
     inherits the stale highlight tint so the card reads consistently
     with the inline mark. */
  .review-margin-card[data-state='stale'] {
    --rmc-accent: var(--destructive);
  }

  .review-margin-card[data-state='ambiguous'] {
    --rmc-accent: var(--confidence-low);
  }

  .rmc-header {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 4px;
    font-size: 0.7rem;
  }

  /* Author avatar — monogram on the author's presence color, matching
     the collapsed-gutter chips and the peer strip (attn-42y). */
  .rmc-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    color: var(--monogram);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1;
  }

  .rmc-author {
    font-weight: 600;
    color: var(--foreground, inherit);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rmc-spacer {
    flex: 1 1 auto;
  }

  /* Chips never shrink; the author name is the only part of the header
     allowed to ellipsis (its `overflow: hidden` already zeroes its
     automatic minimum size, so it absorbs the squeeze). This is what
     stops the age wrapping onto its own line at a narrow rail. */
  .rmc-meta,
  .rmc-badge {
    flex-shrink: 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 9999px;
    line-height: 1.4;
    border: 1px solid transparent;
  }

  /* Meta badge: quiet by default — it is a timestamp, not an alert, so it
     must not out-shout the state badges it sits beside. */
  .rmc-meta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--muted);
    /* muted-foreground sits AT the 4.5:1 floor on the page ground; on the
       darker --muted chip fill this 10.85px text dropped just under it
       (axe, 2026-08-18). One step toward the foreground restores AA in
       both themes without un-quieting the chip. */
    color: color-mix(in oklch, var(--muted-foreground) 80%, var(--foreground));
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Suggestions keep the tint they had as a kind chip — but the word
     `suggest` inside carries the meaning, so the color is reinforcement,
     never the sole signal (PRODUCT.md). */
  .rmc-meta[data-kind='suggestion'] {
    background: color-mix(in oklch, var(--review-card-suggestion-accent) 20%, transparent);
    /* 78% accent read as pure hue but landed ~L0.48 on a tinted chip —
       under 4.5:1 for 10.85px text (axe, 2026-08-18). Leaning further into
       the foreground keeps the ledger-green cast while clearing AA in both
       themes (dark's light foreground lightens it symmetrically). */
    color: color-mix(in oklch, var(--review-card-suggestion-accent) 52%, var(--foreground, currentColor));
    border-color: color-mix(in oklch, var(--review-card-suggestion-accent) 34%, transparent);
  }

  .rmc-meta-kind {
    font-weight: 600;
  }

  /* Separator between `suggest` and the age — a rule, not a glyph, so it
     never gets read out or uppercased. */
  .rmc-meta-kind + .rmc-meta-age::before {
    content: '';
    display: inline-block;
    width: 1px;
    height: 0.7em;
    margin-right: 4px;
    vertical-align: -0.05em;
    background: currentColor;
    opacity: 0.4;
  }

  /* Lucide check (attn-bb6t.5) — an icon now, not a `✓` glyph, so it
     matches the checkmarks on the resolved chips and scales with the icon
     set rather than the font. `size` is set on the component; this only
     keeps it on the text baseline inside the meta chip. */
  :global(.rmc-meta-tick) {
    display: block;
    flex-shrink: 0;
  }

  /* Visually hidden, still announced — the tick must not be the only
     carrier of "resolved" (attn-bw2h.3). */
  .rmc-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .rmc-badge-moved {
    background: var(--confidence-med);
  }

  .rmc-badge-ambiguous {
    background: var(--confidence-low);
  }

  .rmc-badge-stale {
    background: var(--destructive);
    color: var(--destructive-foreground);
  }

  /* The stale card's quote — the only quote left on any card (attn-bb6t.2).
     Rendered prominently (multi-line clamp, accented border) because a
     stale anchor has no inline mark to hover, so this is the user's only
     handle on what the comment was about. */
  .rmc-stale-quote {
    margin: 0 0 6px;
    padding: 4px 8px;
    background: var(--suggestion-deletion);
    border: 1px solid color-mix(in oklch, var(--destructive) 30%, transparent);
    border-radius: 2px;
    color: var(--foreground, inherit);
    font-size: 0.7rem;
    font-style: italic;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-wrap: break-word;
  }

  .rmc-stale-quote-empty {
    font-style: italic;
    color: var(--muted-foreground);
  }

  /* In-flight hint while the user is supposed to be selecting in PM. */
  .rmc-stale-hint {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--accent);
    border-radius: 6px;
    font-size: 0.7rem;
    color: var(--accent-foreground, var(--foreground, inherit));
  }

  .review-margin-card[data-awaiting-reanchor='true'] {
    box-shadow: 0 0 0 2px var(--destructive);
  }

  .rmc-body {
    margin: 0 0 8px;
    padding: 0;
    color: color-mix(in oklch, var(--foreground, currentColor) 88%, var(--muted-foreground, currentColor));
    /* 4-line clamp per §1.2 anatomy. */
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-wrap: break-word;
  }

  .rmc-replies {
    margin: 0 0 8px;
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .rmc-reply-list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    border-top: 1px solid var(--border);
  }

  .rmc-reply {
    display: flex;
    gap: 6px;
    padding: 6px 0 0;
    font-size: 0.85rem;
    line-height: 1.35;
  }

  .rmc-reply-author {
    flex-shrink: 0;
    font-weight: 600;
    color: var(--foreground, inherit);
  }

  .rmc-reply-body {
    color: var(--foreground, inherit);
    overflow-wrap: anywhere;
  }

  .rmc-reply-composer {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .rmc-reply-input {
    width: 100%;
    box-sizing: border-box;
    /* No manual resize handle — rows=4 supplies the minimum height and
       Enter/Shift+Enter handle the rest (attn-2aj). */
    resize: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground, inherit);
    padding: 6px 8px;
    font-size: 0.85rem;
  }

  /* Theme-token focus instead of the native (blue) WebKit ring — mirrors
     the shared Input component's border-ring + ring-ring/50 treatment.
     Plain :focus (not :focus-visible): WebKit doesn't reliably match
     focus-visible on textareas, and focusing a text field is always an
     intentional act. */
  .rmc-reply-input:focus {
    outline: none;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px
      color-mix(in oklch, var(--ring) 50%, transparent);
  }

  .rmc-reply-error {
    margin: 0;
    color: var(--color-danger);
    font-size: 0.75rem;
    line-height: 1.25;
  }

  .rmc-reply-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }

  .rmc-actions {
    display: flex;
    gap: 6px;
  }

  .rmc-action-feedback {
    margin: 8px 0 0;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    line-height: 1.35;
  }

  .rmc-action-error {
    color: var(--color-danger, var(--destructive));
  }

  .rmc-btn {
    background: color-mix(in oklch, var(--background, transparent) 36%, transparent);
    border: 1px solid color-mix(in oklch, var(--foreground, currentColor) 18%, transparent);
    color: inherit;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.7rem;
    cursor: pointer;
  }

  .rmc-btn:hover {
    background: var(--muted);
  }

  .rmc-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .rmc-btn-primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: var(--primary);
  }

  .rmc-btn-primary:hover {
    filter: brightness(0.96);
    background: var(--primary);
  }
</style>
