// ProseMirror plugin that renders review-anchor decorations on top of the
// editor view (planning issue attn-nnj.4.6).
//
// Source of truth: `reviewStore.anchorResolutions` (a map keyed by eventId)
// plus `reviewStore.events` (to look up comment vs suggestion + body kind).
// The plugin itself stays pure — it never subscribes to runes inside `apply`.
// Instead, the host component (`App.svelte` via `Editor.svelte`'s `plugins`
// prop) runs an `$effect` on the store and dispatches an empty transaction
// with `meta(reviewDecorationsKey) = { rebuild: true }` whenever the
// resolution map, the event log, or the focus/hover targets change. The
// `apply` handler observes that meta flag and rebuilds the DecorationSet.
//
// Visual treatment (planning/collab/ui/inline-decorations.md §6 — split):
//   * exact / remapped ≥ 0.90 → background fill (`attn-review-comment` or
//     `attn-review-suggestion[--deletion]`)
//   * remapped 0.70 – 0.89    → wavy/double underline shape
//     (`attn-review-confidence--med` + a per-kind modifier rendered via
//      inline style so we don't need extra CSS to ship the shape)
//   * ambiguous / stale / < 0.70 → NO inline mark (panel-only)
//
// Overlap cap: at most 3 inline marks per identical range; a 4th and beyond
// collapses into a single `+N more` widget decoration anchored at the end
// of the range. Hidden marks remain fully visible in the panel.
//
// Click + hover on a mark sets `reviewStore.focusEventId` / `hoveredEventId`
// so the review panel (4.3) and the editor stay in sync. The handlers run
// on the plugin DOM via `props.handleDOMEvents` so they survive editor
// remounts and live alongside the existing editor handlers.

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

import { reviewStore } from '../review/store.svelte';
import { recordReviewSelectionDebug } from '../review/selection-debug';
import type {
  EventId,
  ReviewAnchorResolutionUpdate,
  ReviewEvent,
  ResolvedAnchor,
} from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const reviewDecorationsKey = new PluginKey<DecorationSet>('review-decorations');

/**
 * Build the review-decorations plugin. The decoration set is recomputed in
 * full whenever the host signals a rebuild via `setMeta(reviewDecorationsKey,
 * { rebuild: true })`. Between rebuilds, doc-changing transactions map the
 * existing set through `tr.mapping` so cursor moves and text edits don't
 * desync the marks from the underlying text.
 */
export function reviewDecorationsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: reviewDecorationsKey,
    state: {
      init: (_config, state) => buildDecorations(state),
      apply: (tr, oldSet, _oldState, newState) => {
        const meta = tr.getMeta(reviewDecorationsKey) as
          | { rebuild?: boolean }
          | undefined;
        if (meta?.rebuild) {
          return buildDecorations(newState);
        }
        if (tr.docChanged) {
          return oldSet.map(tr.mapping, tr.doc);
        }
        return oldSet;
      },
    },
    props: {
      decorations: (state) => reviewDecorationsKey.getState(state),
      handleDOMEvents: {
        click: (view, event) => handleClick(view, event),
        mouseover: (view, event) => handleMouseOver(view, event),
        mouseout: (view, event) => handleMouseOut(view, event),
      },
    },
  });
}

/**
 * Dispatch a rebuild signal to the plugin. Callers (App.svelte / Editor host)
 * invoke this from an `$effect` watching `reviewStore.anchorResolutions`,
 * `events`, and `focusEventId` / `hoveredEventId`.
 */
export function requestReviewDecorationsRebuild(view: EditorView): void {
  view.dispatch(
    view.state.tr.setMeta(reviewDecorationsKey, { rebuild: true }),
  );
}

// ---------------------------------------------------------------------------
// Pending-anchor highlight — the range a composer is being written against.
//
// The browser only paints text selection in the focused element, so the
// moment the comment/suggestion composer's textarea takes focus the editor's
// native selection vanishes — the text being commented on visually
// de-highlights until submit re-decorates it, which reads as a jarring blink.
// Google Docs keeps the target range tinted for the whole compose. This
// plugin paints the pending range with the selection color while a composer
// is open; positions map through doc changes (live collab keeps flowing).
// ---------------------------------------------------------------------------

interface PendingAnchorRange {
  from: number;
  to: number;
}

export const pendingAnchorKey = new PluginKey<PendingAnchorRange | null>('pending-anchor-highlight');

export function pendingAnchorHighlightPlugin(): Plugin<PendingAnchorRange | null> {
  return new Plugin<PendingAnchorRange | null>({
    key: pendingAnchorKey,
    state: {
      init: () => null,
      apply: (tr, current) => {
        const meta = tr.getMeta(pendingAnchorKey) as
          | { range: PendingAnchorRange | null }
          | undefined;
        if (meta !== undefined) return meta.range;
        if (current && tr.docChanged) {
          const from = tr.mapping.map(current.from, 1);
          const to = tr.mapping.map(current.to, -1);
          return from < to ? { from, to } : null;
        }
        return current;
      },
    },
    props: {
      decorations: (state) => {
        const range = pendingAnchorKey.getState(state);
        if (!range) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.inline(range.from, range.to, { class: 'pending-anchor-highlight' }),
        ]);
      },
    },
  });
}

/** Keep the compose target visibly selected while the composer owns focus. */
export function setPendingAnchorRange(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(pendingAnchorKey, { range: { from, to } }));
}

export function clearPendingAnchorRange(view: EditorView): void {
  if (pendingAnchorKey.getState(view.state) === null) return;
  view.dispatch(view.state.tr.setMeta(pendingAnchorKey, { range: null }));
}

// Inputs to `buildDecorationsFromStore` so the function stays pure and
// directly testable without spinning up the reviewStore singleton.
export interface ReviewDecorationInputs {
  resolutions: Record<string, ReviewAnchorResolutionUpdate>;
  events: ReviewEvent[];
  docSize: number;
  focusEventId: EventId | null;
}

/**
 * Pure builder used by `buildDecorations` and by the test harness. Given the
 * resolved-anchor map + event log + the current PM doc bounds, returns the
 * list of `Decoration` objects to install on the view.
 *
 * Exported for tests; production callers should use the plugin itself.
 */
export function buildReviewDecorations(
  inputs: ReviewDecorationInputs,
): Decoration[] {
  const eventIndex = indexEventsById(inputs.events);
  const perRange = new Map<string, RangeEntry>();

  // Suggestions that have been accepted or rejected are no longer pending —
  // their proposed change is either applied (and now part of the doc) or
  // discarded, so they must NOT keep rendering inline ghost text. Collect
  // their suggestion_ids from SuggestionAccepted/Rejected events.
  const resolvedSuggestionIds = new Set<string>();
  for (const event of inputs.events) {
    const body = event.body;
    if (body.type === 'suggestion_accepted' || body.type === 'suggestion_rejected') {
      resolvedSuggestionIds.add(body.suggestionId);
    }
  }

  for (const [eventId, update] of Object.entries(inputs.resolutions)) {
    const kind = lookupEventKind(eventIndex, eventId);
    if (!kind) continue;
    // Skip suggestions whose proposal has already been accepted/rejected.
    const ev = eventIndex.get(eventId);
    if (
      ev?.body.type === 'suggestion_created' &&
      resolvedSuggestionIds.has(ev.body.suggestionId)
    ) {
      continue;
    }
    const range = resolutionRange(update.resolved);
    if (!range) continue;
    const [pmFrom, pmTo] = clampRange(range, inputs.docSize);
    if (pmFrom === pmTo) continue;
    const treatment = decorationTreatment(update.resolved, kind);
    if (!treatment) continue;

    const key = `${pmFrom}:${pmTo}`;
    let entry = perRange.get(key);
    if (!entry) {
      entry = { from: pmFrom, to: pmTo, items: [] };
      perRange.set(key, entry);
    }
    entry.items.push({
      eventId,
      kind,
      className: treatment.className,
      ariaLabel: ariaLabelFor(kind, update.resolved),
      isFocused: eventId === inputs.focusEventId,
    });
  }

  const out: Decoration[] = [];
  // Number the anchored ranges in document order so the mobile reader can show
  // a stable tappable superscript marker per anchor (1, 2, 3…). Desktop hides
  // the markers via CSS and relies on the margin cards instead.
  const orderedEntries = [...perRange.values()].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
  let anchorOrdinal = 0;
  for (const entry of orderedEntries) {
    anchorOrdinal += 1;
    // Determinism: sort by eventId so multiple stacked marks on the same
    // range always render in the same order across rebuilds (no z-flicker).
    entry.items.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    const cap = OVERLAP_CAP;
    const visible = entry.items.slice(0, cap);
    const hiddenCount = entry.items.length - visible.length;
    for (const item of visible) {
      out.push(
        Decoration.inline(
          entry.from,
          entry.to,
          {
            class: item.className + (item.isFocused ? ' is-focused' : ''),
            'data-event-id': item.eventId,
            'data-review-kind': item.kind,
            'aria-label': item.ariaLabel,
            role: 'mark',
          },
          { eventId: item.eventId },
        ),
      );
    }
    // Numbered marker at the end of the range (mobile-only via CSS). Carries
    // data-event-id so the existing click handler focuses the thread; the host
    // opens the mobile review sheet when the focus target changes.
    const primary = visible[0];
    if (primary) {
      const ordinal = anchorOrdinal;
      out.push(
        // ProseMirror treats same-key widgets as interchangeable and reuses
        // their DOM, so every rendered value belongs in the key: a range-only
        // key would keep the OLD primary's data-event-id/label alive after
        // the primary event at this range is resolved or replaced.
        Decoration.widget(entry.to, () => anchorMarkerWidget(ordinal, primary.eventId, primary.kind), {
          side: 1,
          key: `${entry.from}:${entry.to}:marker:${ordinal}:${primary.eventId}:${primary.kind}`,
        }),
      );
    }

    if (hiddenCount > 0) {
      out.push(
        Decoration.widget(entry.to, () => moreWidget(hiddenCount), {
          side: 1,
          key: `${entry.from}:${entry.to}:more:${hiddenCount}`,
        }),
      );
    }

    // Suggestion ghost text: render the PROPOSED replacement/insertion
    // inline (green) right after the anchored range so the author sees
    // exactly what the reviewer is proposing — the editorial "suggesting
    // mode" surface. Deletions are already conveyed by the red
    // `suggestion-deletion` strikethrough on the range itself.
    for (const item of visible) {
      if (item.kind !== 'suggestion' && item.kind !== 'suggestion-deletion') {
        continue;
      }
      const ghost = ghostInsertionText(eventIndex, item.eventId);
      if (ghost === null) continue;
      out.push(
        Decoration.widget(entry.to, () => suggestionGhostWidget(ghost, item.eventId), {
          side: 1,
          key: `${entry.from}:${entry.to}:${item.eventId}:ghost`,
        }),
      );
    }
  }

  return out;
}

/**
 * The text a suggestion proposes to insert, for inline ghost rendering.
 * `Replace` → replacement; `InsertBefore`/`InsertAfter` → inserted text;
 * `Delete` → `null` (the strikethrough already conveys it).
 */
function ghostInsertionText(
  index: Map<EventId, ReviewEvent>,
  eventId: EventId,
): string | null {
  const event = index.get(eventId);
  if (!event || event.body.type !== 'suggestion_created') return null;
  const op = event.body.operation;
  switch (op.kind) {
    case 'replace':
      return op.replacement;
    case 'insert_before':
    case 'insert_after':
      return op.text;
    case 'delete':
      return null;
  }
}

/** Build the green ghost-text widget DOM node for a proposed insertion. */
function suggestionGhostWidget(text: string, eventId: EventId): HTMLElement {
  const span = document.createElement('span');
  span.className = 'attn-suggestion-ghost';
  span.setAttribute('data-event-id', eventId);
  span.setAttribute('data-review-kind', 'suggestion-insertion');
  span.setAttribute('aria-label', `Suggested insertion: ${text}`);
  span.setAttribute('role', 'mark');
  // Truncate very long proposals in the inline view; the full text lives
  // in the margin card.
  span.textContent = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  return span;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Cap on stacked inline marks per range. Per
 * `planning/collab/ui/inline-decorations.md` §5: "render only the 3 most
 * recent inline + emit a single widget decoration `+N more` chip at the
 * range end". Tracked as open question 4 in the design.
 */
const OVERLAP_CAP = 3;

/** Confidence cutoff between background-fill and underline treatments. */
const HIGH_CONFIDENCE = 0.9;
/** Confidence cutoff below which no inline mark is drawn. */
const INLINE_CUTOFF = 0.7;

interface RangeEntry {
  from: number;
  to: number;
  items: RangeItem[];
}

interface RangeItem {
  eventId: EventId;
  kind: ReviewMarkKind;
  className: string;
  ariaLabel: string;
  isFocused: boolean;
}

type ReviewMarkKind = 'comment' | 'suggestion' | 'suggestion-deletion';

interface Treatment {
  className: string;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decos = buildReviewDecorations({
    resolutions: reviewStore.anchorResolutions,
    events: reviewStore.events,
    docSize: state.doc.content.size,
    focusEventId: reviewStore.focusEventId,
  });
  return DecorationSet.create(state.doc, decos);
}

/**
 * Map a `ResolvedAnchor` to a PM range. Returns `null` when no usable inline
 * position is available (ambiguous, stale, or remapped without a pmRange).
 * Production callers also receive a `pmRange` from the daemon side; the
 * fallback for now is to drop the decoration silently (per spec §5.3).
 */
function resolutionRange(resolved: ResolvedAnchor): [number, number] | null {
  if (resolved.status !== 'exact' && resolved.status !== 'remapped') {
    return null;
  }
  const pm = resolved.currentRange.pmRange;
  if (!pm) return null;
  if (pm[0] < 0 || pm[1] < pm[0]) return null;
  return [pm[0], pm[1]];
}

function clampRange(range: [number, number], docSize: number): [number, number] {
  const from = Math.max(0, Math.min(range[0], docSize));
  const to = Math.max(from, Math.min(range[1], docSize));
  return [from, to];
}

/**
 * Pick the (background-fill) or (underline) treatment for `resolved`. Returns
 * `null` when the resolution should not produce an inline mark (ambiguous,
 * stale, or remapped below 0.70 — panel-only per design §3).
 */
function decorationTreatment(
  resolved: ResolvedAnchor,
  kind: ReviewMarkKind,
): Treatment | null {
  if (resolved.status === 'ambiguous' || resolved.status === 'stale') {
    return null;
  }
  const confidence = resolved.confidence;
  if (confidence < INLINE_CUTOFF) {
    return null;
  }
  if (confidence >= HIGH_CONFIDENCE) {
    return { className: highConfidenceClass(kind) };
  }
  return { className: mediumConfidenceClass(kind) };
}

function highConfidenceClass(kind: ReviewMarkKind): string {
  if (kind === 'comment') return 'attn-review-comment';
  if (kind === 'suggestion-deletion') {
    return 'attn-review-suggestion attn-review-suggestion--deletion';
  }
  return 'attn-review-suggestion';
}

function mediumConfidenceClass(kind: ReviewMarkKind): string {
  // The shape (wavy for comment, double for suggestion) is conveyed via the
  // moved-modifier class plus the shared `--med` background. Per spec §3,
  // moved-modifier classes drop the background fill in favour of the
  // underline shape; the actual shape is encoded in CSS once added (see
  // `app.css`). For now we still emit the kind class so consumers can style
  // the underline distinctively.
  if (kind === 'comment') {
    return 'attn-review-comment attn-review-comment--moved attn-review-confidence--med';
  }
  if (kind === 'suggestion-deletion') {
    return [
      'attn-review-suggestion',
      'attn-review-suggestion--deletion',
      'attn-review-suggestion--moved',
      'attn-review-confidence--med',
    ].join(' ');
  }
  return 'attn-review-suggestion attn-review-suggestion--moved attn-review-confidence--med';
}

function indexEventsById(events: ReviewEvent[]): Map<EventId, ReviewEvent> {
  const map = new Map<EventId, ReviewEvent>();
  for (const event of events) {
    map.set(event.meta.eventId, event);
  }
  return map;
}

function lookupEventKind(
  index: Map<EventId, ReviewEvent>,
  eventId: EventId,
): ReviewMarkKind | null {
  const event = index.get(eventId);
  if (!event) return null;
  const body = event.body;
  if (body.type === 'comment_created') return 'comment';
  if (body.type === 'suggestion_created') {
    if (body.operation.kind === 'delete') return 'suggestion-deletion';
    return 'suggestion';
  }
  return null;
}

function ariaLabelFor(kind: ReviewMarkKind, resolved: ResolvedAnchor): string {
  const base = kind === 'comment' ? 'Review comment' : 'Review suggestion';
  if (resolved.status === 'remapped') {
    return `${base} (moved, confidence ${resolved.confidence.toFixed(2)})`;
  }
  return base;
}

function moreWidget(hidden: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'attn-moved-badge attn-review-overflow-badge';
  span.textContent = `+${hidden} more`;
  span.setAttribute('aria-label', `${hidden} more review marks at this range`);
  return span;
}

/**
 * Numbered anchor marker for the mobile reader. Hidden on desktop via CSS (the
 * margin cards serve there). It reuses the plugin's `[data-event-id]` click
 * handler, so tapping it focuses the thread; the host component opens the
 * mobile review sheet in response to the focus change.
 */
function anchorMarkerWidget(
  ordinal: number,
  eventId: EventId,
  kind: ReviewMarkKind,
): HTMLElement {
  const sup = document.createElement('sup');
  sup.className = 'attn-review-anchor-marker';
  sup.textContent = String(ordinal);
  sup.setAttribute('data-event-id', eventId);
  sup.setAttribute('data-review-kind', kind);
  sup.setAttribute('role', 'button');
  sup.setAttribute(
    'aria-label',
    `Review ${kind === 'comment' ? 'comment' : 'suggestion'} ${ordinal}`,
  );
  return sup;
}

// ---------------------------------------------------------------------------
// DOM event handlers — sync focus + hover into the review store
// ---------------------------------------------------------------------------

function handleClick(view: EditorView, event: Event): boolean {
  const mouse = event as MouseEvent;
  const target = (mouse.target as HTMLElement | null)?.closest<HTMLElement>(
    '[data-event-id]',
  );
  if (!target) return false;
  const eventId = target.getAttribute('data-event-id');
  if (!eventId) return false;
  const domSelection = typeof window === 'undefined' ? null : window.getSelection();
  if (!shouldActivateReviewMarkClick(view.state.selection.empty, domSelection?.isCollapsed ?? true)) {
    // Browsers may dispatch click after mouseup even when the gesture was a
    // text-selection drag. Rebuilding the decoration beneath that live range
    // can detach its DOM endpoints and collapse part (or all) of the selection.
    recordReviewSelectionDebug('mark-click-ignored-selection', {
      eventId: eventId.slice(0, 8),
      pmFrom: view.state.selection.from,
      pmTo: view.state.selection.to,
      domCollapsed: domSelection?.isCollapsed ?? null,
    });
    return false;
  }
  // Clicking a mark is explicit intent to view its thread — reveal the
  // cards if hidden (tracked so Escape / click-away can hide them again),
  // mirroring the chip-side expandToThread. ReviewMargin's focus effect
  // then finds the freshly rendered card and scrolls/pulses it.
  reviewStore.openPanelForFocus(eventId);
  recordReviewSelectionDebug('mark-click-activated', {
    eventId: eventId.slice(0, 8),
    pmFrom: view.state.selection.from,
    pmTo: view.state.selection.to,
  });
  // The host effect watching focusEventId owns the rebuild. Dispatching here
  // as well rebuilt the same DecorationSet twice for one click.
  return false;
}

/** A click activates a thread only when it is not the tail of a selection drag. */
export function shouldActivateReviewMarkClick(
  prosemirrorSelectionEmpty: boolean,
  domSelectionCollapsed: boolean,
): boolean {
  return prosemirrorSelectionEmpty && domSelectionCollapsed;
}

function handleMouseOver(view: EditorView, event: Event): boolean {
  void view;
  const mouse = event as MouseEvent;
  const target = (mouse.target as HTMLElement | null)?.closest<HTMLElement>(
    '[data-event-id]',
  );
  if (!target) return false;
  const eventId = target.getAttribute('data-event-id');
  if (!eventId) return false;
  if (reviewStore.hoveredEventId !== eventId) {
    reviewStore.setHoveredEventId(eventId);
  }
  return false;
}

function handleMouseOut(view: EditorView, event: Event): boolean {
  void view;
  const mouse = event as MouseEvent;
  const related = mouse.relatedTarget as HTMLElement | null;
  // If we're still inside a decoration, keep the hover. Only clear when we
  // leave the inline mark entirely.
  if (related && related.closest('[data-event-id]')) return false;
  if (reviewStore.hoveredEventId !== null) {
    reviewStore.setHoveredEventId(null);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export const __testing__ = {
  decorationTreatment,
  resolutionRange,
  lookupEventKind,
  highConfidenceClass,
  mediumConfidenceClass,
  OVERLAP_CAP,
  HIGH_CONFIDENCE,
  INLINE_CUTOFF,
};
