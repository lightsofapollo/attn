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

/** Minimum chip top inside the collapsed gutter. The rail now starts
 *  below the app header and owns a toggle row (App.svelte), so this is
 *  just breathing room — and the pin position for threads with no
 *  resolvable anchor. */
export const COLLAPSED_RAIL_TOP_CLEARANCE = 8;

export function computeRailMode(input: {
  /** True when a review room is active (`currentRoomId !== null`). */
  inReviewRoom: boolean;
  /** User-controlled open/collapsed state (ReviewBar toggle / Cmd+J). */
  panelOpen: boolean;
}): RailMode {
  if (input.panelOpen) return 'expanded';
  return input.inReviewRoom ? 'collapsed' : 'hidden';
}
