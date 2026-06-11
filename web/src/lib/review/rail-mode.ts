// Rail-mode derivation for the review right rail (attn-d7y, reworked by
// attn-42y).
//
// In a review room the rail is ALWAYS present and user-collapsible: it is
// either `expanded` (320px — cards + labeled resolved chips) or `collapsed`
// (48px gutter — author-avatar chips for unresolved threads, ✓ chips for
// resolved ones). The toggle (ReviewBar button / Cmd+J) flips `panelOpen`;
// the default is expanded only while unresolved comments exist (App.svelte
// auto-open effect). Outside a review room the rail keeps its historical
// behavior: hidden unless the user opens it explicitly.
//
// Kept pure so both `App.svelte` (width) and `ReviewMargin.svelte` (chip
// variant) derive from one decision, and so the rule is testable without
// the DOM (same pattern as `margin-layout.ts`).

export type RailMode = 'hidden' | 'collapsed' | 'expanded';

export const RAIL_WIDTH_PX: Record<RailMode, number> = {
  hidden: 0,
  collapsed: 48,
  expanded: 320,
};

/** Collapsed-mode chip height (avatar and ✓ chips) — used by the unified
 *  collision layout pass in `ReviewMargin.svelte` and by its tests. */
export const RESOLVED_CHIP_HEIGHT = 28;

/** In collapsed mode, chips are pushed below the floating ReviewBar dock
 *  (absolute top-1.5, ~40px tall) so the gutter's top stays clear. */
export const COLLAPSED_RAIL_TOP_CLEARANCE = 56;

export function computeRailMode(input: {
  /** True when a review room is active (`currentRoomId !== null`). */
  inReviewRoom: boolean;
  /** User-controlled open/collapsed state (ReviewBar toggle / Cmd+J). */
  panelOpen: boolean;
}): RailMode {
  if (input.panelOpen) return 'expanded';
  return input.inReviewRoom ? 'collapsed' : 'hidden';
}
