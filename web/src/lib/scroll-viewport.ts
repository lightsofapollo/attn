// Generic nearest-scroll-ancestor lookup for review overlays.
//
// The review surfaces disagree on what scrolls: native and the hosted owner
// wrap the editor in a shadcn ScrollArea (`[data-slot="scroll-area-viewport"]`),
// while the reviewer /s/ page scrolls a plain `overflow-auto` div. Anything
// that keys scroll listeners or visibility math off the ScrollArea slot
// silently no-ops on the reviewer page (frozen margin cards, dead find-bar
// scrolling). Walk the real computed styles instead.

import type { EditorView } from 'prosemirror-view';

export function nearestScrollableAncestor(el: Element): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

const VIEWPORT_READING_INSET_PX = 80;

/** Convert a content-space anchor into the matching reader viewport offset. */
export function scrollTopForViewportAnchor(yInContent: number): number {
  return Math.max(0, yInContent - VIEWPORT_READING_INSET_PX);
}

/**
 * Align a document position with the editor's reading-band top (attn-qs03) —
 * the jump-to-peer primitive. Shares the viewport-resolution and coordsAtPos math
 * with Editor.svelte's `ensureSelectionVisible`, but targets an ARBITRARY pos
 * (a peer's viewport anchor) rather than the local selection.
 *
 * Pure side effect on the DOM: it does NOT move the local selection (so it
 * won't rebroadcast the local caret or disturb a read-only reviewer view). The
 * position is clamped to the doc so a caret head from a slightly different
 * revision never throws — worst case it lands a line or two off.
 */
export function scrollViewToPos(view: EditorView, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.content.size));
  const viewport = ((
    view.dom.closest('[data-slot="scroll-area-viewport"]')
    ?? view.dom.closest('.attn-content-viewport')
  ) as HTMLElement | null)
    ?? nearestScrollableAncestor(view.dom);
  if (!viewport) return;

  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(clamped, 1);
  } catch {
    // A torn-down or not-yet-laid-out view can't resolve coords; skip.
    return;
  }
  const viewportRect = viewport.getBoundingClientRect();
  const yInContent = coords.top - viewportRect.top + viewport.scrollTop;
  viewport.scrollTo({ top: scrollTopForViewportAnchor(yInContent), behavior: 'smooth' });
}

/**
 * Resolve the document position at the top of the reader's meaningful viewing
 * band. This is deliberately separate from the selection: a person can read
 * paragraph 40 while their caret remains back in paragraph 2.
 */
export function viewPositionAtViewport(view: EditorView): number | null {
  const viewport = ((
    view.dom.closest('[data-slot="scroll-area-viewport"]')
    ?? view.dom.closest('.attn-content-viewport')
  ) as HTMLElement | null)
    ?? nearestScrollableAncestor(view.dom);
  if (!viewport) return null;

  const viewportRect = viewport.getBoundingClientRect();
  const editorRect = view.dom.getBoundingClientRect();
  const top = Math.min(viewportRect.bottom - 1, viewportRect.top + VIEWPORT_READING_INSET_PX);
  const left = Math.min(editorRect.right - 1, editorRect.left + 12);
  const found = view.posAtCoords({ left, top });
  if (found) return found.pos;

  // Narrow tables and other indented blocks may not occupy the editor's left
  // edge. A centre-column retry still identifies the first visible block.
  const retry = view.posAtCoords({ left: editorRect.left + editorRect.width / 2, top });
  return retry?.pos ?? null;
}
