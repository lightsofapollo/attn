// Line-and-word diff helpers for `ReviewApplyExpand.svelte` (attn-nnj.8.3).
//
// Wraps the `diff` package (Kevin Decker, BSD) to produce a small,
// strongly-typed shape the three-way apply UI can render directly. Two
// granularities:
//
//   - `diffLines(a, b)`     — full-line changes; each segment is `add`,
//                             `del`, or `same` and carries the raw line bytes
//                             *including* the trailing newline so the renderer
//                             can preserve original whitespace.
//   - `diffWordsInLine(a, b)` — intra-line word-level changes, used when both
//                               sides have an unchanged-line-count and we want
//                               to highlight what *inside* the line moved.
//
// No `any`. No runtime DOM dependency. Pure functions — safe to unit-test
// outside the Svelte component pipeline. See
// `planning/collab/ui/three-way-apply.md` §6 for the diff-coloring rules
// this module feeds.

import { diffLines as libDiffLines, diffWordsWithSpace } from 'diff';
import type { Change } from 'diff';

/** Single line-diff segment used by `ReviewApplyExpand.svelte`. */
export interface LineDiffSegment {
  /** Kind of change. `same` = present in both sides verbatim. */
  kind: 'add' | 'del' | 'same';
  /** Raw text of the segment (includes trailing newlines if present). */
  text: string;
}

/** Single intra-line word-diff segment. */
export interface WordDiffSegment {
  kind: 'add' | 'del' | 'same';
  text: string;
}

function classify(change: Change): 'add' | 'del' | 'same' {
  if (change.added) return 'add';
  if (change.removed) return 'del';
  return 'same';
}

/**
 * Line-level diff. Returns an ordered list of `add` / `del` / `same`
 * segments. Empty strings return a single `same` segment with empty text
 * (callers can short-circuit on `segments.every(s => s.kind === 'same')`).
 */
export function diffLines(a: string, b: string): LineDiffSegment[] {
  if (a === b) {
    return [{ kind: 'same', text: a }];
  }
  const changes = libDiffLines(a, b);
  const out: LineDiffSegment[] = [];
  for (const c of changes) {
    out.push({ kind: classify(c), text: c.value });
  }
  return out;
}

/**
 * Word-level diff *inside* a single line (or block of text). Useful for
 * showing intra-line changes when the line counts roughly match. Splits on
 * whitespace boundaries and treats them as word-equivalent atoms.
 */
export function diffWordsInLine(a: string, b: string): WordDiffSegment[] {
  if (a === b) {
    return [{ kind: 'same', text: a }];
  }
  const changes = diffWordsWithSpace(a, b);
  const out: WordDiffSegment[] = [];
  for (const c of changes) {
    out.push({ kind: classify(c), text: c.value });
  }
  return out;
}
