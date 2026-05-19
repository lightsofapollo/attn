// Pure collision-detection / stacking logic for the Google-Docs-style review
// margin (attn-nnj.4.3). Split out of `ReviewMargin.svelte` so the math can
// be exercised by `tsx` without a Svelte runtime or a DOM.
//
// Spec ref: planning/collab/ui/review-panel-design.md §1.3 "Stack / collision
// rules". Cards walk in document order (smallest `anchorY` first), each
// pushed down if it would overlap the previous card's bottom edge:
//
//   top = max(anchorY, previousBottom + gutter)
//
// A card never sits *above* its anchor — only below. The function is pure;
// no DOM access, no globals.

export interface MarginCardInput {
  /** Stable identity of the card (thread id or anchor entry key). */
  id: string;
  /** Ideal y position (the anchor's top in the editor scroll space). */
  anchorY: number;
  /** Rendered height of the card in px. */
  height: number;
}

export interface MarginCardPlacement {
  id: string;
  anchorY: number;
  /** Final y position after collision push-down. */
  top: number;
  /** Whether the card was displaced from its `anchorY`. */
  offset: boolean;
}

export interface LayoutOptions {
  /** Vertical gap between stacked cards in px. Default 8. */
  gutter?: number;
}

/**
 * Lay out cards top-to-bottom honoring the collision rules in §1.3 of
 * `planning/collab/ui/review-panel-design.md`. Returns a placement record
 * per input card in input order.
 *
 * Pure: stable output for the same input. Tests in
 * `margin-layout.test.ts`.
 */
export function layoutCards(
  cards: MarginCardInput[],
  options?: LayoutOptions,
): MarginCardPlacement[] {
  const gutter = options?.gutter ?? 8;
  // Sort by anchorY (document order) without mutating the caller's array.
  // Tie-break on id so equal y-values stay deterministic between calls.
  const sorted = [...cards].sort((a, b) => {
    if (a.anchorY !== b.anchorY) return a.anchorY - b.anchorY;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const placed = new Map<string, MarginCardPlacement>();
  let previousBottom = -Infinity;
  for (const card of sorted) {
    const minTop = previousBottom + gutter;
    const top = Math.max(card.anchorY, minTop);
    const placement: MarginCardPlacement = {
      id: card.id,
      anchorY: card.anchorY,
      top,
      offset: top !== card.anchorY,
    };
    placed.set(card.id, placement);
    previousBottom = top + card.height;
  }

  // Return in original caller order so consumers don't have to re-sort.
  return cards.map((card) => {
    const p = placed.get(card.id);
    // `placed.get` is guaranteed to hit because every input was processed.
    if (p === undefined) {
      throw new Error(`layoutCards: missing placement for id=${card.id}`);
    }
    return p;
  });
}

export interface VisibleBandOptions {
  /** Viewport top (scroll position) in px. */
  viewportTop: number;
  /** Viewport height in px. */
  viewportHeight: number;
  /** Pre-/post-viewport band (each side) considered "visible" for render. */
  bandPx?: number;
}

/**
 * Decide which already-placed cards should render to the DOM. Cards outside
 * the viewport ± `bandPx` are dropped. Implements the §6 "Performance"
 * requirement: off-band cards still participate in layout but skip DOM.
 *
 * Pure helper — no DOM access. Tests in `margin-layout.test.ts`.
 */
export function visibleCards(
  placed: MarginCardPlacement[],
  cardHeights: Map<string, number>,
  opts: VisibleBandOptions,
): MarginCardPlacement[] {
  const band = opts.bandPx ?? 800;
  const top = opts.viewportTop - band;
  const bottom = opts.viewportTop + opts.viewportHeight + band;
  return placed.filter((p) => {
    const h = cardHeights.get(p.id) ?? 0;
    return p.top + h >= top && p.top <= bottom;
  });
}
