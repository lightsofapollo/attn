// Pure formatter shared by the review-dock popovers (PeerStrip & co). Lives in a
// separate `.ts` module so tsx-based tests can import it without going
// through the .svelte compiler.
//
// Renders a minimal relative-time string for the badge popover's
// "last seen" / "expires" fields.

/**
 * Default formatter for the badge's last-seen / expires-at strings.
 *
 * Inputs are absolute timestamps in milliseconds; output is a short
 * humanized relative-time string. Past times use "Ns ago"; future times
 * use "in Ns".
 */
export function defaultFormatLastSeen(timestampMs: number, nowMs: number): string {
  const diff = timestampMs - nowMs;
  const absSec = Math.round(Math.abs(diff) / 1000);
  if (absSec < 60) return diff < 0 ? `${absSec}s ago` : `in ${absSec}s`;
  const mins = Math.round(absSec / 60);
  if (mins < 60) return diff < 0 ? `${mins}m ago` : `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff < 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}
