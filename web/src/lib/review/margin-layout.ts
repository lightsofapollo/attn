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

export interface FitBottomOptions {
  /** Height of the (non-scrolling) margin container in px. */
  containerHeight: number;
  /** Vertical gap kept between cascaded cards. Default 8. */
  gutter?: number;
  /** Gap kept between the lowest fitted card and the container bottom.
   *  Default 0 — the rail's clip wrapper already supplies the visual gap. */
  bottomClearance?: number;
}

/**
 * Bottom-fit pass (attn user feedback: "comments are sometimes cut off at
 * the bottom of the rail — they should always be completely visible").
 *
 * The down-pass (`layoutCards`) never places a card above its anchor, so a
 * card whose anchored text sits near the viewport bottom extends past the
 * rail and clips. This second pass walks placements bottom-up and shifts a
 * card UP — above its anchor if necessary, Google-Docs style — so that any
 * card whose ANCHOR is within the container stays fully visible, cascading
 * the shift to the cards above so nothing overlaps. Cards whose anchors are
 * below the fold are left alone: they belong off-screen with their text
 * (attn-23m scroll tracking). Shifted cards are flagged `offset` so the
 * connector layer draws their displacement line.
 *
 * Pure helper — no DOM access. Tests in `margin-layout.test.ts`.
 */
export function fitBottom(
  placed: MarginCardPlacement[],
  cardHeights: Map<string, number>,
  opts: FitBottomOptions,
): MarginCardPlacement[] {
  if (placed.length === 0 || opts.containerHeight <= 0) return placed;
  const gutter = opts.gutter ?? 8;
  const limit = opts.containerHeight - (opts.bottomClearance ?? 0);

  const sorted = [...placed].sort((a, b) => a.top - b.top);
  const adjusted = new Map<string, MarginCardPlacement>();
  // The top edge the card below this one ended up at (∞ for the last card).
  let belowTop = Infinity;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    const h = cardHeights.get(p.id) ?? 0;
    let top = p.top;
    if (p.anchorY < opts.containerHeight) {
      // Anchor on screen → the whole card must be too.
      top = Math.min(top, limit - h);
    }
    // Never overlap the (possibly shifted) card below. For unshifted
    // neighbours this is a no-op: the down-pass already guaranteed the gap.
    top = Math.min(top, belowTop - gutter - h);
    belowTop = top;
    adjusted.set(p.id, {
      ...p,
      top,
      offset: p.offset || top !== p.top,
    });
  }

  // Preserve caller order.
  return placed.map((p) => adjusted.get(p.id) ?? p);
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
