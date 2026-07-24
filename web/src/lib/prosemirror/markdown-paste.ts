// Markdown-aware paste (attn-o7sq): pasting markdown *source* should render as
// real nodes and round-trip to clean markdown on save — not arrive as literal
// `#`/`-` syntax (ProseMirror's default plain-text paste) or as DOM-parsed
// "copy style" (its default text/html paste through the schema's parseDOM
// rules, which serializes back to junk). This routes the pasted text through
// the SAME `markdownParser` used to load a document, so paste and load agree.
//
// It is deliberately conservative about when it fires:
//   • never inside a code block / code mark — raw text is correct there;
//   • never for an internal attn→attn copy (ProseMirror tags its clipboard
//     HTML with `data-pm-slice`) — the stock parser restores that structure
//     faithfully, syntax-free;
//   • when foreign rich HTML is present, only override it when the plain text
//     is clearly markdown source — otherwise honor the rich paste;
//   • falls back to the default paste on parse failure or oversized input.

import { Plugin } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';
import type { MarkdownParser } from 'prosemirror-markdown';
import type { EditorView } from 'prosemirror-view';

// Above this we don't block the UI thread re-parsing on paste; the default
// plain-text insert runs instead. Mirrors Editor.svelte's own large-doc guard
// register (it drops to safe mode well before this) — paste is a one-shot cost
// so the bar can sit higher than a live-typed document's.
const MAX_PASTE_PARSE_CHARS = 500_000;

/**
 * Heuristic: does this plain text carry block-level markdown that would look
 * wrong pasted literally? Inline-only markers (`**bold**`, links) are excluded
 * — on their own they're too common in ordinary prose to justify overriding a
 * genuinely-rich HTML paste. Block markers (headings, lists, fences, quotes,
 * tables, ATX rules) are the ones that read as broken when inserted verbatim.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return true; // heading
    if (/^\s{0,3}([-*+])\s/.test(line)) return true; // bullet list
    if (/^\s{0,3}\d+[.)]\s/.test(line)) return true; // ordered list
    if (/^\s{0,3}>\s/.test(line)) return true; // blockquote
    if (/^\s{0,3}(```|~~~)/.test(line)) return true; // fenced code
    if (/^\s{0,3}\|.*\|\s*$/.test(line)) return true; // table row
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return true; // thematic break
  }
  return false;
}

/**
 * Parse markdown text into a ProseMirror slice suitable for `replaceSelection`.
 * A lone paragraph yields an inline slice so a short paste flows into the
 * caret's block; anything with real block structure yields a block slice.
 * Returns `null` when the text isn't parseable or is empty.
 */
export function markdownPasteSlice(parser: MarkdownParser, text: string): Slice | null {
  let doc;
  try {
    doc = parser.parse(text);
  } catch {
    return null;
  }
  if (!doc || doc.content.size === 0) return null;
  // A single paragraph is inline content — insert it inline so pasting a
  // sentence mid-line doesn't split the surrounding block. An empty parse
  // (blank or whitespace-only text) collapses to an empty paragraph here;
  // treat that as nothing to insert.
  const slice =
    doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph'
      ? new Slice(doc.firstChild.content, 0, 0)
      : new Slice(doc.content, 0, 0);
  return slice.content.size === 0 ? null : slice;
}

/**
 * ProseMirror plugin that reinterprets pasted markdown source through
 * `parser`. Wire it into the editor's plugin list.
 */
export function markdownPastePlugin(parser: MarkdownParser): Plugin {
  return new Plugin({
    props: {
      handlePaste(view: EditorView, event: ClipboardEvent): boolean {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;

        // Raw text is correct inside a code block or an inline code mark.
        const { $from } = view.state.selection;
        if ($from.parent.type.spec.code) return false;
        const codeMark = view.state.schema.marks.code;
        if (codeMark && codeMark.isInSet($from.marks())) return false;

        const text = clipboard.getData('text/plain');
        if (!text.trim()) return false;
        if (text.length > MAX_PASTE_PARSE_CHARS) return false;

        const html = clipboard.getData('text/html');
        if (html) {
          // An internal attn→attn copy: let ProseMirror restore its own slice
          // faithfully instead of round-tripping through markdown.
          if (html.includes('data-pm-slice')) return false;
          // Genuinely-rich foreign HTML (a web page, a doc app): only override
          // it when the plain text is unmistakably markdown source.
          if (!looksLikeMarkdown(text)) return false;
        }

        const slice = markdownPasteSlice(parser, text);
        if (!slice) return false;

        // Returning true tells ProseMirror to skip its own clipboard handling.
        const tr = view.state.tr.replaceSelection(slice).scrollIntoView();
        view.dispatch(tr);
        return true;
      },
    },
  });
}
