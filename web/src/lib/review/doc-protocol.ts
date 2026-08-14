/**
 * The shell ⇄ document-frame message protocol for HTML annotation.
 *
 * The document frame is an opaque-origin sandbox (`allow-scripts` without
 * `allow-same-origin`), so `event.origin` is the string `"null"` and origin
 * checking is meaningless. The channel is instead established by a `hello`
 * handshake bound on `event.source`, after which all traffic moves onto a
 * private `MessagePort` that no other content can observe or forge.
 *
 * **The document frame is untrusted.** It may *propose* anchors and *report*
 * geometry; it may never create, mutate, or resolve review state. Every inbound
 * payload is validated by {@link parseDocMessage} before the shell looks at it.
 *
 * @see planning/collab/html-annotation.md §1, §3, §5
 * @see planning/collab/amendments.md decisions #19, #20
 */

import type { HtmlAnchor, HtmlAnchorContext, HtmlAnchorTarget } from '../types';

/** Protocol version. Both sides ignore unknown `type`s so this can extend. */
export const DOC_PROTOCOL_VERSION = 1;

/** Sent on `window.parent` before the port exists. */
export const DOC_HELLO = 'attn:doc:hello';
/** Sent on the frame's window, transferring the port. */
export const SHELL_INIT = 'attn:shell:init';

/** A rectangle in the *document frame's* viewport coordinates. */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Visual state of a rendered anchor. */
export type AnchorRenderState = 'default' | 'active' | 'resolved';

/** How an anchor resolved against the current DOM. Mirrors `ResolvedAnchor`. */
export type DocResolutionStatus = 'exact' | 'remapped' | 'ambiguous' | 'stale';

/** An anchor the frame proposes for a not-yet-created comment. */
export interface AnchorProposal {
  html: HtmlAnchor;
  /** Exact selected text, for the composer's quote preview. */
  quote: string;
  /** Text immediately before/after the selection, for disambiguation. */
  prefix: string;
  suffix: string;
  /** UTF-8 byte offsets into the document's canonical rendered text. */
  textStart: number;
  textEnd: number;
}

/** One scope the user could anchor to, innermost first. */
export interface ScopeCandidate {
  /** Stable within this frame session; identifies the element to pick. */
  scopeId: string;
  /** e.g. `row 3`, `cell`, `code block`. */
  title: string;
  /** Longer human preview, e.g. `row 3 · Fuzzy quote · edit-distance match`. */
  preview: string | null;
  selector: string;
  /** How many committed comments already target this element. */
  commentCount: number;
  rects: DocRect[];
}

export interface AnchorGeometry {
  anchorId: string;
  rects: DocRect[];
}

export interface AnchorResolution extends AnchorGeometry {
  status: DocResolutionStatus;
  confidence?: number;
}

/** An anchor the shell wants painted in the document. */
export interface RenderableAnchor {
  anchorId: string;
  html: HtmlAnchor;
  state: AnchorRenderState;
  /**
   * Original selected text. Text-range anchors re-anchor primarily by quote,
   * so the frame needs it; element anchors resolve by selector and may omit it.
   */
  quote?: string;
  /** Context that disambiguates a quote occurring more than once. */
  prefix?: string;
  suffix?: string;
  /** Shown in the element overlay's count chip. */
  label?: string;
}

/** Document → shell. */
export type DocMessage =
  | { type: 'ready'; v: number; textLength: number; title: string }
  | {
      type: 'selection';
      v: number;
      proposal: AnchorProposal;
      rects: DocRect[];
      caret: DocRect;
      explicit: boolean;
    }
  | { type: 'selectionCleared'; v: number }
  | { type: 'scopeHover'; v: number; chain: ScopeCandidate[] }
  | {
      type: 'scopePicked';
      v: number;
      proposal: AnchorProposal;
      rects: DocRect[];
      explicit: boolean;
    }
  | { type: 'anchorsResolved'; v: number; results: AnchorResolution[] }
  | { type: 'geometry'; v: number; results: AnchorGeometry[]; scrollTop: number }
  | { type: 'anchorActivated'; v: number; anchorId: string };

/** Shell → document. */
export type ShellMessage =
  | { type: 'renderAnchors'; v: number; anchors: RenderableAnchor[] }
  | { type: 'setAnchorState'; v: number; anchorId: string; state: AnchorRenderState }
  | { type: 'focusAnchor'; v: number; anchorId: string; scrollIntoView: boolean }
  | { type: 'pickScope'; v: number; scopeId: string }
  | { type: 'dismissSelection'; v: number }
  /**
   * Whether clicking a document element commits to commenting on it.
   *
   * Hover chrome (outline + label chip) is always available so the annotation
   * model is visible, but swallowing every click is only correct once the
   * document is genuinely under review: an unshared page is still a page, and
   * its links and buttons have to keep working.
   */
  | { type: 'inspect'; v: number; enabled: boolean }
  | { type: 'theme'; v: number; mode: 'paper' | 'ink' };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Bounds mirroring the Rust `HtmlAnchor` validator (src/review/model.rs). The
 * shell rejects rather than truncates so a hostile frame cannot smuggle an
 * oversized payload past the daemon's own check and get a confusing error
 * deeper in the pipeline.
 */
const MAX_SELECTOR_BYTES = 1024;
const MAX_FALLBACK_SELECTORS = 8;
const MAX_SCOPE_PREVIEW_BYTES = 256;
const MAX_DOM_PATH_SEGMENTS = 32;
const MAX_DOM_PATH_SEGMENT_BYTES = 64;
const MAX_TAG_NAME_BYTES = 64;
const MAX_ROLE_BYTES = 64;
/** Quote/prefix/suffix are shown in the composer; keep them display-sized. */
const MAX_QUOTE_BYTES = 4096;
const MAX_CONTEXT_BYTES = 512;
/** A pathological frame could otherwise stream unbounded rects every frame. */
const MAX_RECTS = 256;
const MAX_SCOPE_CHAIN = 16;
const MAX_RESULTS = 512;

const utf8 = new TextEncoder();

function withinBytes(value: unknown, max: number): value is string {
  return typeof value === 'string' && utf8.encode(value).length <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRect(value: unknown): DocRect | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y)) return null;
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height)) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function parseRects(value: unknown): DocRect[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECTS) return null;
  const out: DocRect[] = [];
  for (const entry of value) {
    const rect = parseRect(entry);
    if (!rect) return null;
    out.push(rect);
  }
  return out;
}

function parseAnchorContext(value: unknown): HtmlAnchorContext | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;
  if (!withinBytes(c.tagName, MAX_TAG_NAME_BYTES) || c.tagName.length === 0) return null;
  if (!withinBytes(c.scopePreview, MAX_SCOPE_PREVIEW_BYTES)) return null;
  const context: HtmlAnchorContext = {
    tagName: c.tagName,
    scopePreview: c.scopePreview,
  };
  if (c.role !== undefined) {
    if (!withinBytes(c.role, MAX_ROLE_BYTES)) return null;
    context.role = c.role;
  }
  if (c.domPath !== undefined) {
    if (!Array.isArray(c.domPath) || c.domPath.length > MAX_DOM_PATH_SEGMENTS) return null;
    for (const segment of c.domPath) {
      if (!withinBytes(segment, MAX_DOM_PATH_SEGMENT_BYTES)) return null;
    }
    context.domPath = c.domPath as string[];
  }
  return context;
}

function parseHtmlAnchor(value: unknown): HtmlAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (a.v !== 1) return null;
  if (a.target !== 'text_range' && a.target !== 'element') return null;
  if (!withinBytes(a.cssSelector, MAX_SELECTOR_BYTES) || a.cssSelector.trim() === '') return null;
  const context = parseAnchorContext(a.context);
  if (!context) return null;

  const anchor: HtmlAnchor = {
    v: 1,
    target: a.target as HtmlAnchorTarget,
    cssSelector: a.cssSelector,
    context,
  };

  if (a.fallbackSelectors !== undefined) {
    if (!Array.isArray(a.fallbackSelectors) || a.fallbackSelectors.length > MAX_FALLBACK_SELECTORS) {
      return null;
    }
    for (const selector of a.fallbackSelectors) {
      if (!withinBytes(selector, MAX_SELECTOR_BYTES)) return null;
    }
    anchor.fallbackSelectors = a.fallbackSelectors as string[];
  }

  if (a.textPosition !== undefined) {
    const p = a.textPosition as Record<string, unknown>;
    if (typeof p !== 'object' || p === null) return null;
    if (!isFiniteNumber(p.start) || !isFiniteNumber(p.end) || p.end < p.start) return null;
    anchor.textPosition = { start: p.start, end: p.end };
  }

  if (a.range !== undefined) {
    const r = a.range as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) return null;
    if (!withinBytes(r.startSelector, MAX_SELECTOR_BYTES)) return null;
    if (!withinBytes(r.endSelector, MAX_SELECTOR_BYTES)) return null;
    if (!isFiniteNumber(r.startOffset) || !isFiniteNumber(r.endOffset)) return null;
    anchor.range = {
      startSelector: r.startSelector,
      startOffset: r.startOffset,
      endSelector: r.endSelector,
      endOffset: r.endOffset,
    };
  }

  return anchor;
}

function parseProposal(value: unknown): AnchorProposal | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const html = parseHtmlAnchor(p.html);
  if (!html) return null;
  if (!withinBytes(p.quote, MAX_QUOTE_BYTES)) return null;
  if (!withinBytes(p.prefix, MAX_CONTEXT_BYTES)) return null;
  if (!withinBytes(p.suffix, MAX_CONTEXT_BYTES)) return null;
  if (!isFiniteNumber(p.textStart) || !isFiniteNumber(p.textEnd)) return null;
  if (p.textEnd < p.textStart) return null;
  return {
    html,
    quote: p.quote,
    prefix: p.prefix,
    suffix: p.suffix,
    textStart: p.textStart,
    textEnd: p.textEnd,
  };
}

function parseScopeCandidate(value: unknown): ScopeCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (!withinBytes(s.scopeId, MAX_SELECTOR_BYTES)) return null;
  if (!withinBytes(s.title, MAX_SCOPE_PREVIEW_BYTES)) return null;
  if (!withinBytes(s.selector, MAX_SELECTOR_BYTES)) return null;
  if (s.preview !== null && !withinBytes(s.preview, MAX_SCOPE_PREVIEW_BYTES)) return null;
  if (!isFiniteNumber(s.commentCount) || s.commentCount < 0) return null;
  const rects = parseRects(s.rects);
  if (!rects) return null;
  return {
    scopeId: s.scopeId,
    title: s.title,
    preview: s.preview === null ? null : (s.preview as string),
    selector: s.selector,
    commentCount: s.commentCount,
    rects,
  };
}

const RESOLUTION_STATUSES: readonly DocResolutionStatus[] = [
  'exact',
  'remapped',
  'ambiguous',
  'stale',
];

/**
 * Validate one inbound message from the document frame.
 *
 * Returns `null` for anything malformed, oversized, or of unknown `type` —
 * callers drop those silently, which is also how forward-compatibility works.
 */
export function parseDocMessage(raw: unknown): DocMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== DOC_PROTOCOL_VERSION) return null;

  switch (m.type) {
    case 'ready': {
      if (!isFiniteNumber(m.textLength)) return null;
      if (!withinBytes(m.title, MAX_CONTEXT_BYTES)) return null;
      return { type: 'ready', v: DOC_PROTOCOL_VERSION, textLength: m.textLength, title: m.title };
    }
    case 'selection': {
      const proposal = parseProposal(m.proposal);
      const rects = parseRects(m.rects);
      const caret = parseRect(m.caret);
      if (!proposal || !rects || !caret) return null;
      return {
        type: 'selection',
        v: DOC_PROTOCOL_VERSION,
        proposal,
        rects,
        caret,
        explicit: m.explicit === true,
      };
    }
    case 'selectionCleared':
      return { type: 'selectionCleared', v: DOC_PROTOCOL_VERSION };
    case 'scopeHover': {
      if (!Array.isArray(m.chain) || m.chain.length > MAX_SCOPE_CHAIN) return null;
      const chain: ScopeCandidate[] = [];
      for (const entry of m.chain) {
        const candidate = parseScopeCandidate(entry);
        if (!candidate) return null;
        chain.push(candidate);
      }
      return { type: 'scopeHover', v: DOC_PROTOCOL_VERSION, chain };
    }
    case 'scopePicked': {
      const proposal = parseProposal(m.proposal);
      const rects = parseRects(m.rects);
      if (!proposal || !rects) return null;
      return {
        type: 'scopePicked',
        v: DOC_PROTOCOL_VERSION,
        proposal,
        rects,
        explicit: m.explicit === true,
      };
    }
    case 'anchorsResolved': {
      if (!Array.isArray(m.results) || m.results.length > MAX_RESULTS) return null;
      const results: AnchorResolution[] = [];
      for (const entry of m.results) {
        if (typeof entry !== 'object' || entry === null) return null;
        const r = entry as Record<string, unknown>;
        if (!withinBytes(r.anchorId, MAX_SELECTOR_BYTES)) return null;
        if (!RESOLUTION_STATUSES.includes(r.status as DocResolutionStatus)) return null;
        const rects = parseRects(r.rects);
        if (!rects) return null;
        const resolution: AnchorResolution = {
          anchorId: r.anchorId,
          status: r.status as DocResolutionStatus,
          rects,
        };
        if (r.confidence !== undefined) {
          if (!isFiniteNumber(r.confidence) || r.confidence < 0 || r.confidence > 1) return null;
          resolution.confidence = r.confidence;
        }
        results.push(resolution);
      }
      return { type: 'anchorsResolved', v: DOC_PROTOCOL_VERSION, results };
    }
    case 'geometry': {
      if (!Array.isArray(m.results) || m.results.length > MAX_RESULTS) return null;
      if (!isFiniteNumber(m.scrollTop)) return null;
      const results: AnchorGeometry[] = [];
      for (const entry of m.results) {
        if (typeof entry !== 'object' || entry === null) return null;
        const r = entry as Record<string, unknown>;
        if (!withinBytes(r.anchorId, MAX_SELECTOR_BYTES)) return null;
        const rects = parseRects(r.rects);
        if (!rects) return null;
        results.push({ anchorId: r.anchorId, rects });
      }
      return { type: 'geometry', v: DOC_PROTOCOL_VERSION, results, scrollTop: m.scrollTop };
    }
    case 'anchorActivated': {
      if (!withinBytes(m.anchorId, MAX_SELECTOR_BYTES)) return null;
      return { type: 'anchorActivated', v: DOC_PROTOCOL_VERSION, anchorId: m.anchorId };
    }
    default:
      return null;
  }
}
