/**
 * Copy-to-clipboard feedback for a margin card's header Copy button.
 *
 * The parent owns the clipboard write; the card only needs to know whether
 * it worked so it can swap the copy glyph for a check for a moment. The
 * contract with ReviewMargin is deliberately loose: anything but an explicit
 * `false` (or a throw) counts as success, so a handler that returns nothing
 * still gets the checkmark.
 *
 * Kept out of the component so the timing rules — one check per success,
 * a second success restarting the clock instead of cutting the first
 * short — can run under plain Node in the unit tests.
 */

export type CopyFeedbackAction = () => Promise<boolean | void> | boolean | void;

/** How long the check replaces the copy glyph after a successful copy. */
export const COPIED_RESET_MS = 1500;

export interface CopyFeedbackController {
  /** Runs the action; resolves `true` when the check should be shown. */
  run(action: CopyFeedbackAction | undefined): Promise<boolean>;
  /** Cancels a pending reset. Call on unmount. */
  dispose(): void;
}

export function createCopyFeedbackController(
  report: (copied: boolean) => void,
  resetAfterMs: number = COPIED_RESET_MS,
): CopyFeedbackController {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    async run(action) {
      if (!action) return false;
      let ok: boolean;
      try {
        ok = (await action()) !== false;
      } catch {
        ok = false;
      }
      if (!ok) return false;
      clearTimer();
      report(true);
      timer = setTimeout(() => {
        timer = null;
        report(false);
      }, resetAfterMs);
      return true;
    },
    dispose() {
      clearTimer();
    },
  };
}
