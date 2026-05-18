import type { EditorView } from 'prosemirror-view';

/**
 * Shared utility for positioning popovers relative to a ProseMirror
 * selection. Used by the comment composer, suggestion composer, and the
 * ambiguous anchor picker so they all pop in a consistent place.
 *
 * TODO(tests): the project does not currently configure a test runner.
 * Sibling file `popover-anchor.test.ts` contains pure-function specs
 * that should be wired up once vitest (or equivalent) is added.
 */

export type PopoverSide = 'above' | 'below';

export interface PopoverAnchor {
  /** The DOM rect of the selection (leading rect for multi-line selections). */
  rect: DOMRect;
  /** Recommended position for the popover, constrained to the viewport. */
  recommendedPosition: {
    top: number;
    left: number;
    side: PopoverSide;
  };
}

export interface PopoverOptions {
  /** Popover width in pixels (used for horizontal clamping). Default 320. */
  width?: number;
  /** Popover height in pixels (used to decide above vs below). Default 200. */
  height?: number;
  /** Margin between selection and popover. Default 8. */
  gap?: number;
  /** Viewport reference. Default `document.documentElement`. */
  viewport?: { clientWidth: number; clientHeight: number };
}

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 200;
const DEFAULT_GAP = 8;
const VIEWPORT_EDGE_MARGIN = 8;

interface PmCoords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function makeRect(left: number, top: number, right: number, bottom: number): DOMRect {
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  // Prefer the real DOMRect constructor when available (browsers, jsdom).
  // Fall back to a structural object cast to DOMRect for environments where
  // it isn't defined (some headless test runtimes).
  if (typeof DOMRect === 'function') {
    return new DOMRect(left, top, width, height);
  }
  const rect = {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width,
    height,
    toJSON(): unknown {
      return { x: left, y: top, left, top, right, bottom, width, height };
    },
  };
  return rect as unknown as DOMRect;
}

function resolveViewport(
  viewport: PopoverOptions['viewport'],
): { clientWidth: number; clientHeight: number } {
  if (viewport) return viewport;
  if (typeof document !== 'undefined' && document.documentElement) {
    return {
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
    };
  }
  // Conservative fallback so positioning math still produces sensible values
  // in non-DOM environments (tests).
  return { clientWidth: 1024, clientHeight: 768 };
}

/**
 * Compute the DOM rect for a ProseMirror selection plus a recommended
 * popover position clamped to the viewport. For multi-line selections,
 * we use the *leading* rect (the first line where the cursor was placed)
 * so the popover stays close to the start of the selection.
 */
export function getPopoverAnchor(
  view: EditorView,
  from: number,
  to: number,
  options?: PopoverOptions,
): PopoverAnchor {
  const width = options?.width ?? DEFAULT_WIDTH;
  const height = options?.height ?? DEFAULT_HEIGHT;
  const gap = options?.gap ?? DEFAULT_GAP;
  const viewport = resolveViewport(options?.viewport);

  const start: PmCoords = view.coordsAtPos(from);
  const end: PmCoords = view.coordsAtPos(to);

  // Determine whether the selection spans multiple visual lines. If so, only
  // use the leading line's rect. Otherwise the rect spans from `from` to `to`.
  const sameLine = Math.abs(start.top - end.top) < 1 && Math.abs(start.bottom - end.bottom) < 1;

  let rectLeft: number;
  let rectRight: number;
  const rectTop = start.top;
  const rectBottom = start.bottom;
  if (sameLine) {
    rectLeft = Math.min(start.left, end.left);
    rectRight = Math.max(start.right, end.right);
  } else {
    // Multi-line: leading rect runs from the selection start to the right
    // edge of the viewport (since the line wraps further down). Clamp to a
    // sensible visible region.
    rectLeft = start.left;
    rectRight = Math.max(start.right, viewport.clientWidth - VIEWPORT_EDGE_MARGIN);
  }

  const rect = makeRect(rectLeft, rectTop, rectRight, rectBottom);

  // Decide above vs below. Prefer below; flip if below overflows the viewport.
  const fitsBelow = rect.bottom + gap + height <= viewport.clientHeight;
  const side: PopoverSide = fitsBelow ? 'below' : 'above';

  // Horizontal centering on the selection rect midpoint, clamped to viewport.
  const midpoint = rect.left + rect.width / 2;
  const idealLeft = midpoint - width / 2;
  const maxLeft = viewport.clientWidth - VIEWPORT_EDGE_MARGIN - width;
  const minLeft = VIEWPORT_EDGE_MARGIN;
  // If width exceeds viewport, clamp to minLeft rather than producing a
  // negative max.
  const clampedLeft = maxLeft < minLeft
    ? minLeft
    : Math.min(Math.max(idealLeft, minLeft), maxLeft);

  const top = side === 'below'
    ? rect.bottom + gap
    : rect.top - gap - height;

  return {
    rect,
    recommendedPosition: {
      top,
      left: clampedLeft,
      side,
    },
  };
}

/** True if the current ProseMirror selection is a non-empty text range. */
export function hasTextSelection(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.empty) return false;
  return selection.to > selection.from;
}
