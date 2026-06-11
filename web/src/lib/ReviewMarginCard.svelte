<!--
  ReviewMarginCard — single Google-Docs-style margin card.

  Per `planning/collab/ui/review-panel-design.md` §1.2 "Card anatomy" the
  card has a header (author chip + age + kind badge + state badge), an
  anchor-quote preview, the body, and an action row whose buttons depend
  on the kind (`comment` vs `suggestion`).

  This component is presentational: the parent `ReviewMargin` resolves the
  thread → kind/state/preview/handlers and feeds them in via `Props`. The
  card never reaches into the review store directly; that keeps the
  component testable in isolation and keeps focus/active styling decisions
  in one place (the parent).

  No emoji, no window.confirm/alert. Action handlers are callbacks; the
  parent wires them to IPC or local state.
-->

<script lang="ts">
  import AmbiguousAnchorPicker from './AmbiguousAnchorPicker.svelte';
  import { reviewAcceptSuggestion, reviewRejectSuggestion } from './ipc';
  import { AGENT_GLYPH, monogramFor } from './peer-strip-format';
  import { reviewStore } from './review/store.svelte';
  import type { EventId, ResolvedAnchorCandidate, RoomId, Thread } from './types';

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
    /** Anchor-quote preview text (single line, ellipsis). */
    quotePreview: string;
    /** Click target: editor focuses this card's anchor. */
    onActivate: () => void;
    /** Reject handler — UI-only until reject IPC exists (TODO 4.x). */
    onReject?: () => void;
    /** Resolve handler — mints a CommentResolved event (attn-zhr). */
    onResolve?: () => void;
    /** Post a reply to this thread (attn-1rm). Parent wires it to
     *  reviewCreateComment with the root anchor + this thread id. */
    onReply?: (body: string) => void;
    /** Locally-set marker — true after the user clicked reject/resolve and
     *  the IPC is not yet acknowledged (or doesn't exist yet). */
    pendingDismiss?: boolean;
    /** The initiating author's participant kind (attn-42y). Drives the
     *  card's left-border color and the header avatar via the
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
  }

  let {
    thread,
    kind,
    cardState,
    active,
    hovered,
    offset,
    authorName,
    quotePreview,
    onActivate,
    onReject,
    onResolve,
    onReply,
    pendingDismiss = false,
    authorKind = 'reviewer',
    onCandidatePicked,
    onRequestReanchor,
    onDiscardStale,
    awaitingReanchor = false,
    onCancelReanchor,
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

  const ageLabel = $derived(formatAge(thread.rootEvent.meta.createdAt));

  function formatAge(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const delta = Math.max(0, Date.now() - ms);
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s`;
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
    if (onRequestReanchor) onRequestReanchor();
  }

  function handleDiscardStale(e: MouseEvent): void {
    e.stopPropagation();
    if (onDiscardStale) onDiscardStale();
  }

  function handleCancelReanchor(e: MouseEvent): void {
    e.stopPropagation();
    if (onCancelReanchor) onCancelReanchor();
  }

  function handleAccept(): void {
    if (kind !== 'suggestion') return;
    // For now, the suggestion event id IS the suggestionId (the body
    // carries it; we round-trip through the meta.eventId). The Rust apply
    // pipeline will return a verdict and may open the three-way card.
    const root = thread.rootEvent.body;
    if (root.type !== 'suggestion_created') return;
    const roomId: RoomId = thread.rootEvent.meta.roomId;
    const suggestionId: EventId = root.suggestionId;
    void reviewAcceptSuggestion(roomId, suggestionId);
  }

  function handleReject(e: MouseEvent): void {
    e.stopPropagation();
    // Suggestions: persist + propagate the rejection (mirror handleAccept) so
    // every participant's log records it and the ghost text stops rendering.
    // Comments have no rejection event, so they only dismiss locally.
    if (kind === 'suggestion') {
      const root = thread.rootEvent.body;
      if (root.type === 'suggestion_created') {
        const roomId: RoomId = thread.rootEvent.meta.roomId;
        const suggestionId: EventId = root.suggestionId;
        void reviewRejectSuggestion(roomId, suggestionId);
      }
    }
    if (onReject) onReject();
  }

  function handleResolve(e: MouseEvent): void {
    e.stopPropagation();
    if (onResolve) onResolve();
  }

  // --- Replies (attn-1rm) -----------------------------------------------------
  let replying = $state(false);
  let replyBody = $state('');

  function toggleReply(e: MouseEvent): void {
    e.stopPropagation();
    replying = !replying;
    if (!replying) replyBody = '';
  }

  function submitReply(): void {
    const trimmed = replyBody.trim();
    if (trimmed.length === 0 || !onReply) return;
    onReply(trimmed);
    replyBody = '';
    replying = false;
  }

  function handleReplyKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      replying = false;
      replyBody = '';
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      submitReply();
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

  // Author identity visuals (attn-42y): the card's left border and the
  // header avatar carry the initiating author's presence color. Stale /
  // ambiguous keep their state-colored border — those are alerts, not
  // identity surfaces.
  const authorColor = $derived(`var(--peer-avatar-bg-${authorKind})`);
  const authorBorderColor = $derived(
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
  data-awaiting-reanchor={awaitingReanchor ? 'true' : 'false'}
  style:border-left-color={authorBorderColor}
  onclick={handleCardClick}
  onkeydown={handleKeydown}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  role="group"
  tabindex="0"
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
    {#if ageLabel}<span class="rmc-age">· {ageLabel}</span>{/if}
    <span class="rmc-spacer"></span>
    {#if kind === 'suggestion'}
      <span class="rmc-kind rmc-kind-suggestion">suggest</span>
    {:else}
      <span class="rmc-kind rmc-kind-comment">comment</span>
    {/if}
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
    {:else if cardState === 'resolved'}
      <span class="rmc-badge rmc-badge-resolved">resolved</span>
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
    {#if quotePreview}
      <p class="rmc-quote" title={quotePreview}>{quotePreview}</p>
    {/if}
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

  {#if cardState === 'ambiguous' && ambiguousCandidates.length > 0}
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

  {#if cardState === 'stale' && awaitingReanchor}
    <p
      class="rmc-stale-hint"
      data-testid="review-margin-card-stale-hint"
    >
      Select the new location for this comment in the editor.
    </p>
  {/if}

  <footer class="rmc-actions">
    {#if cardState === 'resolved'}
      <!-- Read-only resolved card (attn-42y): no action row at all. The
           rail collapses as a whole; clicking the card (or Escape)
           shrinks it back to its chip. -->
    {:else if cardState === 'stale'}
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
    {:else if kind === 'suggestion'}
      <button
        type="button"
        class="rmc-btn rmc-btn-primary"
        data-action="accept"
        onclick={(e) => { e.stopPropagation(); handleAccept(); }}
        disabled={pendingDismiss}
      >
        Accept
      </button>
      <button
        type="button"
        class="rmc-btn"
        data-action="reject"
        onclick={handleReject}
        disabled={pendingDismiss}
      >
        Reject
      </button>
    {:else}
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
  </footer>

  {#if replying}
    <div class="rmc-reply-composer" data-slot="review-reply-composer">
      <textarea
        bind:value={replyBody}
        class="rmc-reply-input"
        placeholder="Reply&hellip;"
        rows="2"
        onkeydown={handleReplyKeydown}
        onclick={(e) => e.stopPropagation()}
      ></textarea>
      <div class="rmc-reply-actions">
        <button type="button" class="rmc-btn" onclick={(e) => { e.stopPropagation(); replying = false; replyBody = ''; }}>
          Cancel
        </button>
        <button
          type="button"
          class="rmc-btn rmc-btn-primary"
          onclick={(e) => { e.stopPropagation(); submitReply(); }}
          disabled={replyBody.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .review-margin-card {
    display: block;
    /* Fluid: the margin slot (or orphan-tray list item) defines the
       width, inset 12px from the rail edges (attn-42y). */
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    background: var(--review-card-surface, var(--popover, var(--background, #fff)));
    color: var(--popover-foreground, inherit);
    border: 1px solid var(--review-card-border, var(--border, rgba(0, 0, 0, 0.10)));
    border-radius: 6px;
    font-size: 12px;
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

  .review-margin-card:hover,
  .review-margin-card[data-hovered='true'] {
    opacity: 1;
  }

  .review-margin-card[data-active='true'] {
    opacity: 1;
    box-shadow:
      var(--review-card-shadow, 0 10px 28px rgba(0, 0, 0, 0.14)),
      0 0 0 1px color-mix(in oklch, var(--primary, #2563eb) 46%, transparent);
    border-color: var(--accent-foreground, var(--primary, #2563eb));
  }

  .review-margin-card[data-pending-dismiss='true'] {
    opacity: 0.35;
    pointer-events: none;
  }

  .review-margin-card[data-kind='comment'] {
    border-left: 3px solid var(--review-card-comment-accent, var(--comment-highlight, #d9a600));
    padding-left: 10px;
  }

  .review-margin-card[data-kind='suggestion'] {
    border-left: 3px solid var(--review-card-suggestion-accent, var(--suggestion-bg, #16a34a));
    padding-left: 10px;
  }

  /* Stale state inherits the stale highlight tint so the card reads
     consistently with the inline mark. */
  .review-margin-card[data-state='stale'] {
    border-left: 3px solid var(--destructive, #dc2626);
    padding-left: 9px;
  }

  .review-margin-card[data-state='ambiguous'] {
    border-left: 3px solid var(--confidence-low, rgba(0, 0, 0, 0.18));
    padding-left: 9px;
  }

  .rmc-header {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 4px;
    font-size: 11px;
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
    color: #fff;
    font-size: 9px;
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

  .rmc-age {
    color: color-mix(in oklch, var(--foreground, currentColor) 62%, var(--muted-foreground, currentColor));
  }

  .rmc-spacer {
    flex: 1 1 auto;
  }

  .rmc-kind,
  .rmc-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 9999px;
    line-height: 1.4;
    border: 1px solid transparent;
  }

  .rmc-kind-suggestion {
    background: color-mix(in oklch, var(--review-card-suggestion-accent, #16a34a) 20%, transparent);
    color: color-mix(in oklch, var(--review-card-suggestion-accent, #16a34a) 78%, var(--foreground, currentColor));
    border-color: color-mix(in oklch, var(--review-card-suggestion-accent, #16a34a) 34%, transparent);
  }

  .rmc-kind-comment {
    background: color-mix(in oklch, var(--review-card-comment-accent, #d9a600) 20%, transparent);
    color: color-mix(in oklch, var(--review-card-comment-accent, #d9a600) 78%, var(--foreground, currentColor));
    border-color: color-mix(in oklch, var(--review-card-comment-accent, #d9a600) 34%, transparent);
  }

  .rmc-badge-moved {
    background: var(--confidence-med, rgba(0, 0, 0, 0.10));
  }

  .rmc-badge-ambiguous {
    background: var(--confidence-low, rgba(0, 0, 0, 0.06));
  }

  .rmc-badge-stale {
    background: var(--destructive, #dc2626);
    color: var(--destructive-foreground, #fff);
  }

  .rmc-badge-resolved {
    background: var(--muted, rgba(0, 0, 0, 0.06));
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
  }

  .rmc-quote {
    margin: 0 0 6px;
    padding: 0;
    color: color-mix(in oklch, var(--foreground, currentColor) 70%, var(--muted-foreground, currentColor));
    font-size: 11px;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Stale quote is rendered more prominently than `.rmc-quote` (multi-line
     clamp, accented border) so the user can scan for it in the editor. */
  .rmc-stale-quote {
    margin: 0 0 6px;
    padding: 4px 8px;
    background: var(--muted, rgba(0, 0, 0, 0.04));
    border-left: 2px solid var(--destructive, #dc2626);
    color: var(--foreground, inherit);
    font-size: 11px;
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
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
  }

  /* In-flight hint while the user is supposed to be selecting in PM. */
  .rmc-stale-hint {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--accent, rgba(37, 99, 235, 0.08));
    border-radius: 4px;
    font-size: 11px;
    color: var(--accent-foreground, var(--foreground, inherit));
  }

  .review-margin-card[data-awaiting-reanchor='true'] {
    box-shadow: 0 0 0 2px var(--destructive, #dc2626);
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
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    font-size: 11px;
  }

  .rmc-reply-list {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    border-top: 1px solid var(--border, rgba(0, 0, 0, 0.08));
  }

  .rmc-reply {
    display: flex;
    gap: 6px;
    padding: 6px 0 0;
    font-size: 12px;
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
    border-top: 1px solid var(--border, rgba(0, 0, 0, 0.08));
  }

  .rmc-reply-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
    border-radius: 4px;
    background: var(--background, #fff);
    color: var(--foreground, inherit);
    padding: 6px 8px;
    font-size: 12px;
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

  .rmc-btn {
    background: color-mix(in oklch, var(--background, transparent) 36%, transparent);
    border: 1px solid color-mix(in oklch, var(--foreground, currentColor) 18%, transparent);
    color: inherit;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .rmc-btn:hover {
    background: var(--muted, rgba(0, 0, 0, 0.04));
  }

  .rmc-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .rmc-btn-primary {
    background: var(--primary, #2563eb);
    color: var(--primary-foreground, #fff);
    border-color: var(--primary, #2563eb);
  }

  .rmc-btn-primary:hover {
    filter: brightness(0.96);
    background: var(--primary, #2563eb);
  }
</style>
