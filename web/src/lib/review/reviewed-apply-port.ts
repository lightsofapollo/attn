import type { RequiresThreeWayVerdict } from '../types';

export type ReviewedApplyCallback = (
  verdict: RequiresThreeWayVerdict,
  replacement: string,
) => unknown | Promise<unknown>;

/** Omitted injection preserves native behavior; an explicit callback wins. */
export function selectReviewedApplyCallback(
  injected: ReviewedApplyCallback | undefined,
  native: ReviewedApplyCallback,
): ReviewedApplyCallback {
  return injected ?? native;
}
