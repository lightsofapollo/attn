// Rail-mode derivation for the review right rail (attn-d7y, reworked by
// attn-42y).
//
// In a review room the rail is a binary user-controlled surface: `expanded`
// (cards) or `hidden` (no gutter, border, or reserved width). The toggle
// (ReviewBar button / Cmd+J) flips `panelOpen`. A legacy `collapsed` width is
// retained for the resolved-chip redesign, but the shared toggle no longer
// derives it: its avatar/marker gutter must not consume document width while
// the rail is closed.
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

// --- Resize bounds for the expanded rail (attn-11g4.2) -----------------------
//
// Only `expanded` is resizable. `collapsed` is a chip gutter sized to a 28px
// avatar plus clearance — there is nothing in it that benefits from more room,
// and a draggable 48px strip would just be a way to break the chip layout.
//
// MIN 260. Cards are fluid (`width: 100%`), and the chrome around them is
// fixed: the margin slot insets 12px per side, the card adds 13px + 12px of
// padding and 2px of border. So the text column is `railWidth - 51`. At 260
// that is 209px, which still fits the card's author row — a 16px avatar, a
// gap, a display name and a relative timestamp come to roughly 162px — on one
// line. Below about 240 that row wraps and the card stops reading as a card,
// so 260 is the last width where the content is intact rather than merely
// present.
//
// MAX 640, and — once there is room for it — never more than 40% of the row.
// The document stays the subject: on a typical 1440px window with the sidebar
// open the content row is ~1180px, so the 40% cap leaves the prose column
// above 700px, about 65 characters at the editorial body size, which is the
// measure the typeset presets are tuned for. The absolute 640 stops an
// ultrawide display from handing half the screen to comments just because the
// fraction allows it.
//
// The fraction never pushes the ceiling BELOW the default, though. attn's own
// window opens at 960px, which leaves a ~700px content row and a 40% share of
// only ~280 — narrower than the rail already is. A cap that tight would mean
// the very first drag in a default-size window silently shrank the rail and
// then refused to give it back. So a too-narrow window means "no extra room",
// not "a smaller default": the ceiling floors at `RAIL_WIDTH_PX.expanded` and
// the user gets a rail that can shrink but not grow until they have the space.
//
// `RAIL_WIDTH_MIN_PX` / `RAIL_WIDTH_MAX_PX` are mirrored by `RAIL_WIDTH_MIN` /
// `RAIL_WIDTH_MAX` in `src/prefs.rs`, which is the gate the *persisted* value
// passes through. The two must move together; `rail-width.test.ts` reads the
// Rust source and fails if they drift.
export const RAIL_WIDTH_MIN_PX = 260;
export const RAIL_WIDTH_MAX_PX = 640;
export const RAIL_WIDTH_MAX_FRACTION = 0.4;

/**
 * The widest the rail may get inside a content row of `rowWidth` px.
 *
 * Returns the absolute cap when the row has not been measured yet (0 on the
 * first frame, before the `bind:clientWidth` ResizeObserver reports) so a drag
 * started that early is bounded by something sane rather than by 0. Never
 * returns less than the default width — see the note above on why a narrow
 * window must not be able to redefine what "expanded" means.
 */
export function railResizeMax(rowWidth: number): number {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return RAIL_WIDTH_MAX_PX;
  const fromRow = Math.round(rowWidth * RAIL_WIDTH_MAX_FRACTION);
  return Math.max(RAIL_WIDTH_PX.expanded, Math.min(RAIL_WIDTH_MAX_PX, fromRow));
}

/**
 * Clamp a rail width to `[RAIL_WIDTH_MIN_PX, max]`, rounded to whole pixels.
 *
 * `max` defaults to the absolute cap: pass `railResizeMax(rowWidth)` while the
 * user is actually dragging, and leave it off for the value the component
 * renders. That split is deliberate — the row-relative cap must not retroactively
 * shrink a stored width just because the window is narrow this session, because
 * that would silently rewrite the user's preference on the next commit.
 *
 * A non-finite width (NaN from a bad parse, Infinity from a stale delta) falls
 * back to the default rather than to a bound: it means we lost the value, not
 * that the user asked for an extreme.
 */
export function clampRailWidth(width: number, max: number = RAIL_WIDTH_MAX_PX): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_PX.expanded;
  const upper = Math.max(RAIL_WIDTH_MIN_PX, Math.min(RAIL_WIDTH_MAX_PX, Math.round(max)));
  return Math.min(upper, Math.max(RAIL_WIDTH_MIN_PX, Math.round(width)));
}

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
  /** User-controlled open/hidden state (ReviewBar toggle / Cmd+J). */
  panelOpen: boolean;
}): RailMode {
  // No room, no rail — panelOpen is meaningless outside a review context
  // (it now DEFAULTS to open, so this gate is what keeps roomless
  // workspaces rail-free).
  if (!input.inReviewRoom) return 'hidden';
  return input.panelOpen ? 'expanded' : 'hidden';
}
