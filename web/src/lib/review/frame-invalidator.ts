export interface FrameInvalidator {
  request(): void;
  cancel(): void;
}

/**
 * Coalesce reactive geometry invalidations behind a browser frame.
 *
 * Layout measurement often reads a derived placement and then discovers that
 * the measured height changed. Writing the placement signal synchronously
 * from that same effect creates an indirect effect -> derived -> effect cycle.
 * A frame boundary both batches noisy ResizeObserver/scroll callbacks and
 * guarantees the next invalidation cannot recurse inside the current Svelte
 * flush.
 */
export function createFrameInvalidator(
  invalidate: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): FrameInvalidator {
  let pending: number | null = null;

  return {
    request(): void {
      if (pending !== null) return;
      pending = requestFrame(() => {
        pending = null;
        invalidate();
      });
    },
    cancel(): void {
      if (pending === null) return;
      cancelFrame(pending);
      pending = null;
    },
  };
}
