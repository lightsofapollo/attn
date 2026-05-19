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
  import { reviewAcceptSuggestion } from './ipc';
  import { reviewStore } from './review/store.svelte';
  import type { EventId, RoomId, Thread } from './types';

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
    state: CardState;
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
    /** Resolve handler — UI-only until resolve-comment IPC exists. */
    onResolve?: () => void;
    /** Locally-set marker — true after the user clicked reject/resolve and
     *  the IPC is not yet acknowledged (or doesn't exist yet). */
    pendingDismiss?: boolean;
  }

  let {
    thread,
    kind,
    state,
    active,
    hovered,
    offset,
    authorName,
    quotePreview,
    onActivate,
    onReject,
    onResolve,
    pendingDismiss = false,
  }: Props = $props();

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
    if (onReject) onReject();
  }

  function handleResolve(e: MouseEvent): void {
    e.stopPropagation();
    if (onResolve) onResolve();
  }

  function handleCardClick(): void {
    onActivate();
  }

  function handleKeydown(e: KeyboardEvent): void {
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
  data-state={state}
  data-active={active ? 'true' : 'false'}
  data-hovered={hovered ? 'true' : 'false'}
  data-offset={offset ? 'true' : 'false'}
  data-pending-dismiss={pendingDismiss ? 'true' : 'false'}
  onclick={handleCardClick}
  onkeydown={handleKeydown}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  role="group"
  tabindex="0"
  aria-label={`${kind} by ${authorName}, ${state}`}
>
  <header class="rmc-header">
    <span class="rmc-author">{authorName}</span>
    {#if ageLabel}<span class="rmc-age">· {ageLabel}</span>{/if}
    <span class="rmc-spacer"></span>
    {#if kind === 'suggestion'}
      <span class="rmc-kind rmc-kind-suggestion">suggest</span>
    {:else}
      <span class="rmc-kind rmc-kind-comment">comment</span>
    {/if}
    {#if state === 'remapped_moved'}
      <span class="rmc-badge rmc-badge-moved" title="anchor was remapped">moved</span>
    {:else if state === 'ambiguous'}
      <span class="rmc-badge rmc-badge-ambiguous" title="multiple anchor candidates">amb</span>
    {:else if state === 'stale'}
      <span class="rmc-badge rmc-badge-stale" title="anchor lost — needs re-anchor">stale</span>
    {:else if state === 'resolved'}
      <span class="rmc-badge rmc-badge-resolved">resolved</span>
    {/if}
  </header>

  {#if quotePreview}
    <p class="rmc-quote" title={quotePreview}>{quotePreview}</p>
  {/if}

  <p class="rmc-body">{body}</p>

  {#if thread.replies.length > 0}
    <p class="rmc-replies">{thread.replies.length} reply{thread.replies.length === 1 ? '' : 's'}</p>
  {/if}

  <footer class="rmc-actions">
    {#if kind === 'suggestion'}
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
      <button
        type="button"
        class="rmc-btn"
        data-action="resolve"
        onclick={handleResolve}
        disabled={pendingDismiss || state === 'resolved'}
      >
        Resolve
      </button>
    {/if}
  </footer>
</div>

<style>
  .review-margin-card {
    display: block;
    width: 320px;
    box-sizing: border-box;
    padding: 10px 12px;
    background: var(--popover, var(--background, #fff));
    color: var(--popover-foreground, inherit);
    border: 1px solid var(--border, rgba(0, 0, 0, 0.10));
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.4;
    cursor: pointer;
    text-align: left;
    opacity: 0.62;
    transition:
      opacity 120ms ease-out,
      box-shadow 120ms ease-out,
      border-color 120ms ease-out;
  }

  .review-margin-card:hover,
  .review-margin-card[data-hovered='true'] {
    opacity: 0.85;
  }

  .review-margin-card[data-active='true'] {
    opacity: 1;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    border-color: var(--accent-foreground, var(--primary, #2563eb));
  }

  .review-margin-card[data-pending-dismiss='true'] {
    opacity: 0.35;
    pointer-events: none;
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
    align-items: baseline;
    gap: 4px;
    margin-bottom: 4px;
    font-size: 11px;
  }

  .rmc-author {
    font-weight: 600;
  }

  .rmc-age {
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
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
    background: var(--suggestion-bg, transparent);
    color: var(--foreground, inherit);
  }

  .rmc-kind-comment {
    background: var(--comment-highlight, transparent);
    color: var(--foreground, inherit);
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
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    font-size: 11px;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rmc-body {
    margin: 0 0 8px;
    padding: 0;
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

  .rmc-actions {
    display: flex;
    gap: 6px;
  }

  .rmc-btn {
    background: transparent;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.14));
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
