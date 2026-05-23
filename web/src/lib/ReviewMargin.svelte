<!--
  ReviewMargin — Google-Docs-style margin overlay for review threads.

  Per `planning/collab/ui/review-panel-design.md` §1 the right-rail aside
  becomes an overlay container for sticky cards positioned to the y of
  their anchor. Cards walk in document order and push each other down
  on collision; offset cards get a thin SVG connector back to the
  highlight in the editor (§1.3).

  Orphan tray (§2) is sticky-pinned to the top of the overlay. It hosts
  ambiguous + stale + low-confidence remapped threads that cannot
  spatial-align.

  Resolved threads (§3) shrink to a single-line strip at their anchor
  position. When > 5 strips are visible a "show all resolved" pill
  collapses them.

  Subscribes to `reviewStore.events`, `reviewStore.anchorResolutions`,
  `reviewStore.focusEventId`, `reviewStore.hoveredEventId`. Recomputes
  per-card y on doc change via the editor's `view.coordsAtPos` (debounced
  through requestAnimationFrame).

  Performance: caps rendered cards at ~50 in viewport using
  `visibleCards` from `./review/margin-layout.ts`. Off-band cards still
  participate in collision-y calculation so on-band layout is correct.

  No emoji, no window.confirm/alert.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { Selection } from 'prosemirror-state';
  import type { EditorView } from 'prosemirror-view';
  import ReviewMarginCard from './ReviewMarginCard.svelte';
  import { positionAnchorFromSelection } from './review/anchors';
  import {
    layoutCards,
    visibleCards,
    type MarginCardInput,
    type MarginCardPlacement,
  } from './review/margin-layout';
  import { anchorTopY, hasTextSelection } from './review/popover-anchor';
  import { reviewStore } from './review/store.svelte';
  import { reviewResolveComment, reviewCreateComment } from './ipc';
  import type {
    EventId,
    PositionAnchor,
    ResolvedAnchor,
    Thread,
  } from './types';

  interface Props {
    /** The underlying ProseMirror view used for coordsAtPos. */
    view?: EditorView | undefined;
    /** Cap for in-DOM card rendering before virtualization kicks in. */
    maxRenderedCards?: number;
  }

  // Default cap is 50 per the task spec / §6 performance rule.
  let { view, maxRenderedCards = 50 }: Props = $props();

  // ---------------------------------------------------------------------------
  // Container refs + layout state
  // ---------------------------------------------------------------------------

  let containerEl: HTMLDivElement | undefined = $state(undefined);

  // Default card height used when we haven't measured one yet. The collision
  // layout requires *some* height; we replace per-card heights as we measure.
  const DEFAULT_CARD_HEIGHT = 96;
  const RESOLVED_STRIP_HEIGHT = 24;

  // Reactive geometry probes — bumped manually after each layout pass / on
  // scroll so the virtualization band stays in sync.
  let viewportTop = $state(0);
  let viewportHeight = $state(0);

  // Measured per-card heights (populated by an after-render pass below). Key
  // is thread id; value is height in px.
  const measuredHeights: Map<string, number> = new Map();

  // Stable per-card height lookup used by the layout pass. Falls back to
  // DEFAULT_CARD_HEIGHT for cards we haven't measured yet, and to the
  // collapsed strip height for resolved cards.
  function heightFor(thread: Thread): number {
    if (thread.resolved) return RESOLVED_STRIP_HEIGHT;
    const measured = measuredHeights.get(thread.id);
    return measured ?? DEFAULT_CARD_HEIGHT;
  }

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  // Pulled out of the store so the derived chain below depends on a single
  // identifier per piece of state (svelte-runes-friendly).
  const threads = $derived(reviewStore.threadsForCurrentFile);
  const ambiguous = $derived(reviewStore.ambiguousAnchors);
  const stale = $derived(reviewStore.staleAnchors);
  const resolutions = $derived(reviewStore.anchorResolutions);
  const focusEventId = $derived(reviewStore.focusEventId);
  const hoveredEventId = $derived(reviewStore.hoveredEventId);

  // Build a quick lookup: which thread ids belong in the orphan tray? A
  // thread is in the orphan tray when its root event id appears in the
  // ambiguous or stale resolution rows, or when its resolved verdict is
  // `remapped` with confidence < 0.70.
  //
  // The remapped<0.70 case lives here so the inline decoration (which
  // already drops below 0.70 per 10.2) is mirrored by a margin orphan
  // entry instead of a positioned card.
  const REMAP_PANEL_ONLY_CUTOFF = 0.70;

  const discardedStale = $derived(reviewStore.discardedStale);
  const manualReanchorState = $derived(reviewStore.manualReanchorState);

  const orphanThreadIds: Set<EventId> = $derived(buildOrphanIds(
    threads, ambiguous, stale, resolutions, discardedStale,
  ));

  function buildOrphanIds(
    ts: Thread[],
    amb: ReadonlyArray<{ eventId: EventId }>,
    stl: ReadonlyArray<{ eventId: EventId }>,
    rs: Record<EventId, { resolved: ResolvedAnchor }>,
    discarded: ReadonlySet<EventId>,
  ): Set<EventId> {
    const out = new Set<EventId>();
    for (const a of amb) out.add(a.eventId);
    // Stale rows the user clicked "Discard" on disappear from the tray
    // entirely (panel-only UX; the underlying event remains in the log).
    for (const s of stl) {
      if (!discarded.has(s.eventId)) out.add(s.eventId);
    }
    for (const t of ts) {
      const update = rs[t.rootEvent.meta.eventId];
      if (!update) continue;
      const res = update.resolved;
      if (res.status === 'remapped' && res.confidence < REMAP_PANEL_ONLY_CUTOFF) {
        out.add(t.rootEvent.meta.eventId);
      }
    }
    return out;
  }

  // Anchored (non-orphan, non-resolved) threads — these get y-positioned cards.
  const anchoredThreads: Thread[] = $derived(
    threads.filter(
      (t) =>
        !t.resolved
        && !orphanThreadIds.has(t.rootEvent.meta.eventId),
    ),
  );

  // Resolved threads — get the collapsed strip.
  const resolvedThreads: Thread[] = $derived(threads.filter((t) => t.resolved));

  // Orphan-tray threads — ambiguous + stale + low-confidence remapped that
  // currently exist as threads in the active file.
  const orphanThreads: Thread[] = $derived(
    threads.filter((t) => orphanThreadIds.has(t.rootEvent.meta.eventId)),
  );

  // ---------------------------------------------------------------------------
  // Y-position resolution + layout
  // ---------------------------------------------------------------------------

  // Per-thread anchorY (viewport-relative top from coordsAtPos), recomputed
  // whenever the editor view, doc, or store changes. Threads we can't
  // position fall back to 0 so they still appear (rather than vanish).
  //
  // The recomputation is bumped by an effect below that runs on doc-change
  // and store-change. `_recalcTick` exists to give that effect a synchronous
  // dependency it can mutate without infinite-looping.

  let _recalcTick = $state(0);

  // Bump the recompute tick. `untrack` the read of `_recalcTick` so that
  // callers running inside an $effect (the store-change recalc, the measured-
  // height pass, and the scroll/resize effect that invokes its handler
  // synchronously) do NOT take a reactive dependency on the very signal they
  // write — that read+write-same-state pattern is an infinite loop
  // (effect_update_depth_exceeded), which Svelte then disables, leaving anchor
  // positions (and thus inline comment/suggestion marks) un-rendered.
  function bumpRecalc(): void {
    _recalcTick = untrack(() => _recalcTick) + 1;
  }

  const anchorYs: Map<string, number> = $derived.by(() => {
    void _recalcTick; // force recompute on tick bump
    const out = new Map<string, number>();
    const v = view;
    if (!v) return out;
    const containerRect = containerEl?.getBoundingClientRect();
    const containerTop = containerRect?.top ?? 0;
    for (const t of anchoredThreads) {
      const pos = pmStartForThread(t);
      if (pos === null) continue;
      const y = anchorTopY(v, pos);
      if (y === null) continue;
      // Convert viewport-relative coords into container-relative coords
      // so cards stack inside the overlay (which sits inside the editor
      // scroll container — see §1.4).
      out.set(t.id, y - containerTop);
    }
    for (const t of resolvedThreads) {
      const pos = pmStartForThread(t);
      if (pos === null) continue;
      const y = anchorTopY(v, pos);
      if (y === null) continue;
      out.set(t.id, y - containerTop);
    }
    return out;
  });

  /**
   * Pick a ProseMirror start position for the thread's anchor.
   * Prefers the resolved verdict's `pmRange[0]` (kept fresh by the
   * resolver) and falls back to the original snapshot anchor's pmRange
   * or byteRange[0] when pmRange isn't available.
   */
  function pmStartForThread(t: Thread): number | null {
    const resolved = t.resolvedAnchor;
    if (resolved && (resolved.status === 'exact' || resolved.status === 'remapped')) {
      const r = resolved.currentRange;
      const pm = (r as PositionAnchor).pmRange;
      if (pm) return pm[0];
      return r.byteRange[0];
    }
    if (t.anchor) {
      const pm = t.anchor.position.pmRange;
      if (pm) return pm[0];
      return t.anchor.position.byteRange[0];
    }
    return null;
  }

  // Build the layout inputs from anchored threads and run the collision pass.
  // Returns one placement per anchored thread in the same order as
  // `anchoredThreads`.
  const placements: MarginCardPlacement[] = $derived.by(() => {
    const inputs: MarginCardInput[] = [];
    for (const t of anchoredThreads) {
      const y = anchorYs.get(t.id);
      if (y === undefined) continue;
      inputs.push({ id: t.id, anchorY: y, height: heightFor(t) });
    }
    return layoutCards(inputs);
  });

  // Index for the template (placements is in input order; we map by thread id).
  const placementByThread: Map<string, MarginCardPlacement> = $derived.by(() => {
    const m = new Map<string, MarginCardPlacement>();
    for (const p of placements) m.set(p.id, p);
    return m;
  });

  // Resolved strip placements — same y-rules, smaller height. Kept separate
  // from `placements` so collision is computed within the active set first.
  const resolvedPlacements: MarginCardPlacement[] = $derived.by(() => {
    const inputs: MarginCardInput[] = [];
    for (const t of resolvedThreads) {
      const y = anchorYs.get(t.id);
      if (y === undefined) continue;
      inputs.push({ id: t.id, anchorY: y, height: RESOLVED_STRIP_HEIGHT });
    }
    return layoutCards(inputs, { gutter: 2 });
  });

  // Virtualization band. Only render placements that fall within
  // viewport ± 800 px. Off-band placements still participate in layout
  // (because `placements` doesn't filter), so on-band positions are correct.
  const visiblePlacements: MarginCardPlacement[] = $derived.by(() => {
    if (placements.length <= maxRenderedCards) {
      return placements;
    }
    const heights = new Map<string, number>();
    for (const t of anchoredThreads) heights.set(t.id, heightFor(t));
    return visibleCards(placements, heights, {
      viewportTop,
      viewportHeight,
      bandPx: 800,
    });
  });

  // For the SVG connector layer: every offset placement gets a line drawn
  // from the card's left-mid back to the anchor's viewport y. The anchor
  // x is taken as the container's left edge (the cards live at right: 0
  // of the editor; the inline highlight is on the left).
  const connectorLines: Array<{
    id: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  }> = $derived.by(() => {
    const out: Array<{ id: string; fromX: number; fromY: number; toX: number; toY: number }> = [];
    for (const p of visiblePlacements) {
      if (!p.offset) continue;
      const cardH = measuredHeights.get(p.id) ?? DEFAULT_CARD_HEIGHT;
      out.push({
        id: p.id,
        fromX: 0,            // anchor side (left edge of overlay)
        fromY: p.anchorY,    // ideal y from coordsAtPos
        toX: 12,             // card edge — small inset so the line ends on the card
        toY: p.top + cardH / 2,
      });
    }
    return out;
  });

  // ---------------------------------------------------------------------------
  // Resolved-strip "show all" pill
  // ---------------------------------------------------------------------------

  let resolvedExpanded = $state(false);
  // Collapsed when more than 5 resolved strips would render.
  const COLLAPSED_RESOLVED_THRESHOLD = 5;
  const showResolvedPill = $derived(
    !resolvedExpanded && resolvedPlacements.length > COLLAPSED_RESOLVED_THRESHOLD,
  );

  // ---------------------------------------------------------------------------
  // Resolve a comment thread (attn-zhr). Mints a durable `CommentResolved`
  // event via the daemon; `reconstructThreads` flips `thread.resolved` off it
  // once the event round-trips, collapsing the card to its resolved strip. We
  // also dim the card optimistically (`pendingDismiss`) so the click feels
  // instant before the echo lands.
  // ---------------------------------------------------------------------------

  const locallyDismissed: Set<string> = $state(new Set());

  function resolveThread(threadId: string): void {
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    // `$state(new Set(...))` is reactive — mutating triggers reactivity.
    locallyDismissed.add(threadId);
    void reviewResolveComment(roomId, threadId);
  }

  // Post a reply (attn-1rm): a CommentCreated carrying the thread's existing id
  // and the root comment's anchor, so reconstructThreads groups it as a reply.
  function replyToThread(thread: Thread, body: string): void {
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    const root = thread.rootEvent.body;
    if (root.type !== 'comment_created') return; // replies only on comment threads
    void reviewCreateComment(roomId, root.anchor, body, thread.id);
  }

  // ---------------------------------------------------------------------------
  // Stale-card manual reanchor orchestration (attn-nnj.4.8)
  // ---------------------------------------------------------------------------
  //
  // The stale card has two actions: "Re-anchor manually" (drops the card
  // into pick-mode and waits for a PM selection) and "Discard" (hides the
  // card from the orphan tray without re-anchoring). The store owns the
  // single-card-at-a-time invariant; the margin component listens for
  // the editor selection that confirms the new anchor.

  function lookupRoomIdForStale(eventId: EventId): string | null {
    const update = resolutions[eventId];
    if (!update) return null;
    if (update.resolved.status !== 'stale') return null;
    return update.roomId;
  }

  function handleRequestReanchor(eventId: EventId): void {
    const roomId = lookupRoomIdForStale(eventId);
    if (!roomId) return;
    reviewStore.enterManualReanchor(eventId, roomId);
  }

  function handleDiscardStale(eventId: EventId): void {
    reviewStore.discardStaleCard(eventId);
  }

  function handleCancelReanchor(): void {
    reviewStore.cancelManualReanchor();
  }

  /**
   * Confirm the current PM selection as the new anchor for the stale
   * card currently in flight. Called by:
   *  - clicking the floating "Use this selection" overlay button, or
   *  - pressing Enter while a stale card is awaiting reanchor.
   * No-op when no card is in flight or when the PM selection is empty.
   */
  function confirmReanchorFromSelection(): void {
    const state = manualReanchorState;
    if (!state) return;
    const v = view;
    if (!v) return;
    if (!hasTextSelection(v)) return;
    const { from, to } = v.state.selection;
    const positionAnchor: PositionAnchor = positionAnchorFromSelection(v, from, to);
    reviewStore.confirmManualReanchor(positionAnchor);
  }

  // Global key listener: Enter confirms, Escape cancels. Only attached
  // while a stale card is in flight so we don't interfere with normal
  // editor input.
  $effect(() => {
    if (!manualReanchorState) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        reviewStore.cancelManualReanchor();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const v = view;
        if (!v || !hasTextSelection(v)) return;
        e.preventDefault();
        e.stopPropagation();
        confirmReanchorFromSelection();
      }
    };
    // Capture-phase so we run before the PM keymap handles Enter as a
    // paragraph split inside the editor.
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
    };
  });

  // ---------------------------------------------------------------------------
  // Side-effects: scroll / resize / view-change / recompute
  // ---------------------------------------------------------------------------

  // Bump _recalcTick on store changes so the y-position map re-derives.
  $effect(() => {
    void reviewStore.events;
    void reviewStore.anchorResolutions;
    void resolutions;
    bumpRecalc();
  });

  // Bump _recalcTick on a scroll/resize within the editor's scroll container
  // (which is also our positioning ancestor — the right-rail aside).
  $effect(() => {
    if (!containerEl) return;
    const scrollParent = containerEl.closest('[data-slot="scroll-area-viewport"]')
      ?? containerEl.parentElement;
    const handler = (): void => {
      bumpRecalc();
      if (scrollParent) {
        viewportTop = (scrollParent as HTMLElement).scrollTop;
        viewportHeight = (scrollParent as HTMLElement).clientHeight;
      }
    };
    handler();
    if (scrollParent) {
      scrollParent.addEventListener('scroll', handler, { passive: true });
    }
    window.addEventListener('resize', handler);
    return () => {
      if (scrollParent) scrollParent.removeEventListener('scroll', handler);
      window.removeEventListener('resize', handler);
    };
  });

  // After each render: measure each card's actual height into the cache so
  // the next layout pass uses real numbers. If anything changed, bump the
  // tick to re-run layout.
  $effect(() => {
    if (!containerEl) return;
    let dirty = false;
    const cardEls = containerEl.querySelectorAll<HTMLElement>(
      '[data-testid="review-margin-card"]',
    );
    for (const el of cardEls) {
      const threadId = el.dataset.threadId;
      if (!threadId) continue;
      const h = el.offsetHeight;
      if (h > 0 && measuredHeights.get(threadId) !== h) {
        measuredHeights.set(threadId, h);
        dirty = true;
      }
    }
    if (dirty) {
      bumpRecalc();
    }
  });

  // Focus card on focusEventId change — scroll into view + pulse.
  $effect(() => {
    const id = focusEventId;
    if (!id || !containerEl) return;
    // Find the card whose thread has rootEvent.eventId === id.
    const match = containerEl.querySelector<HTMLElement>(
      `[data-testid="review-margin-card"][data-thread-id]`,
    );
    if (!match) return;
    // The id is an event id, not a thread id; we look up the thread by
    // matching the rendered cards' data-thread-id against the threads list.
    const target = threads.find((t) => t.rootEvent.meta.eventId === id);
    if (!target) return;
    const el = containerEl.querySelector<HTMLElement>(
      `[data-testid="review-margin-card"][data-thread-id="${CSS.escape(target.id)}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // ---------------------------------------------------------------------------
  // Per-thread props derivation
  // ---------------------------------------------------------------------------

  function authorNameFor(t: Thread): string {
    // The Participant roster lives on the connection status. For now we
    // fall back to the raw participantId (matches ReviewApplyExpand which
    // does the same when no displayName has been pushed).
    const auth = t.rootEvent.meta.authorId;
    const peer = reviewStore.peers.find((p) => p.participantId === auth);
    return peer?.displayName ?? auth;
  }

  function kindFor(t: Thread): 'comment' | 'suggestion' {
    return t.rootEvent.body.type === 'suggestion_created' ? 'suggestion' : 'comment';
  }

  function stateFor(t: Thread):
    | 'open'
    | 'resolved'
    | 'remapped_moved'
    | 'ambiguous'
    | 'stale' {
    if (t.resolved) return 'resolved';
    const r = resolutions[t.rootEvent.meta.eventId];
    if (!r) return 'open';
    const res = r.resolved;
    if (res.status === 'stale') return 'stale';
    if (res.status === 'ambiguous') return 'ambiguous';
    if (res.status === 'remapped' && res.confidence < 0.90) {
      return 'remapped_moved';
    }
    return 'open';
  }

  function quotePreviewFor(t: Thread): string {
    return t.anchor?.quote?.exact ?? '';
  }

  function activateThread(t: Thread): void {
    reviewStore.setFocusEventId(t.rootEvent.meta.eventId);
    // Move the editor cursor too (§1.5 "Click a margin card → moves the
    // editor cursor to the anchor's start"). We use coordsAtPos via the
    // view so we can also scroll the editor into 1/3 viewport.
    const v = view;
    if (!v) return;
    const pos = pmStartForThread(t);
    if (pos === null) return;
    try {
      const tr = v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos)));
      v.dispatch(tr);
    } catch {
      // Selection setting can fail on torn-down or read-only states; ignore.
    }
  }
</script>

<div bind:this={containerEl} class="review-margin" data-slot="review-margin">
  <!-- Orphan tray: sticky-top per §2 -->
  {#if orphanThreads.length > 0}
    <section
      class="review-margin-tray"
      data-testid="review-margin-tray"
      aria-label="Needs attention"
    >
      <header class="rmt-header">
        {orphanThreads.length} need{orphanThreads.length === 1 ? '' : 's'} attention
      </header>
      <ul class="rmt-list">
        {#each orphanThreads as t (t.id)}
          <li>
            <ReviewMarginCard
              thread={t}
              kind={kindFor(t)}
              state={stateFor(t)}
              active={focusEventId === t.rootEvent.meta.eventId}
              hovered={hoveredEventId === t.rootEvent.meta.eventId}
              offset={false}
              authorName={authorNameFor(t)}
              quotePreview={quotePreviewFor(t)}
              onActivate={() => activateThread(t)}
              onReject={() => dismissLocally(t.id)}
              onResolve={() => resolveThread(t.id)}
              onReply={(body) => replyToThread(t, body)}
              pendingDismiss={locallyDismissed.has(t.id)}
              onRequestReanchor={() => handleRequestReanchor(t.rootEvent.meta.eventId)}
              onDiscardStale={() => handleDiscardStale(t.rootEvent.meta.eventId)}
              onCancelReanchor={handleCancelReanchor}
              awaitingReanchor={manualReanchorState?.eventId === t.rootEvent.meta.eventId}
            />
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- SVG connector layer for offset cards (§1.3 step 3) -->
  {#if connectorLines.length > 0}
    <svg
      class="review-margin-connectors"
      data-testid="review-margin-connectors"
      aria-hidden="true"
      width="320"
      height="100%"
    >
      {#each connectorLines as line (line.id)}
        <line
          x1={line.fromX}
          y1={line.fromY}
          x2={line.toX}
          y2={line.toY}
          stroke="currentColor"
          stroke-width="1"
          opacity="0.35"
        />
      {/each}
    </svg>
  {/if}

  <!-- Anchored cards positioned at their resolved y -->
  {#each visiblePlacements as p (p.id)}
    {@const t = anchoredThreads.find((th) => th.id === p.id)}
    {#if t}
      <div class="review-margin-slot" style="top: {p.top}px;">
        <ReviewMarginCard
          thread={t}
          kind={kindFor(t)}
          state={stateFor(t)}
          active={focusEventId === t.rootEvent.meta.eventId}
          hovered={hoveredEventId === t.rootEvent.meta.eventId}
          offset={p.offset}
          authorName={authorNameFor(t)}
          quotePreview={quotePreviewFor(t)}
          onActivate={() => activateThread(t)}
          onReject={() => dismissLocally(t.id)}
          onResolve={() => resolveThread(t.id)}
              onReply={(body) => replyToThread(t, body)}
          pendingDismiss={locallyDismissed.has(t.id)}
        />
      </div>
    {/if}
  {/each}

  <!-- Resolved strips: collapsed line per §3, hidden behind "show all" pill -->
  {#if resolvedExpanded || resolvedPlacements.length <= COLLAPSED_RESOLVED_THRESHOLD}
    {#each resolvedPlacements as p (p.id)}
      {@const t = resolvedThreads.find((th) => th.id === p.id)}
      {#if t}
        <button
          type="button"
          class="review-margin-resolved-strip"
          data-testid="review-margin-resolved-strip"
          data-thread-id={t.id}
          style="top: {p.top}px;"
          onclick={() => activateThread(t)}
        >
          ✓ {authorNameFor(t)} · resolved
        </button>
      {/if}
    {/each}
  {/if}

  {#if showResolvedPill}
    <button
      type="button"
      class="review-margin-resolved-pill"
      data-testid="review-margin-resolved-pill"
      onclick={() => { resolvedExpanded = true; }}
    >
      {resolvedPlacements.length} resolved · show
    </button>
  {/if}

  {#if threads.length === 0 && orphanThreads.length === 0}
    <p class="review-margin-empty" data-testid="review-margin-empty">
      No review threads on this file.
    </p>
  {/if}

  <!--
    Global select-mode overlay (attn-nnj.4.8). Appears whenever a stale
    card is awaiting a new anchor. The "Use this selection" button confirms
    the current PM selection; Cancel clears the in-flight state. The
    overlay is rendered at the bottom of the margin so it doesn't fight
    with sticky-top orphan-tray scroll behavior.
  -->
  {#if manualReanchorState}
    <div
      class="review-margin-reanchor-overlay"
      data-testid="review-margin-reanchor-overlay"
      data-event-id={manualReanchorState.eventId}
      role="region"
      aria-label="Re-anchor stale comment"
    >
      <p class="rmro-hint">
        Select the new location for this comment in the editor, then click
        “Use this selection”.
      </p>
      <div class="rmro-actions">
        <button
          type="button"
          class="rmro-btn rmro-btn-primary"
          data-testid="review-margin-reanchor-confirm"
          onclick={confirmReanchorFromSelection}
        >
          Use this selection
        </button>
        <button
          type="button"
          class="rmro-btn"
          data-testid="review-margin-reanchor-cancel"
          onclick={handleCancelReanchor}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* The overlay is positioned absolute *inside* the editor scroll container
     (§1.4). The parent `<aside>` in App.svelte already supplies the 320 px
     width slot; this container fills the slot height and lets cards stack
     in document space. */
  .review-margin {
    position: relative;
    width: 320px;
    height: 100%;
    overflow: visible;
    pointer-events: auto;
    color: var(--foreground, inherit);
  }

  /* Sticky-top orphan tray (§2). z-indexed above anchored cards so it
     pins while the user scrolls past them. */
  .review-margin-tray {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--background, #fff);
    border: 1px solid var(--border, rgba(0, 0, 0, 0.10));
    border-radius: 6px;
    padding: 6px;
    margin: 0 0 8px;
    max-height: 40vh;
    overflow: auto;
  }

  .rmt-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    padding: 4px 6px 6px;
  }

  .rmt-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* SVG connector layer sits behind the cards (z 0 vs cards' z 1). */
  .review-margin-connectors {
    position: absolute;
    inset: 0;
    pointer-events: none;
    color: var(--accent-foreground, var(--muted-foreground, #888));
    z-index: 0;
  }

  /* Each absolutely-positioned card slot. `top` is set inline per layout. */
  .review-margin-slot {
    position: absolute;
    right: 0;
    z-index: 1;
  }

  /* Resolved single-line strip per §3. */
  .review-margin-resolved-strip {
    position: absolute;
    right: 0;
    width: 320px;
    box-sizing: border-box;
    height: 24px;
    line-height: 22px;
    padding: 0 10px;
    background: transparent;
    border: 0;
    border-top: 1px dashed var(--border, rgba(0, 0, 0, 0.10));
    border-bottom: 1px dashed var(--border, rgba(0, 0, 0, 0.10));
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    z-index: 1;
  }

  .review-margin-resolved-strip:hover {
    background: var(--muted, rgba(0, 0, 0, 0.03));
    color: var(--foreground, inherit);
  }

  /* Bottom pill — shown when collapsed-resolved count exceeds threshold. */
  .review-margin-resolved-pill {
    position: sticky;
    bottom: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 12px;
    background: var(--muted, rgba(0, 0, 0, 0.04));
    border: 1px solid var(--border, rgba(0, 0, 0, 0.10));
    border-radius: 9999px;
    font-size: 11px;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    cursor: pointer;
    text-align: center;
    z-index: 2;
  }

  .review-margin-resolved-pill:hover {
    background: var(--accent, rgba(0, 0, 0, 0.06));
    color: var(--foreground, inherit);
  }

  /* Empty state — no threads, no orphan rows. */
  .review-margin-empty {
    padding: 14px 12px;
    color: var(--muted-foreground, rgba(0, 0, 0, 0.55));
    font-size: 12px;
    text-align: center;
  }

  /* Floating overlay shown while a stale card waits for a new anchor. */
  .review-margin-reanchor-overlay {
    position: sticky;
    bottom: 8px;
    margin: 12px 0 0;
    padding: 10px 12px;
    background: var(--popover, var(--background, #fff));
    border: 1px solid var(--destructive, #dc2626);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.15);
    font-size: 12px;
    z-index: 3;
  }

  .rmro-hint {
    margin: 0 0 8px;
    color: var(--foreground, inherit);
    line-height: 1.4;
  }

  .rmro-actions {
    display: flex;
    gap: 6px;
  }

  .rmro-btn {
    background: transparent;
    border: 1px solid var(--border, rgba(0, 0, 0, 0.14));
    color: inherit;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .rmro-btn:hover {
    background: var(--muted, rgba(0, 0, 0, 0.04));
  }

  .rmro-btn-primary {
    background: var(--primary, #2563eb);
    color: var(--primary-foreground, #fff);
    border-color: var(--primary, #2563eb);
  }

  .rmro-btn-primary:hover {
    filter: brightness(0.96);
    background: var(--primary, #2563eb);
  }
</style>
