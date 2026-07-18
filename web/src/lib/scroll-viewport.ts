// Generic nearest-scroll-ancestor lookup for review overlays.
//
// The review surfaces disagree on what scrolls: native and the hosted owner
// wrap the editor in a shadcn ScrollArea (`[data-slot="scroll-area-viewport"]`),
// while the reviewer /s/ page scrolls a plain `overflow-auto` div. Anything
// that keys scroll listeners or visibility math off the ScrollArea slot
// silently no-ops on the reviewer page (frozen margin cards, dead find-bar
// scrolling). Walk the real computed styles instead.

export function nearestScrollableAncestor(el: Element): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}
