// Overlap resolution for remote carets + selections (attn-5xgz).
//
// Two peers selecting the same text used to render as two independent
// decorations: caret labels sat at identical absolute offsets (one occluded
// the other) and overlapping selection tints either stacked into mud or
// silently dropped one peer's color depending on how ProseMirror merged the
// spans. These pure helpers compute what the plugin should actually draw:
//
//   * caretStacks   — a deterministic vertical stack index for carets that
//                     share a (clamped) head position, so every label stays
//                     readable and every viewer sees the same ordering.
//   * selectionSegments — all peer selections split into disjoint segments,
//                     each carrying the covering peers in a deterministic
//                     order; segments covered by 2+ peers get an explicit
//                     shared treatment instead of accidental span nesting.
//
// Kept runes-free/pure so the tsx test harness exercises the exact
// contracts the plugin renders from.

import type { RemoteCursor } from './collab-controller';

/** Clamp a document offset into [0, max]. Mirrors the plugin's clamping so
 * stacking agrees with where the widget actually lands. */
export function clampPos(pos: number, max: number): number {
  return Math.min(Math.max(pos, 0), max);
}

/**
 * clientID → vertical stack index among carets sharing the same clamped
 * head position. Ordering within a shared position is by clientID so both
 * sides of a session stack identically. Lone carets get 0.
 */
export function caretStacks(
  cursors: readonly RemoteCursor[],
  max: number,
): Map<string, number> {
  const byPos = new Map<number, RemoteCursor[]>();
  for (const cursor of cursors) {
    const pos = clampPos(cursor.head, max);
    const group = byPos.get(pos);
    if (group) group.push(cursor);
    else byPos.set(pos, [cursor]);
  }
  const stacks = new Map<string, number>();
  for (const group of byPos.values()) {
    group.sort((a, b) => (a.clientID < b.clientID ? -1 : a.clientID > b.clientID ? 1 : 0));
    group.forEach((cursor, index) => stacks.set(cursor.clientID, index));
  }
  return stacks;
}

/** One disjoint slice of the document covered by ≥1 peer selection. Covering
 * cursors are sorted by clientID (deterministic on every client). */
export interface SelectionSegment {
  from: number;
  to: number;
  cursors: RemoteCursor[];
}

/**
 * Split every peer selection into disjoint segments. Boundaries are the
 * union of all selection endpoints, so each returned segment has a STABLE
 * set of covering peers — the renderer draws exactly one decoration per
 * segment (single tint, or the shared two-color treatment).
 */
export function selectionSegments(
  cursors: readonly RemoteCursor[],
  max: number,
): SelectionSegment[] {
  interface Range {
    from: number;
    to: number;
    cursor: RemoteCursor;
  }
  const ranges: Range[] = [];
  for (const cursor of cursors) {
    if (cursor.anchor === undefined) continue;
    const head = clampPos(cursor.head, max);
    const anchor = clampPos(cursor.anchor, max);
    const from = Math.min(head, anchor);
    const to = Math.max(head, anchor);
    if (from < to) ranges.push({ from, to, cursor });
  }
  if (ranges.length === 0) return [];
  const bounds = Array.from(
    new Set(ranges.flatMap((r) => [r.from, r.to])),
  ).sort((a, b) => a - b);
  const segments: SelectionSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    const covering = ranges
      .filter((r) => r.from <= from && r.to >= to)
      .map((r) => r.cursor)
      .sort((a, b) => (a.clientID < b.clientID ? -1 : a.clientID > b.clientID ? 1 : 0));
    if (covering.length > 0) segments.push({ from, to, cursors: covering });
  }
  return segments;
}
