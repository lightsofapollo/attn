// Pure formatters for SnapshotBadge.svelte (attn-nnj.4.9).
//
// Lives in a separate `.ts` module so tsx-based tests can import without
// going through the .svelte compiler. Mirrors the pattern set by
// `connection-badge-format.ts` for the connection badge (4.11).
//
// Two formatter shapes are surfaced:
//
//   formatSnapshotAge(createdAtMs, nowMs)
//     -> "3 min ago", "2h ago", "5d ago"
//
//   formatSnapshotClock(createdAtMs)
//     -> "14:02" (24-hour HH:MM, local time)
//
// The reviewer perspective in §UI/UX uses the clock form ("Snapshot @ 14:02"),
// while the popover and owner tooltip use the relative-time form.

/**
 * Humanized "age" string for a snapshot's `createdAt`. Past timestamps use
 * "N {unit} ago"; future timestamps (clock skew) use "in N {unit}".
 *
 * Resolution ladder:
 *   < 60s   → "Ns ago"
 *   < 60m   → "N min ago"
 *   < 24h   → "Nh ago"
 *   else    → "Nd ago"
 *
 * Matches the spec text in `planning/collab/data-model.md` §UI/UX
 * ("3 min ago", "2h ago", etc.).
 */
export function formatSnapshotAge(createdAtMs: number, nowMs: number): string {
  const diff = createdAtMs - nowMs;
  const absSec = Math.round(Math.abs(diff) / 1000);
  if (absSec < 60) return diff < 0 ? `${absSec}s ago` : `in ${absSec}s`;
  const mins = Math.round(absSec / 60);
  if (mins < 60) return diff < 0 ? `${mins} min ago` : `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff < 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}

/**
 * Format a snapshot timestamp as a 24-hour wall-clock string ("HH:MM") in
 * the local timezone. Used in the reviewer label ("Snapshot @ 14:02") so
 * the reviewer always knows which point-in-time they're reviewing.
 */
export function formatSnapshotClock(createdAtMs: number): string {
  const d = new Date(createdAtMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
