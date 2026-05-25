/**
 * A review thread leaves the active margin (both the anchored list and the
 * orphan tray) once it is resolved OR locally dismissed.
 *
 * `dismissed` holds thread ids the user has acted on — Resolve (optimistic,
 * pending the CommentResolved echo) or Reject (UI-only). This rule HIDES such a
 * thread immediately. Previously `dismissed` only *disabled* the card's
 * Reply/Resolve buttons while waiting for the echo; if the echo never arrived
 * (relay-only / offline), the card lingered with both buttons dead forever.
 * Hiding it instead means the action always takes visible effect.
 */
export function isThreadActive(
  thread: { id: string; resolved: boolean },
  dismissed: ReadonlySet<string>,
): boolean {
  return !thread.resolved && !dismissed.has(thread.id);
}
