// Rail-mode derivation for the review right rail (attn-d7y).
//
// The rail no longer reserves its full 320px whenever the panel is open:
// when the margin holds ONLY resolved threads the aside shrinks to a slim
// gutter of icon chips and the document reclaims the width. Expanding a
// resolved chip (or any active/orphan thread existing) forces full width.
//
// Kept pure so both `App.svelte` (width) and `ReviewMargin.svelte` (chip
// variant) derive from one decision, and so the rule is testable without
// the DOM (same pattern as `margin-layout.ts`).

export type RailMode = 'closed' | 'slim' | 'full';

export const RAIL_WIDTH_PX: Record<RailMode, number> = {
  closed: 0,
  slim: 48,
  full: 320,
};

/** Collapsed resolved-thread chip height — used by the unified collision
 *  layout pass in `ReviewMargin.svelte` and by its tests. */
export const RESOLVED_CHIP_HEIGHT = 28;

export function computeRailMode(input: {
  panelOpen: boolean;
  activeThreadCount: number;
  resolvedThreadCount: number;
  hasExpandedResolved: boolean;
}): RailMode {
  if (!input.panelOpen) return 'closed';
  // Slim only when resolved chips are the sole content. Zero threads stays
  // full: the "No review threads on this file." empty state needs the width,
  // and orphan-tray threads are a subset of active so they're covered too.
  if (
    input.activeThreadCount === 0
    && input.resolvedThreadCount > 0
    && !input.hasExpandedResolved
  ) {
    return 'slim';
  }
  return 'full';
}
