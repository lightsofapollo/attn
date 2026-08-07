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

  Resolved threads (§3, amended by attn-d7y) shrink to a compact chip at
  their anchor position. Clicking a chip expands it in place to the full
  read-only card (Collapse/Escape to shrink back). When the margin holds
  ONLY resolved chips the rail slims to a 48px gutter of icon chips — see
  `./review/rail-mode.ts`; `reviewStore.railMode` drives both the aside
  width (App.svelte) and the chip variant here. When > 5 chips would
  render in full mode a "show all resolved" pill collapses them.

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
  import { tick } from 'svelte';
  import { Selection } from 'prosemirror-state';
  import type { EditorView } from 'prosemirror-view';
  import ReviewMarginCard from './ReviewMarginCard.svelte';
  import { positionAnchorFromSelection } from './review/anchors';
  import {
    fitBottom,
    layoutCards,
    visibleCards,
    type MarginCardInput,
    type MarginCardPlacement,
  } from './review/margin-layout';
  import { AGENT_GLYPH, monogramFor, type PeerKind } from './peer-strip-format';
  import { anchorTopY, hasTextSelection } from './review/popover-anchor';
  import {
    COLLAPSED_RAIL_TOP_CLEARANCE,
    RESOLVED_CHIP_HEIGHT,
  } from './review/rail-mode';
  import { reviewStore } from './review/store.svelte';
  import { createFrameInvalidator } from './review/frame-invalidator';
  import { nearestScrollableAncestor } from './scroll-viewport';
  import {
    selectSuggestionActionPort,
    shouldDismissSuggestionAfterAction,
    type SuggestionActionPort,
  } from './review/suggestion-action-port';
  import { isThreadActive } from './review/thread-visibility';
  import {
    reviewAcceptSuggestion,
    reviewCreateComment,
    reviewRejectSuggestion,
    reviewResolveComment,
  } from './ipc';
  import type {
    Anchor,
    EventId,
    PositionAnchor,
    ResolvedAnchor,
    Thread,
  } from './types';

  interface Props {
    /** The underlying ProseMirror view used for coordsAtPos. */
    view?: EditorView | undefined;
    /**
     * `anchored` (default) positions each card at its anchor's editor y —
     * the right-rail overlay design. `stacked` renders a plain document-order
     * list instead, for hosts with no geometric relationship to the editor
     * (the mobile bottom sheet — an anchored card deep in the document would
     * land below the sheet's fold and the sheet opens looking empty).
     */
    layout?: 'anchored' | 'stacked';
    /** Cap for in-DOM card rendering before virtualization kicks in. */
    maxRenderedCards?: number;
    /** Hide every mutation surface while keeping thread navigation readable. */
    readOnly?: boolean;
    /** Allow only reviewer comment reply/resolve actions in hosted mode. */
    reviewerAuthoring?: boolean;
    /**
     * Hosted suggestion authority. Omit for native IPC defaults; pass an
     * empty object when hosted authority is unavailable so controls stay
     * absent instead of falling through to native IPC.
     */
    suggestionActions?: SuggestionActionPort<Thread>;
    onResolveComment?: (threadId: string) => Promise<void> | void;
    onReplyComment?: (anchor: Anchor, body: string, threadId: string) => Promise<void> | void;
  }

  // Default cap is 50 per the task spec / §6 performance rule.
  let {
    view,
    layout = 'anchored',
    maxRenderedCards = 50,
    readOnly = false,
    reviewerAuthoring = false,
    suggestionActions,
    onResolveComment,
    onReplyComment,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Container refs + layout state
  // ---------------------------------------------------------------------------

  let containerEl: HTMLDivElement | undefined = $state(undefined);

  // Default card height used when we haven't measured one yet. The collision
  // layout requires *some* height; we replace per-card heights as we measure.
  const DEFAULT_CARD_HEIGHT = 96;

  // Reactive geometry probes — bumped manually after each layout pass / on
  // scroll so the virtualization band stays in sync.
  let viewportTop = $state(0);
  let viewportHeight = $state(0);

  // Measured per-card heights (populated by an after-render pass below). Key
  // is thread id; value is height in px.
  const measuredHeights: Map<string, number> = new Map();

  // Stable per-card height lookup used by the layout pass. Falls back to
  // DEFAULT_CARD_HEIGHT for cards we haven't measured yet, and to the
  // collapsed chip height for resolved threads — unless that thread is the
  // expanded one, which renders a full card and uses its measured height.
  function heightFor(thread: Thread): number {
    if (thread.resolved && thread.id !== expandedResolvedId) {
      return RESOLVED_CHIP_HEIGHT;
    }
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

  // Rail mode (hidden/collapsed/expanded) is derived on the store so
  // App.svelte's aside width and our rendering agree. `collapsed` is the
  // 48px gutter: author-avatar chips for unresolved threads, ✓ chips for
  // resolved ones (attn-42y).
  // The stacked bottom sheet (mobile) always shows full cards — Reading's
  // collapsed marker gutter is a desktop-margin concept; a sheet the user
  // explicitly opened must never render bare avatar chips (user report).
  const collapsed = $derived(layout !== 'stacked' && reviewStore.railMode === 'collapsed');

  // The one resolved thread currently expanded to a full read-only card
  // (attn-d7y). Store-owned; expanding also expands the rail.
  const expandedResolvedId = $derived(reviewStore.expandedResolvedThread?.id ?? null);

  // Optimistic dismissals (Resolve/Reject clicked) — store-owned so the
  // rail-mode derivation sees them the same tick. See store doc.
  const locallyDismissed = $derived(reviewStore.locallyDismissed);

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
  // Locally-dismissed threads (Resolve clicked, or Reject which is UI-only) are
  // hidden optimistically: `locallyDismissed` USED to only disable the buttons
  // (pendingDismiss) while waiting for a CommentResolved echo — but if that echo
  // never arrives (e.g. relay-only / offline), the card lingered with Reply and
  // Resolve dead forever. Filtering it out here removes the card immediately.
  const anchoredThreads: Thread[] = $derived(
    threads.filter(
      (t) =>
        isThreadActive(t, locallyDismissed)
        && !orphanThreadIds.has(t.rootEvent.meta.eventId),
    ),
  );

  // Resolved threads — get the collapsed chip (or the expanded card).
  const resolvedThreads: Thread[] = $derived(threads.filter((t) => t.resolved));

  // "Show all resolved" pill state (expanded mode only). When more than
  // the threshold of chips would render and the user hasn't asked for
  // them, the chips hide behind a count pill. The collapsed gutter
  // ignores the pill — it can't fit one, and icon chips are cheap.
  let showAllResolved = $state(false);
  const COLLAPSED_RESOLVED_THRESHOLD = 5;
  const showResolvedPill = $derived(
    !collapsed && !showAllResolved && resolvedThreads.length > COLLAPSED_RESOLVED_THRESHOLD,
  );

  const resolvedChipsVisible = $derived(
    showAllResolved || resolvedThreads.length <= COLLAPSED_RESOLVED_THRESHOLD,
  );

  // Resolved threads that take part in layout/render: chip-visible ones
  // plus the expanded thread, which must always render even while the
  // pill hides the other chips.
  const layoutResolvedThreads: Thread[] = $derived(
    resolvedThreads.filter((t) => resolvedChipsVisible || t.id === expandedResolvedId),
  );

  // Stacked layout (mobile bottom sheet): a plain document-order list.
  // Anchored + layout-visible resolved threads, ordered by their anchor's pm
  // position (position-less ones last, then by creation time). No collision
  // pass, no absolute positioning — the sheet has no geometric relationship
  // to the editor, so anchor-y placement just pushes cards below its fold.
  const stacked = $derived(layout === 'stacked' && !collapsed);
  const stackedThreads: Thread[] = $derived.by(() => {
    if (!stacked) return [];
    const pool = [...anchoredThreads, ...layoutResolvedThreads];
    const posOf = (t: Thread): number => pmStartForThread(t) ?? Number.MAX_SAFE_INTEGER;
    pool.sort((a, b) => {
      const d = posOf(a) - posOf(b);
      if (d !== 0) return d;
      return a.rootEvent.meta.createdAt - b.rootEvent.meta.createdAt;
    });
    return pool.slice(0, maxRenderedCards);
  });

  // Template lookup for the unified placements list.
  const threadById: Map<string, Thread> = $derived.by(() => {
    const m = new Map<string, Thread>();
    for (const t of threads) m.set(t.id, t);
    return m;
  });

  // Orphan-tray threads — ambiguous + stale + low-confidence remapped that
  // currently exist as threads in the active file. Excludes resolved (mirrors
  // anchoredThreads): without `!t.resolved`, resolving an orphan-tray comment
  // left it stuck in the tray with Reply/Resolve disabled (pendingDismiss), so
  // it could never be dismissed.
  const orphanThreads: Thread[] = $derived(
    threads.filter(
      (t) =>
        isThreadActive(t, locallyDismissed)
        && orphanThreadIds.has(t.rootEvent.meta.eventId),
    ),
  );

  // ---------------------------------------------------------------------------
  // Y-position resolution + layout
  // ---------------------------------------------------------------------------

  // Per-thread anchorY (viewport-relative top from coordsAtPos), recomputed
  // whenever the editor view, doc, or store changes. Threads we can't
  // position fall back to 0 so they still appear (rather than vanish).
  //
  // The recomputation is bumped by effects below that run on doc, store, and
  // measured-height changes. `_recalcTick` is the explicit invalidation signal;
  // writes to it are frame-separated below so they cannot recurse in one flush.

  let _recalcTick = $state(0);

  // The height-measurement effect depends on placements, and placements depend
  // on this tick. A synchronous write here therefore forms an INDIRECT
  // effect -> derived -> effect loop when file-switch remount heights oscillate.
  // Cross a frame boundary so all geometry callbacks coalesce and no
  // invalidation can recurse inside the current Svelte flush (attn-db2a).
  const recalcInvalidator = createFrameInvalidator(() => {
    _recalcTick += 1;
  });

  function bumpRecalc(): void {
    recalcInvalidator.request();
  }

  $effect(() => () => recalcInvalidator.cancel());

  // Last-seen container top in viewport coords. Plain (non-reactive) on
  // purpose: refreshed by the `anchorYs` derived (which every placement
  // pass depends on), and read by the collapsed-chip clamp to tell
  // "anchor is in the header band above the rail" (pin the chip) apart
  // from "anchor scrolled above the window" (let the chip clip away).
  let lastContainerTop = 0;

  const anchorYs: Map<string, number> = $derived.by(() => {
    void _recalcTick; // force recompute on tick bump
    const out = new Map<string, number>();
    const v = view;
    const containerRect = containerEl?.getBoundingClientRect();
    const containerTop = containerRect?.top ?? 0;
    lastContainerTop = containerTop;
    if (v) {
      for (const t of anchoredThreads) {
        const pos = pmStartForThread(t);
        if (pos === null) continue;
        const y = anchorTopY(v, pos);
        if (y === null) continue;
        // Convert viewport-relative coords into container-relative coords.
        // These are positions "as currently on screen" — the scroll effect
        // below (attn-23m) recomputes them on every document scroll, which
        // is what keeps cards tied to their anchor text.
        out.set(t.id, y - containerTop);
      }
    }
    // Resolved chips always get a y — fall back to 0 (the collision pass
    // stacks them from the top) when the view is missing or the position
    // can't be resolved, so the slim gutter never renders as an empty
    // column with its chips silently dropped.
    for (const t of resolvedThreads) {
      let y: number | null = null;
      if (v) {
        const pos = pmStartForThread(t);
        if (pos !== null) y = anchorTopY(v, pos);
      }
      out.set(t.id, y === null ? 0 : y - containerTop);
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

  /**
   * Breathing room between the rail's top edge and any card/chip whose
   * anchor is still ON SCREEN (attn-2aj — cards must not sit flush
   * against the rail header). Anchors scrolled above the WINDOW keep
   * their negative y so the card clips away with its text (attn-23m's
   * 1:1 tracking is preserved everywhere except this top band, where
   * Google-Docs-style pinning is the better behavior).
   */
  function clampRailTop(y: number): number {
    const viewportY = y + lastContainerTop;
    return viewportY < 0 ? y : Math.max(y, COLLAPSED_RAIL_TOP_CLEARANCE);
  }

  // Build the layout inputs from anchored threads AND layout-visible
  // resolved threads, then run ONE collision pass. A single pass means an
  // expanded resolved card pushes its neighbors instead of overlapping
  // them (the previous two-pass layout let strips overlap active cards).
  // `layoutCards` sorts by anchorY internally, so input order is free.
  // The fitBottom pass then lifts cards whose anchors are on screen so
  // they are never cut off at the rail's bottom edge.
  // Docs-style active-card rule: the focused thread aligns exactly to its
  // anchor; neighbors move out of its way instead of pushing it down.
  const priorityThreadId = $derived.by(() => {
    if (!focusEventId) return undefined;
    return threads.find((t) => t.rootEvent.meta.eventId === focusEventId)?.id;
  });

  const placements: MarginCardPlacement[] = $derived.by(() => {
    const inputs: MarginCardInput[] = [];
    for (const t of anchoredThreads) {
      const y = anchorYs.get(t.id);
      if (y === undefined) continue;
      inputs.push({ id: t.id, anchorY: clampRailTop(y), height: heightFor(t) });
    }
    for (const t of layoutResolvedThreads) {
      const y = anchorYs.get(t.id);
      if (y === undefined) continue;
      inputs.push({ id: t.id, anchorY: clampRailTop(y), height: heightFor(t) });
    }
    const placed = layoutCards(
      inputs,
      priorityThreadId === undefined ? undefined : { priorityId: priorityThreadId },
    );
    const containerH = containerEl?.clientHeight ?? 0;
    if (containerH <= 0) return placed;
    const heights = new Map(inputs.map((i) => [i.id, i.height]));
    return fitBottom(placed, heights, { containerHeight: containerH });
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
    for (const t of layoutResolvedThreads) heights.set(t.id, heightFor(t));
    return visibleCards(placements, heights, {
      viewportTop,
      viewportHeight,
      bandPx: 800,
    });
  });

  // Collapsed-gutter chip placements (attn-42y): EVERY visible thread —
  // unresolved (incl. orphan-tray ones, which have no anchor position and
  // fall back to the top) as author-avatar chips, resolved as ✓ chips.
  // Tops are clamped below the floating ReviewBar dock. Shares the
  // expanded rail's virtualization band so a huge thread count doesn't
  // bypass the §6 ~50-node DOM cap.
  const collapsedChipPlacements: MarginCardPlacement[] = $derived.by(() => {
    if (!collapsed) return [];
    const inputs: MarginCardInput[] = [];
    for (const t of threads) {
      if (!t.resolved && !isThreadActive(t, locallyDismissed)) continue;
      // Position-less threads (orphans, unresolvable anchors) pin at the
      // gutter top; on-screen anchors clamp via clampRailTop, anchors
      // scrolled above the window clip away with their text.
      const y = anchorYs.get(t.id) ?? COLLAPSED_RAIL_TOP_CLEARANCE;
      inputs.push({
        id: t.id,
        anchorY: clampRailTop(y),
        height: RESOLVED_CHIP_HEIGHT,
      });
    }
    const heights = new Map(inputs.map((i) => [i.id, i.height]));
    let placed = layoutCards(inputs);
    const containerH = containerEl?.clientHeight ?? 0;
    if (containerH > 0) {
      placed = fitBottom(placed, heights, { containerHeight: containerH });
    }
    if (placed.length <= maxRenderedCards) return placed;
    return visibleCards(placed, heights, { viewportTop, viewportHeight, bandPx: 800 });
  });

  // For the SVG connector layer: every offset placement gets a line drawn
  // from the card's left-mid back to the anchor's viewport y. The anchor
  // x is taken as the container's left edge (the cards live at right: 0
  // of the editor; the inline highlight is on the left). Collapsed chips
  // get no connector — the line-to-midpoint math assumes card heights and
  // the tiny chips would just add noise.
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
      const t = threadById.get(p.id);
      if (!t || (t.resolved && t.id !== expandedResolvedId)) continue;
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
  // Resolve a comment thread (attn-zhr). Mints a durable `CommentResolved`
  // event via the daemon; `reconstructThreads` flips `thread.resolved` off it
  // once the event round-trips, collapsing the card to its resolved chip. We
  // also dim the card optimistically (`pendingDismiss`) so the click feels
  // instant before the echo lands. The dismissed-set lives on the store so
  // `railMode` slims the rail in the same tick (attn-d7y).
  // ---------------------------------------------------------------------------

  async function resolveThread(threadId: string): Promise<void> {
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    try {
      if (onResolveComment) await onResolveComment(threadId);
      else await reviewResolveComment(roomId, threadId);
      reviewStore.dismissThreadLocally(threadId);
    } catch {
      // The injected browser session exposes the transport error beside its
      // outbox indicator; keep the thread visible so the user can retry.
    }
  }

  const nativeSuggestionActions: SuggestionActionPort<Thread> = {
    accept: async (thread) => {
      const root = thread.rootEvent.body;
      if (root.type !== 'suggestion_created') return;
      await reviewAcceptSuggestion(thread.rootEvent.meta.roomId, root.suggestionId);
    },
    reject: async (thread) => {
      const root = thread.rootEvent.body;
      if (root.type !== 'suggestion_created') return;
      await reviewRejectSuggestion(thread.rootEvent.meta.roomId, root.suggestionId);
    },
  };

  const suggestionActionPort: SuggestionActionPort<Thread> = $derived(
    selectSuggestionActionPort(suggestionActions, nativeSuggestionActions),
  );

  async function acceptSuggestion(thread: Thread): Promise<unknown> {
    const result = await suggestionActionPort.accept?.(thread);
    // Native accept continues to resolve from its daemon event echo. Hosted
    // actions, however, return only after the browser transition is durable;
    // dismiss committed results immediately, including durable outbox rows.
    if (
      suggestionActions !== undefined
      && shouldDismissSuggestionAfterAction(result)
    ) {
      reviewStore.dismissThreadLocally(thread.id);
    }
    return result;
  }

  async function rejectSuggestion(thread: Thread): Promise<unknown> {
    const result = await suggestionActionPort.reject?.(thread);
    // `deliveryPending` is already durable locally. The shared outbox
    // indicator owns its non-destructive retry status, while the decided
    // suggestion leaves the active rail.
    if (shouldDismissSuggestionAfterAction(result)) {
      reviewStore.dismissThreadLocally(thread.id);
    }
    return result;
  }

  // Post a reply (attn-1rm): a CommentCreated carrying the thread's existing id
  // and the root comment's anchor, so reconstructThreads groups it as a reply.
  async function replyToThread(thread: Thread, body: string): Promise<void> {
    const roomId = reviewStore.currentRoomId;
    if (!roomId) return;
    const root = thread.rootEvent.body;
    if (root.type !== 'comment_created') return; // replies only on comment threads
    if (onReplyComment) await onReplyComment(root.anchor, body, thread.id);
    else await reviewCreateComment(roomId, root.anchor, body, thread.id);
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
  // editor input. Never armed while the rail is collapsed — the stale
  // card and confirm overlay only render in the expanded branch, and an
  // invisible capture handler would hijack editor Enter/Escape
  // (togglePanel cancels the flow on collapse; this guard covers direct
  // panelOpen writes too).
  $effect(() => {
    if (collapsed) return;
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

  // Escape collapses the expanded resolved card from anywhere (the card's
  // own keydown handler only fires while the card has focus). Yields to
  // the manual-reanchor flow — that listener owns Escape while a stale
  // card is in flight — and to editable targets so it never eats an
  // Escape meant to cancel typing. Never armed while the rail is
  // collapsed: the card isn't rendered there, and a stale handler would
  // swallow the Escape that should close a dialog or dropdown.
  $effect(() => {
    if (collapsed) return;
    const expanded = reviewStore.expandedResolvedThread;
    if (!expanded) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (manualReanchorState) return;
      const target = e.target as HTMLElement | null;
      if (
        target
        && (target.isContentEditable
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'INPUT')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void collapseResolved(expanded);
    };
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

  // Keep cards tied to their anchors while the DOCUMENT scrolls (attn-23m).
  //
  // The margin lives inside the right-rail aside — a SIBLING of the editor's
  // scroll container — and `anchorYs` is built from `view.coordsAtPos`
  // (viewport-relative), so every document scroll invalidates every card
  // position. The old listener attached to `containerEl.closest(...)
  // ?? containerEl.parentElement`, which resolved to the aside itself — an
  // element that never scrolls — so cards were positioned once on store
  // changes and then froze while the text moved underneath them.
  //
  // Attach to the EDITOR's scroll viewport (found from `view.dom`, which is
  // robust to layout reshuffles) and recompute per scroll tick; coordsAtPos
  // then yields fresh viewport coords and the cards track their anchors
  // 1:1, Google-Docs style. A ResizeObserver on the editor DOM catches
  // typing/content reflows that shift anchor positions without scrolling.
  // The aside itself no longer scrolls, so document scroll is the single
  // source of vertical movement. The viewport is found by walking computed
  // overflow — NOT by the ScrollArea slot selector, which does not exist on
  // the reviewer /s/ page (its plain overflow-auto scroller left the margin
  // with no scroll listener at all: cards froze while the text moved).
  $effect(() => {
    if (!containerEl) return;
    const v = view;
    const editorViewport = v ? nearestScrollableAncestor(v.dom) : null;
    const recompute = (): void => {
      bumpRecalc();
      // Card tops are viewport-anchored container coords now, so the
      // virtualization band is simply the container's own box.
      viewportTop = 0;
      viewportHeight = containerEl?.clientHeight ?? 0;
    };
    // Coalesce to one recompute per animation frame. Each recompute invalidates
    // anchorYs, which calls view.coordsAtPos() (a forced reflow) per thread —
    // running that on every raw scroll event caused jank in busy review rooms.
    let rafId: number | null = null;
    const handler = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        recompute();
      });
    };
    recompute();
    editorViewport?.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler);
    let resizeObserver: ResizeObserver | null = null;
    if (v && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handler);
      resizeObserver.observe(v.dom);
    }
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      editorViewport?.removeEventListener('scroll', handler);
      window.removeEventListener('resize', handler);
      resizeObserver?.disconnect();
    };
  });

  // After each render: measure each card's actual height into the cache so
  // the next layout pass uses real numbers. If anything changed, bump the
  // tick to re-run layout.
  $effect(() => {
    void visiblePlacements;
    if (!containerEl) return;
    const measure = (): void => {
      let dirty = false;
      const cardEls = containerEl?.querySelectorAll<HTMLElement>(
        '[data-testid="review-margin-card"]',
      );
      for (const el of cardEls ?? []) {
        const threadId = el.dataset.threadId;
        if (!threadId) continue;
        const h = el.offsetHeight;
        if (h > 0 && measuredHeights.get(threadId) !== h) {
          measuredHeights.set(threadId, h);
          dirty = true;
        }
      }
      if (dirty) bumpRecalc();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const card of containerEl.querySelectorAll<HTMLElement>(
      '[data-testid="review-margin-card"]',
    )) {
      observer.observe(card);
    }
    return () => observer.disconnect();
  });

  // Focus card on focusEventId change — bring it into view WITHIN the rail's
  // own scroll container only. scrollIntoView would walk every scrollable
  // ancestor including the page, yanking the document out from under the
  // text the user just clicked (the anchor — and its margin-aligned card —
  // is already where they are looking).
  function nearestPanelScroller(el: HTMLElement): HTMLElement | null {
    return nearestScrollableAncestor(el);
  }

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
    if (!el) return;
    const scroller = nearestPanelScroller(el);
    // Only a scroller INSIDE the rail may move. In the anchored (sticky
    // margin) architecture the nearest scrollable ancestor is the page
    // scroller itself — scrolling it here yanks the document away from the
    // text the user just commented on (and can overshoot past both the
    // anchor and the card). Card visibility in anchored mode is already
    // guaranteed by the fitBottom pass, so skipping is safe.
    if (!scroller || !containerEl.contains(scroller)) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const fullyVisible = elRect.top >= scrollerRect.top && elRect.bottom <= scrollerRect.bottom;
    if (fullyVisible) return;
    const delta = elRect.top + elRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2);
    const reduceMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({
      top: scroller.scrollTop + delta,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  });

  // ---------------------------------------------------------------------------
  // Per-thread props derivation
  // ---------------------------------------------------------------------------

  function authorNameFor(t: Thread): string {
    // Prefer the real display name from the author's ParticipantJoined event
    // (presence only carries the kind label); falls back to presence, then id.
    return reviewStore.displayNameFor(t.rootEvent.meta.authorId);
  }

  function kindFor(t: Thread): 'comment' | 'suggestion' {
    return t.rootEvent.body.type === 'suggestion_created' ? 'suggestion' : 'comment';
  }

  /** The initiating author's participant kind — drives the per-user color
   *  (card border + avatar chip) via the `--peer-avatar-bg-*` tokens. */
  function authorKindFor(t: Thread): PeerKind {
    return reviewStore.participantKindFor(t.rootEvent.meta.authorId);
  }

  /** The author's personal identity color (attn-3gdd) — declared pick or
   *  deterministic hash, agents always violet. One color across the gutter
   *  chip, card accent, peer chip, and caret. */
  function authorColorFor(t: Thread): string {
    return reviewStore.colorFor(t.rootEvent.meta.authorId);
  }

  /** Avatar glyph for the collapsed-gutter chip: monogram for humans, the
   *  agent glyph for agents (peer-strip rule — agents never get a letter). */
  function avatarGlyphFor(t: Thread): string {
    if (authorKindFor(t) === 'agent') return AGENT_GLYPH;
    return monogramFor(authorNameFor(t));
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

  // ---------------------------------------------------------------------------
  // Chip expand/collapse (attn-d7y, reworked by attn-42y)
  // ---------------------------------------------------------------------------

  /**
   * Expand a resolved chip to its full read-only card. The store method
   * also expands the rail (clicking a chip in the collapsed gutter must
   * surface the card); the chip re-renders as a card and focus moves onto
   * it so Escape works immediately. Also focuses the anchor in the editor
   * like any card click.
   */
  async function expandResolved(t: Thread): Promise<void> {
    reviewStore.expandResolvedThread(t.id);
    activateThread(t);
    await tick();
    const card = containerEl?.querySelector<HTMLElement>(
      `[data-testid="review-margin-card"][data-thread-id="${CSS.escape(t.id)}"]`,
    );
    card?.focus({ preventScroll: true });
  }

  /**
   * Collapse the expanded resolved card back to its chip and return focus
   * to it. If the chip is no longer rendered (virtualized out, thread
   * gone), the focus move is a silent no-op.
   */
  async function collapseResolved(t: Thread): Promise<void> {
    reviewStore.collapseResolvedThread();
    await tick();
    const chip = containerEl?.querySelector<HTMLElement>(
      `[data-testid="review-margin-resolved-chip"][data-thread-id="${CSS.escape(t.id)}"]`,
    );
    chip?.focus({ preventScroll: true });
  }

  /**
   * Avatar chip click in the collapsed gutter: expand the rail and focus
   * the thread's card (cursor + scroll + pulse via focusEventId).
   */
  async function expandToThread(t: Thread): Promise<void> {
    reviewStore.openPanelForFocus(t.rootEvent.meta.eventId);
    activateThread(t);
    await tick();
    const card = containerEl?.querySelector<HTMLElement>(
      `[data-testid="review-margin-card"][data-thread-id="${CSS.escape(t.id)}"]`,
    );
    card?.focus({ preventScroll: true });
  }
</script>

<div
  bind:this={containerEl}
  class="review-margin"
  data-slot="review-margin"
  data-rail-mode={collapsed ? 'collapsed' : 'expanded'}
>
  {#if collapsed}
    <!-- Collapsed gutter (attn-42y): every thread shrinks to an icon chip
         at its anchor Y — the author's avatar for unresolved threads, a ✓
         for resolved ones. Clicking expands the rail onto that thread. -->
    {#each collapsedChipPlacements as p (p.id)}
      {@const t = threadById.get(p.id)}
      {#if t && !t.resolved}
        <button
          type="button"
          class="review-margin-avatar-chip"
          data-testid="review-margin-avatar-chip"
          data-thread-id={t.id}
          data-author-kind={authorKindFor(t)}
          style="top: {p.top}px; background-color: {authorColorFor(t)};"
          aria-label={`Unresolved ${kindFor(t)} by ${authorNameFor(t)} — open comments`}
          title={`${authorNameFor(t)} — ${kindFor(t)}`}
          onclick={() => { void expandToThread(t); }}
        >
          {avatarGlyphFor(t)}
        </button>
      {:else if t}
        <button
          type="button"
          class="review-margin-resolved-chip"
          data-testid="review-margin-resolved-chip"
          data-variant="icon"
          data-thread-id={t.id}
          style="top: {p.top}px; --chip-author-color: {authorColorFor(t)};"
          aria-label={`Resolved ${kindFor(t)} by ${authorNameFor(t)} — view details`}
          aria-expanded="false"
          onclick={() => { void expandResolved(t); }}
        >
          ✓
        </button>
      {/if}
    {/each}
  {:else}
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
              {readOnly}
              {reviewerAuthoring}
              thread={t}
              kind={kindFor(t)}
              cardState={stateFor(t)}
              active={focusEventId === t.rootEvent.meta.eventId}
              hovered={hoveredEventId === t.rootEvent.meta.eventId}
              offset={false}
              authorName={authorNameFor(t)}
              authorId={t.rootEvent.meta.authorId}
              authorKind={authorKindFor(t)}
              quotePreview={quotePreviewFor(t)}
              onActivate={() => activateThread(t)}
              onAccept={suggestionActionPort.accept ? () => acceptSuggestion(t) : undefined}
              onReject={suggestionActionPort.reject ? () => rejectSuggestion(t) : undefined}
              onResolve={() => { void resolveThread(t.id); }}
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

  {#if stacked}
    <!-- Stacked list (mobile bottom sheet): document-order cards in plain
         flow. Same card variants and handlers as the anchored branch — only
         the geometry differs. -->
    <ul class="review-margin-stack" data-testid="review-margin-stack">
      {#each stackedThreads as t (t.id)}
        <li class="review-margin-stack-item">
          {#if !t.resolved}
            <ReviewMarginCard
              {readOnly}
              {reviewerAuthoring}
              thread={t}
              kind={kindFor(t)}
              cardState={stateFor(t)}
              active={focusEventId === t.rootEvent.meta.eventId}
              hovered={hoveredEventId === t.rootEvent.meta.eventId}
              offset={false}
              authorName={authorNameFor(t)}
              authorId={t.rootEvent.meta.authorId}
              authorKind={authorKindFor(t)}
              quotePreview={quotePreviewFor(t)}
              onActivate={() => activateThread(t)}
              onAccept={suggestionActionPort.accept ? () => acceptSuggestion(t) : undefined}
              onReject={suggestionActionPort.reject ? () => rejectSuggestion(t) : undefined}
              onResolve={() => { void resolveThread(t.id); }}
              onReply={(body) => replyToThread(t, body)}
              pendingDismiss={locallyDismissed.has(t.id)}
            />
          {:else if t.id === expandedResolvedId}
            <ReviewMarginCard
              {readOnly}
              {reviewerAuthoring}
              thread={t}
              kind={kindFor(t)}
              cardState={stateFor(t)}
              active={focusEventId === t.rootEvent.meta.eventId}
              hovered={hoveredEventId === t.rootEvent.meta.eventId}
              offset={false}
              authorName={authorNameFor(t)}
              authorId={t.rootEvent.meta.authorId}
              authorKind={authorKindFor(t)}
              quotePreview={quotePreviewFor(t)}
              onActivate={() => { void collapseResolved(t); }}
            />
          {:else}
            <button
              type="button"
              class="review-margin-resolved-chip stacked"
              data-testid="review-margin-resolved-chip"
              data-variant="label"
              data-thread-id={t.id}
              style="border-color: {authorColorFor(t)};"
              aria-label={`Resolved ${kindFor(t)} by ${authorNameFor(t)} — view details`}
              aria-expanded="false"
              onclick={() => { void expandResolved(t); }}
            >
              <span
                class="rmrc-avatar"
                style="background-color: {authorColorFor(t)};"
                aria-hidden="true"
              >{avatarGlyphFor(t)}</span>
              ✓ {authorNameFor(t)} · resolved
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if showResolvedPill}
      <button
        type="button"
        class="review-margin-resolved-pill stacked"
        data-testid="review-margin-resolved-pill"
        onclick={() => { showAllResolved = true; }}
      >
        {resolvedThreads.length} resolved · show
      </button>
    {/if}
  {:else}
  <!-- SVG connector layer for offset cards (§1.3 step 3) -->
  {#if connectorLines.length > 0}
    <svg
      class="review-margin-connectors"
      data-testid="review-margin-connectors"
      aria-hidden="true"
      width="100%"
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

  <!-- Anchored cards + resolved chips at their resolved y — one unified
       collision pass, so the three branches share `visiblePlacements`. -->
  {#each visiblePlacements as p (p.id)}
    {@const t = threadById.get(p.id)}
    {#if t && !t.resolved}
      <div class="review-margin-slot" style="top: {p.top}px;">
        <ReviewMarginCard
          {readOnly}
          {reviewerAuthoring}
          thread={t}
          kind={kindFor(t)}
          cardState={stateFor(t)}
          active={focusEventId === t.rootEvent.meta.eventId}
          hovered={hoveredEventId === t.rootEvent.meta.eventId}
          offset={p.offset}
          authorName={authorNameFor(t)}
              authorId={t.rootEvent.meta.authorId}
          authorKind={authorKindFor(t)}
          quotePreview={quotePreviewFor(t)}
          onActivate={() => activateThread(t)}
          onAccept={suggestionActionPort.accept ? () => acceptSuggestion(t) : undefined}
          onReject={suggestionActionPort.reject ? () => rejectSuggestion(t) : undefined}
          onResolve={() => { void resolveThread(t.id); }}
          onReply={(body) => replyToThread(t, body)}
          pendingDismiss={locallyDismissed.has(t.id)}
        />
      </div>
    {:else if t && t.id === expandedResolvedId}
      <!-- Expanded resolved thread: full read-only card. No action row
           (attn-42y removed the Collapse button — the rail itself
           collapses now); clicking the card or pressing Escape shrinks
           it back to its chip. -->
      <div class="review-margin-slot" style="top: {p.top}px;">
        <ReviewMarginCard
          {readOnly}
          {reviewerAuthoring}
          thread={t}
          kind={kindFor(t)}
          cardState={stateFor(t)}
          active={focusEventId === t.rootEvent.meta.eventId}
          hovered={hoveredEventId === t.rootEvent.meta.eventId}
          offset={p.offset}
          authorName={authorNameFor(t)}
              authorId={t.rootEvent.meta.authorId}
          authorKind={authorKindFor(t)}
          quotePreview={quotePreviewFor(t)}
          onActivate={() => { void collapseResolved(t); }}
        />
      </div>
    {:else if t}
      <!-- Resolved chip in the expanded rail: labeled pill at its anchor,
           carrying the initiating author's presence color (border + mini
           avatar) like the cards do (attn-2aj). Click to expand into the
           read-only card. -->
      <button
        type="button"
        class="review-margin-resolved-chip"
        data-testid="review-margin-resolved-chip"
        data-variant="label"
        data-thread-id={t.id}
        style="top: {p.top}px; border-color: {authorColorFor(t)};"
        aria-label={`Resolved ${kindFor(t)} by ${authorNameFor(t)} — view details`}
        aria-expanded="false"
        onclick={() => { void expandResolved(t); }}
      >
        <span
          class="rmrc-avatar"
          style="background-color: {authorColorFor(t)};"
          aria-hidden="true"
        >{avatarGlyphFor(t)}</span>
        ✓ {authorNameFor(t)} · resolved
      </button>
    {/if}
  {/each}

  {#if showResolvedPill}
    <button
      type="button"
      class="review-margin-resolved-pill"
      data-testid="review-margin-resolved-pill"
      onclick={() => { showAllResolved = true; }}
    >
      {resolvedThreads.length} resolved · show
    </button>
  {/if}
  {/if}

  {#if threads.length === 0 && orphanThreads.length === 0 && reviewStore.currentRoomId === null}
    <!-- Google-Docs rule: inside a shared room an empty margin renders
         NOTHING — whitespace, not a dead panel with filler copy. The hint
         survives only for the local (roomless) review panel, where opening
         it is an explicit act that deserves an explanation. -->
    <p class="review-margin-empty" data-testid="review-margin-empty">
      {#if reviewerAuthoring}
        No comments yet. Select any text in the document to start a thread.
      {:else}
        No review threads on this file.
      {/if}
    </p>
  {/if}

  <!--
    Global select-mode overlay (attn-nnj.4.8). Appears whenever a stale
    card is awaiting a new anchor. The "Use this selection" button confirms
    the current PM selection; Cancel clears the in-flight state. The
    overlay is rendered at the bottom of the margin so it doesn't fight
    with sticky-top orphan-tray scroll behavior.
  -->
  {#if manualReanchorState && !readOnly}
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
  {/if}
</div>

<style>
  /* The overlay fills the (non-scrolling) right-rail aside; card tops are
     viewport-anchored and recomputed per document scroll (attn-23m). The
     aside supplies the width slot — 320px expanded, 48px collapsed gutter —
     so this container tracks it at 100% (a fixed 320px child inside the
     48px aside with overflow hidden would push the chips out of view). */
  .review-margin {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: auto;
    color: var(--foreground, inherit);
  }

  /* Orphan tray (§2), pinned at the rail top (below the rail header row,
     which is structural in App.svelte now). z-indexed above anchored
     cards, inset from the rail edges like the card slots. The rail
     doesn't scroll itself (the document's scroll drives card positions —
     attn-23m), so plain flow position keeps it visible permanently. */
  .review-margin-tray {
    position: relative;
    z-index: 2;
    /* A card, on whatever the rail is — not a patch of paper. */
    background: var(--review-card-surface, var(--background));
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px;
    margin: 8px 12px;
    max-height: 40vh;
    overflow: auto;
  }

  .rmt-header {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
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
    color: var(--accent-foreground, var(--muted-foreground));
    z-index: 0;
  }

  /* Each absolutely-positioned card slot. `top` is set inline per layout.
     Inset 12px from both rail edges (attn-42y: cards must not touch the
     window edge); the card inside is width:100% of this slot. The insets
     live HERE rather than as container padding because abs-positioned
     children resolve against the padding box, not inside it. */
  .review-margin-slot {
    position: absolute;
    right: 12px;
    left: 12px;
    z-index: 1;
  }

  /* Stacked list (mobile bottom sheet): plain flow, document order. */
  .review-margin-stack {
    list-style: none;
    margin: 0;
    padding: 4px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .review-margin-resolved-chip.stacked {
    position: static;
    max-width: 100%;
    align-self: flex-start;
  }

  .review-margin-resolved-pill.stacked {
    position: static;
    display: block;
    width: 100%;
    margin: 2px 0 8px;
  }

  /* Resolved chip (attn-d7y). Labeled pill at its anchor in the expanded
     rail; icon-only square centered in the collapsed gutter. */
  .review-margin-resolved-chip {
    position: absolute;
    left: 12px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    height: 28px;
    max-width: calc(100% - 24px);
    padding: 0 10px;
    /* Backdrop-aware, not `--muted`: the docked rail paints `--panel-surface`,
       which in ink sits 0.003 off `--muted` and erased this chip's fill. */
    background: var(--rail-chip-surface, var(--muted));
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--muted-foreground);
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .review-margin-resolved-chip:hover {
    background: var(--accent);
    color: var(--foreground, inherit);
  }

  /* Mini author avatar inside the labeled resolved chip (attn-2aj) —
     same monogram-on-presence-color treatment as the card header. */
  .rmrc-avatar {
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

  /* Icon variant takes the author's presence color via a custom property
     (set inline) rather than inline color/border-color directly, so the
     :hover foreground flip below can still win (attn-2aj). */
  .review-margin-resolved-chip[data-variant='icon'] {
    left: 50%;
    transform: translateX(-50%);
    width: 28px;
    max-width: none;
    padding: 0;
    justify-content: center;
    border-color: var(--chip-author-color, var(--border));
    color: var(--chip-author-color, var(--muted-foreground));
  }

  .review-margin-resolved-chip[data-variant='icon']:hover {
    color: var(--foreground, inherit);
  }

  /* Collapsed-gutter avatar chip (attn-42y): the initiating author's
     monogram on their presence color, marking an UNRESOLVED thread.
     Background color is set inline from --peer-avatar-bg-{kind} so it
     matches the caret labels and peer chips. */
  .review-margin-avatar-chip {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 28px;
    height: 28px;
    /* Ringed against the surface it actually sits on: the docked panel in the
       native rail, the paper in the hosted floating margin. */
    border: 2px solid var(--rail-backdrop, var(--background));
    border-radius: 9999px;
    color: var(--monogram);
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  }

  .review-margin-avatar-chip:hover {
    filter: brightness(1.06);
  }

  /* Bottom pill — shown when collapsed-resolved count exceeds threshold.
     Absolute (not sticky): the rail doesn't scroll, so sticky would
     render at the static position near the rail top (attn-23m). */
  .review-margin-resolved-pill {
    position: absolute;
    bottom: 8px;
    left: 12px;
    right: 12px;
    width: auto;
    box-sizing: border-box;
    padding: 6px 12px;
    /* Same backdrop-aware fill as the resolved chips it summarizes. */
    background: var(--rail-chip-surface, var(--muted));
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 0.7rem;
    color: var(--muted-foreground);
    cursor: pointer;
    text-align: center;
    z-index: 2;
  }

  .review-margin-resolved-pill:hover {
    background: var(--accent);
    color: var(--foreground, inherit);
  }

  /* Empty state — no threads, no orphan rows. */
  .review-margin-empty {
    padding: 14px 12px;
    color: var(--muted-foreground);
    font-size: 0.85rem;
    text-align: center;
  }

  /* Floating overlay shown while a stale card waits for a new anchor. */
  /* Absolute for the same non-scrolling-rail reason as the pill. */
  .review-margin-reanchor-overlay {
    position: absolute;
    bottom: 8px;
    left: 12px;
    right: 12px;
    padding: 10px 12px;
    background: var(--review-card-surface, var(--popover, var(--background)));
    border: 1px solid var(--destructive);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.15);
    font-size: 0.85rem;
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
    border: 1px solid var(--border);
    color: inherit;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.7rem;
    cursor: pointer;
  }

  .rmro-btn:hover {
    background: var(--muted);
  }

  .rmro-btn-primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: var(--primary);
  }

  .rmro-btn-primary:hover {
    filter: brightness(0.96);
    background: var(--primary);
  }
</style>
