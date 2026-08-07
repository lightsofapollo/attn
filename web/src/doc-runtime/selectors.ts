/**
 * W3C Web Annotation selector generation and resolution, run inside the
 * document frame.
 *
 * This is the only place HTML anchors are ever interpreted. Rust persists them
 * as opaque blobs, which is what keeps a headless HTML parser out of the binary.
 *
 * Generation writes *every* layer at creation time (CSS selector + ranked
 * fallbacks, text quote with prefix/suffix, text position, range) so that
 * resolution has something to fall back to when the document changes.
 * Resolution walks those layers from strongest to weakest and reports how it
 * matched, so the rail can show confidence honestly.
 *
 * @see planning/collab/html-annotation.md §2
 * @see https://www.w3.org/TR/annotation-model/
 */

import type {
  HtmlAnchor,
  HtmlAnchorContext,
  HtmlRangeSelector,
} from '../lib/types';
import type { DocResolutionStatus } from '../lib/review/doc-protocol';

const encoder = new TextEncoder();

/** UTF-8 byte length, the unit all offsets are expressed in. */
function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Truncate to at most `maxChars` code points AND `maxBytes` UTF-8 bytes.
 *
 * Every string the runtime emits is re-validated by the shell's parser in
 * BYTES (doc-protocol.ts), so a producer that slices by characters silently
 * over-runs the cap by up to 4× on CJK/emoji text — and the parser then drops
 * the whole message, which reads as "commenting doesn't work on this
 * document". Walking code points (never code units) also guarantees a
 * surrogate pair is never split into a lone half.
 */
export function clampText(value: string, maxChars: number, maxBytes: number): string {
  let bytes = 0;
  let chars = 0;
  let unitEnd = 0;
  for (const cp of value) {
    const cpBytes = byteLength(cp);
    if (chars + 1 > maxChars || bytes + cpBytes > maxBytes) break;
    bytes += cpBytes;
    chars += 1;
    unitEnd += cp.length;
  }
  return unitEnd === value.length ? value : value.slice(0, unitEnd);
}

// ---------------------------------------------------------------------------
// Text coordinates
// ---------------------------------------------------------------------------

function textWalker(root: Element): TreeWalker {
  return root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
}

/** UTF-8 byte offset of `(node, offset)` within `root`'s rendered text. */
export function textOffsetOf(root: Element, node: Node, offset: number): number {
  if (node.nodeType !== Node.TEXT_NODE) {
    // An element boundary: count everything before it, which for a container
    // means all text of its preceding siblings' subtrees.
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return byteLength(range.toString());
  }
  let total = 0;
  const walker = textWalker(root);
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return total + byteLength((current.nodeValue ?? '').slice(0, offset));
    }
    total += byteLength(current.nodeValue ?? '');
    current = walker.nextNode();
  }
  return total;
}

/** Inverse of {@link textOffsetOf}: locate a byte offset in the DOM. */
function positionAt(root: Element, target: number): { node: Text; offset: number } | null {
  let seen = 0;
  const walker = textWalker(root);
  let current = walker.nextNode() as Text | null;
  let last: { node: Text; offset: number } | null = null;
  while (current) {
    const value = current.nodeValue ?? '';
    const bytes = byteLength(value);
    if (seen + bytes >= target) {
      // Walk CODE POINTS (not code units) until the byte budget is met —
      // string indices and byte offsets diverge for any non-ASCII text, and
      // indexing an astral character per code unit would count each lone
      // surrogate half as a 3-byte U+FFFD (6 bytes for an emoji instead of 4),
      // skewing every offset to the right of it.
      let consumed = 0;
      let unitIndex = 0;
      for (const cp of value) {
        if (seen + consumed >= target) return { node: current, offset: unitIndex };
        consumed += byteLength(cp);
        unitIndex += cp.length;
      }
      return { node: current, offset: value.length };
    }
    seen += bytes;
    last = { node: current, offset: value.length };
    current = walker.nextNode() as Text | null;
  }
  return last;
}

/** Build a DOM range from UTF-8 byte offsets into `root`'s rendered text. */
export function rangeFromTextOffsets(root: Element, start: number, end: number): Range | null {
  const from = positionAt(root, start);
  const to = positionAt(root, end);
  if (!from || !to) return null;
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

/** The document's canonical rendered text. */
export function documentText(root: Element): string {
  return root.textContent ?? '';
}

// ---------------------------------------------------------------------------
// Selector generation
// ---------------------------------------------------------------------------

const CELL_TAGS = new Set(['TD', 'TH']);

const isCell = (el: Element): boolean => CELL_TAGS.has(el.tagName);

function rowIndex(tr: Element): number {
  const section = tr.parentElement;
  if (!section) return 1;
  return Array.from(section.children).filter((c) => c.tagName === 'TR').indexOf(tr) + 1;
}

function nthOfType(el: Element): string {
  const parent = el.parentElement;
  if (!parent) return '';
  const sames = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sames.length <= 1) return '';
  return `:nth-of-type(${sames.indexOf(el) + 1})`;
}

/**
 * Is this id safe to anchor on? Framework-generated ids (`:r1:`, `react-aria…`,
 * long hex blobs) change every render, so an anchor keyed on one is worse than
 * a structural path — it looks precise and silently breaks.
 */
function isStableId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
  if (/^(react|radix|mui|headless|aria)[-_]/i.test(id)) return false;
  return !/[0-9a-f]{8,}/i.test(id);
}

function stableClass(el: Element): string {
  if (typeof el.className !== 'string') return '';
  const classes = el.className.trim().split(/\s+/).filter(Boolean);
  for (const cls of classes) {
    // Skip hashed/utility-looking classes for the same reason as ids.
    if (/^[\w-]+$/.test(cls) && cls.length <= 40 && !/[0-9a-f]{6,}/i.test(cls)) {
      return `.${CSS.escape(cls)}`;
    }
  }
  return '';
}

function rowSelector(tr: Element): string {
  const section = tr.parentElement;
  const table = tr.closest('table');
  const parts = [table ? cssSelectorFor(table) : 'table'];
  if (section && section !== table) parts.push(section.tagName.toLowerCase());
  parts.push(`tr:nth-of-type(${rowIndex(tr)})`);
  return parts.join(' > ');
}

function cellSelector(td: Element): string {
  const tr = td.closest('tr');
  if (!tr) return td.tagName.toLowerCase();
  const sames = Array.from(tr.children).filter((c) => c.tagName === td.tagName);
  return `${rowSelector(tr)} > ${td.tagName.toLowerCase()}:nth-of-type(${sames.indexOf(td) + 1})`;
}

/**
 * Primary W3C `CssSelector` for an element. Table structures get a semantic
 * path (`table > tbody > tr:nth-of-type(3)`) because that survives content
 * edits that reorder nothing, which is the common case in a reviewed document.
 */
export function cssSelectorFor(el: Element): string {
  if (el.id && isStableId(el.id)) return `#${CSS.escape(el.id)}`;
  if (el.tagName === 'TR') return rowSelector(el);
  if (isCell(el)) return cellSelector(el);
  return `${el.tagName.toLowerCase()}${stableClass(el)}${nthOfType(el)}`;
}

/**
 * Ranked alternates, most specific first. Each is a genuinely different
 * addressing strategy rather than a truncation of the primary, so a change that
 * breaks one has a real chance of leaving another intact.
 */
export function fallbackSelectorsFor(el: Element): string[] {
  const out: string[] = [];
  const push = (selector: string) => {
    if (selector && !out.includes(selector) && out.length < 8) out.push(selector);
  };

  // Absolute structural path from the body — survives class/id churn.
  const path: string[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor.tagName !== 'BODY' && path.length < 12) {
    path.unshift(`${cursor.tagName.toLowerCase()}${nthOfType(cursor)}`);
    cursor = cursor.parentElement;
  }
  if (path.length > 0) push(path.join(' > '));

  // Nearest stable ancestor id + a descendant path — survives sibling churn
  // above that ancestor.
  let ancestor: Element | null = el.parentElement;
  const tail: string[] = [`${el.tagName.toLowerCase()}${nthOfType(el)}`];
  while (ancestor && ancestor.tagName !== 'BODY' && tail.length < 6) {
    if (ancestor.id && isStableId(ancestor.id)) {
      push(`#${CSS.escape(ancestor.id)} ${tail.join(' > ')}`);
      break;
    }
    tail.unshift(`${ancestor.tagName.toLowerCase()}${nthOfType(ancestor)}`);
    ancestor = ancestor.parentElement;
  }

  const cls = stableClass(el);
  if (cls) push(`${el.tagName.toLowerCase()}${cls}`);

  return out.filter((selector) => selector !== cssSelectorFor(el));
}

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

const ROLE_BY_TAG: Record<string, string> = {
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  TABLE: 'table',
  LI: 'listitem',
  UL: 'list',
  OL: 'list',
  P: 'paragraph',
  BLOCKQUOTE: 'blockquote',
  FIGURE: 'figure',
  IMG: 'img',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
};

/**
 * The agent-legible context block. This is what makes a comment actionable to a
 * coding agent that never saw the document.
 */
export function contextFor(el: Element, scopePreview: string): HtmlAnchorContext {
  const domPath: string[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor.tagName !== 'BODY' && domPath.length < 8) {
    domPath.unshift(cursor.tagName.toLowerCase());
    cursor = cursor.parentElement;
  }
  const role = el.getAttribute('role') ?? ROLE_BY_TAG[el.tagName];
  const context: HtmlAnchorContext = {
    tagName: el.tagName.toLowerCase(),
    // Parser + Rust cap: 256 BYTES (MAX_HTML_SCOPE_PREVIEW_BYTES).
    scopePreview: clampText(scopePreview, 200, 256),
    domPath,
  };
  if (role) context.role = role;
  return context;
}

// ---------------------------------------------------------------------------
// Anchor construction
// ---------------------------------------------------------------------------

function rangeSelectorFor(root: Element, range: Range): HtmlRangeSelector | null {
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const endEl =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  if (!startEl || !endEl || startEl === endEl) return null;
  return {
    startSelector: cssSelectorFor(startEl),
    startOffset: textOffsetOf(startEl, range.startContainer, range.startOffset),
    endSelector: cssSelectorFor(endEl),
    endOffset: textOffsetOf(endEl, range.endContainer, range.endOffset),
  };
}

/** Build a full selector set for a text selection. */
export function anchorForRange(root: Element, range: Range): HtmlAnchor {
  const common =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : (range.commonAncestorContainer.parentElement ?? root);
  const start = textOffsetOf(root, range.startContainer, range.startOffset);
  const end = textOffsetOf(root, range.endContainer, range.endOffset);
  const anchor: HtmlAnchor = {
    v: 1,
    target: 'text_range',
    cssSelector: cssSelectorFor(common),
    fallbackSelectors: fallbackSelectorsFor(common),
    textPosition: { start, end },
    context: contextFor(common, clampText(range.toString(), 120, 256)),
  };
  const rangeSelector = rangeSelectorFor(root, range);
  if (rangeSelector) anchor.range = rangeSelector;
  return anchor;
}

/** Build a full selector set for a whole element. */
export function anchorForElement(root: Element, el: Element, preview: string): HtmlAnchor {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(el);
  return {
    v: 1,
    target: 'element',
    cssSelector: cssSelectorFor(el),
    fallbackSelectors: fallbackSelectorsFor(el),
    textPosition: {
      start: textOffsetOf(root, range.startContainer, range.startOffset),
      end: textOffsetOf(root, range.endContainer, range.endOffset),
    },
    context: contextFor(el, preview),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolutionResult {
  range: Range | null;
  element: Element | null;
  status: DocResolutionStatus;
  confidence: number;
}

const STALE: ResolutionResult = {
  range: null,
  element: null,
  status: 'stale',
  confidence: 0,
};

/** Fold whitespace and smart punctuation so cosmetic edits still match. */
export function normalizeText(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * {@link normalizeText}, plus per-character maps back to raw code-unit
 * coordinates: `starts[i]`/`ends[i]` bound the raw text that normalized
 * character `i` stands for (a collapsed space stands for its whole run).
 *
 * The normalized tier exists precisely because the raw text differs from the
 * quote, so a raw-text `indexOf` probe of the normalized quote fails exactly
 * when the tier should succeed (the cosmetic edit sits inside the probe). The
 * maps make the match location exact in raw coordinates instead of guessed.
 */
export function normalizeTextWithMap(value: string): {
  normalized: string;
  starts: number[];
  ends: number[];
} {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let runStart = -1;
  for (let i = 0; i < value.length; i += 1) {
    let ch = value[i];
    if (/\s/.test(ch)) {
      // Collapse the run; remember where it began. A leading run is dropped
      // entirely (trim), which `runStart` handles by only flushing when
      // something precedes it.
      if (runStart === -1) runStart = i;
      continue;
    }
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    else if (ch === '–' || ch === '—') ch = '-';
    if (runStart !== -1 && out.length > 0) {
      out.push(' ');
      starts.push(runStart);
      ends.push(i);
    }
    runStart = -1;
    out.push(ch);
    starts.push(i);
    ends.push(i + 1);
  }
  // A trailing run is trimmed: never flushed.
  return { normalized: out.join(''), starts, ends };
}

function querySafe(root: Element, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    // A selector authored against a different document can be syntactically
    // invalid here; that is a miss, not a crash.
    return null;
  }
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + 1;
    if (out.length > 64) return out;
  }
}

/** Shared-prefix length, used to score which occurrence the context favours. */
function affinity(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let score = 0;
  while (score < len && a[score] === b[score]) score += 1;
  return score;
}

/**
 * Pick among several occurrences of the same quote using the recorded
 * prefix/suffix. An undisambiguated tie resolves to `ambiguous` rather than
 * silently picking one — a misplaced highlight the user cannot see is worse
 * than an honest "this moved".
 */
function disambiguate(
  text: string,
  matches: number[],
  quoteLength: number,
  prefix: string,
  suffix: string,
): { index: number; ambiguous: boolean } {
  const scored = matches.map((at) => {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(at + quoteLength, at + quoteLength + suffix.length);
    const score =
      affinity([...before].reverse().join(''), [...prefix].reverse().join('')) +
      affinity(after, suffix);
    return { at, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const ambiguous = scored.length > 1 && scored[0].score === scored[1].score;
  return { index: scored[0].at, ambiguous };
}

export interface ResolveInput {
  anchor: HtmlAnchor;
  quote?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Resolve an anchor against the current DOM, strongest layer first.
 *
 * Element anchors resolve by selector. Text anchors resolve by quote — exact,
 * then normalized, then position-verified — because text survives markup
 * rewrites that invalidate every selector.
 */
export function resolveAnchor(root: Element, input: ResolveInput): ResolutionResult {
  const { anchor, quote, prefix = '', suffix = '' } = input;

  if (anchor.target === 'element') {
    const el =
      querySafe(root, anchor.cssSelector) ??
      (anchor.fallbackSelectors ?? []).reduce<Element | null>(
        (found, selector) => found ?? querySafe(root, selector),
        null,
      );
    if (!el) return STALE;
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(el);
    const exact = querySafe(root, anchor.cssSelector) === el;
    return {
      range,
      element: el,
      status: exact ? 'exact' : 'remapped',
      confidence: exact ? 1 : 0.7,
    };
  }

  const text = documentText(root);

  // 1. The recorded position still holds the recorded text — nothing moved.
  if (quote && anchor.textPosition) {
    const { start, end } = anchor.textPosition;
    const candidate = rangeFromTextOffsets(root, start, end);
    if (candidate && candidate.toString() === quote) {
      return { range: candidate, element: null, status: 'exact', confidence: 1 };
    }
  }

  // 2. Exact quote search, disambiguated by context.
  if (quote && quote.length > 0) {
    const matches = allIndexesOf(text, quote);
    if (matches.length > 0) {
      const { index, ambiguous } = disambiguate(text, matches, quote.length, prefix, suffix);
      const byteStart = byteLength(text.slice(0, index));
      const range = rangeFromTextOffsets(root, byteStart, byteStart + byteLength(quote));
      if (range) {
        return {
          range,
          element: null,
          status: ambiguous ? 'ambiguous' : 'remapped',
          confidence: ambiguous ? 0.4 : matches.length === 1 ? 0.9 : 0.75,
        };
      }
    }
  }

  // 3. Normalized quote — tolerates whitespace and smart-punctuation edits.
  if (quote) {
    const normalizedQuote = normalizeText(quote);
    const { normalized: normalizedText, starts, ends } = normalizeTextWithMap(text);
    if (normalizedQuote.length > 0) {
      const matches = allIndexesOf(normalizedText, normalizedQuote);
      if (matches.length === 1) {
        // Map the normalized match back to raw coordinates via the index maps —
        // a raw-text probe would fail exactly when the cosmetic edit this tier
        // exists for falls inside the probe, and applying the normalized
        // length to raw text would mis-size the range across every collapsed
        // whitespace run.
        const at = matches[0];
        const rawStart = starts[at];
        const rawEnd = ends[at + normalizedQuote.length - 1];
        if (rawStart !== undefined && rawEnd !== undefined) {
          const byteStart = byteLength(text.slice(0, rawStart));
          const byteEnd = byteLength(text.slice(0, rawEnd));
          const range = rangeFromTextOffsets(root, byteStart, byteEnd);
          if (range) {
            return { range, element: null, status: 'remapped', confidence: 0.6 };
          }
        }
      }
    }
  }

  // 4. Selector fallback — the text is gone but its container may remain.
  const container =
    querySafe(root, anchor.cssSelector) ??
    (anchor.fallbackSelectors ?? []).reduce<Element | null>(
      (found, selector) => found ?? querySafe(root, selector),
      null,
    );
  if (container) {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(container);
    return { range, element: container, status: 'remapped', confidence: 0.35 };
  }

  return STALE;
}
