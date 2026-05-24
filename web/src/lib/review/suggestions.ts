// Helpers for the owner-facing accept/reject UI over inline track-change marks
// (attn-07i.2 Phase 2). Suggestions are `insertion`/`deletion` marks carrying an
// `id` whose prefix encodes the author (see Editor.generateSuggestionId).

import type { EditorState } from 'prosemirror-state';

const SUGGESTION_MARK_NAMES = ['insertion', 'deletion'] as const;

export interface SuggestionInfo {
  /** The mark id (also the accept/reject target). */
  id: string;
  kind: 'insertion' | 'deletion';
  /** Document range the suggestion currently spans. */
  from: number;
  to: number;
  /** Human author name, decoded from the id prefix. */
  author: string;
  /** The suggested text (for previews / list rendering). */
  text: string;
}

/** Decode the author name encoded into a suggestion id (`<urlencoded>~rand`). */
export function decodeSuggestionAuthor(id: string | number): string {
  const raw = String(id).split('~')[0] ?? '';
  try {
    return decodeURIComponent(raw) || 'Someone';
  } catch {
    return raw || 'Someone';
  }
}

/** The full contiguous range + text of the suggestion with `id`/`kind`. */
function rangeForSuggestion(
  state: EditorState,
  kind: string,
  id: unknown,
): { from: number; to: number; text: string } | null {
  let from = -1;
  let to = -1;
  let text = '';
  state.doc.descendants((node, pos) => {
    if (
      node.isText &&
      node.marks.some((m) => m.type.name === kind && m.attrs.id === id)
    ) {
      if (from < 0) from = pos;
      to = pos + node.nodeSize;
      text += node.text ?? '';
    }
  });
  return from < 0 ? null : { from, to, text };
}

/**
 * The suggestion covering `pos` (or the character just before it, so a cursor
 * resting at the end of a suggestion still resolves), else `null`.
 */
export function findSuggestionAt(state: EditorState, pos: number): SuggestionInfo | null {
  const collect = (p: number) => {
    const $p = state.doc.resolve(p);
    return $p
      .marks()
      .find((m) => (SUGGESTION_MARK_NAMES as readonly string[]).includes(m.type.name));
  };
  const mark = collect(pos) ?? (pos > 0 ? collect(pos - 1) : undefined);
  if (!mark) return null;
  const range = rangeForSuggestion(state, mark.type.name, mark.attrs.id);
  if (!range) return null;
  return {
    id: String(mark.attrs.id),
    kind: mark.type.name as 'insertion' | 'deletion',
    from: range.from,
    to: range.to,
    author: decodeSuggestionAuthor(mark.attrs.id),
    text: range.text,
  };
}

/** The suggestion with `id` anywhere in the doc (used by the click handler,
 *  which reads the id straight off the clicked `<ins/del data-id>` element). */
export function findSuggestionById(
  state: EditorState,
  id: string,
): SuggestionInfo | null {
  let kind: 'insertion' | 'deletion' | null = null;
  let from = -1;
  let to = -1;
  let text = '';
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = node.marks.find(
      (mk) =>
        (SUGGESTION_MARK_NAMES as readonly string[]).includes(mk.type.name) &&
        String(mk.attrs.id) === String(id),
    );
    if (m) {
      kind = m.type.name as 'insertion' | 'deletion';
      if (from < 0) from = pos;
      to = pos + node.nodeSize;
      text += node.text ?? '';
    }
  });
  if (from < 0 || kind === null) return null;
  return { id: String(id), kind, from, to, author: decodeSuggestionAuthor(id), text };
}

/** True if the document currently has any pending suggestion marks. */
export function hasPendingSuggestions(state: EditorState): boolean {
  let found = false;
  state.doc.descendants((node) => {
    if (found) return false;
    if (
      node.marks?.some((m) =>
        (SUGGESTION_MARK_NAMES as readonly string[]).includes(m.type.name),
      )
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}
