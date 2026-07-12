import type { EditorView } from 'prosemirror-view';
import { getPopoverAnchor, type PopoverAnchor, type PopoverOptions } from './popover-anchor';

/**
 * Reactive popover anchor that follows the selection while the document
 * scrolls (Theme v2, attn-5bq). Selection popovers previously computed
 * their position once and detached from the text on scroll.
 *
 * The scroll listener is scoped to the popover's mount lifetime (these
 * surfaces live for seconds) and rAF-gated, so there is no steady-state
 * scroll cost. Callers: `const anchor = createAnchorTracker(() => view,
 * () => from, () => to, opts)` inside a component, then `anchor.current`.
 */
export function createAnchorTracker(
  view: () => EditorView,
  from: () => number,
  to: () => number,
  opts?: PopoverOptions,
): { readonly current: PopoverAnchor } {
  let current = $state(getPopoverAnchor(view(), from(), to(), opts));

  $effect(() => {
    // Re-derive on selection changes too.
    current = getPopoverAnchor(view(), from(), to(), opts);
    let raf = 0;
    const reposition = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        current = getPopoverAnchor(view(), from(), to(), opts);
      });
    };
    // Scroll doesn't bubble but does capture; the document pane scrolls.
    document.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
      if (raf) cancelAnimationFrame(raf);
    };
  });

  return {
    get current() {
      return current;
    },
  };
}
