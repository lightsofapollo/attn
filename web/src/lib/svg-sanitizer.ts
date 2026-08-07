// Allowlist sanitiser for embedded SVG in documents (attn-vlmz.4).
//
// Threat model and every decision below: planning/embedded-svg-threat-model.md.
// Read it before changing anything here — the allowlists are the boundary.
//
// The one property to preserve above all others: THIS MODULE NEVER RETURNS A
// STRING OF MARKUP. It returns a plain data tree, and `renderSanitizedSvg`
// (embedded-svg-nodeview.ts) turns that tree into real nodes with
// `createElementNS` / `setAttribute`. No sanitised output is ever re-parsed, so
// mutation-XSS — a payload that survives sanitisation and then re-parses into
// something else — is structurally impossible rather than merely defended
// against. It also means a tokenizer bug cannot escalate into script execution:
// the builder can only construct names that appear in the allowlists below.
//
// Inputs are untrusted. Documents are written by agents (which read
// prompt-injectable material) and arrive from peers over shares (E2EE
// authenticates the channel, not the content). In the hosted build the app
// origin holds room secrets; in the native build the webview holds the
// `window.__attn__` IPC bridge and has NO CSP. Fail closed.

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

// -- Result types -----------------------------------------------------------

export interface SanitizedAttribute {
  name: string;
  value: string;
}

export interface SanitizedElement {
  kind: 'element';
  tag: string;
  attrs: SanitizedAttribute[];
  children: SanitizedNode[];
}

export interface SanitizedText {
  kind: 'text';
  text: string;
}

export type SanitizedNode = SanitizedElement | SanitizedText;

export interface SanitizeReport {
  /** Element names dropped with their subtrees, in encounter order. */
  elements: string[];
  /** Attribute names dropped, in encounter order. */
  attributes: string[];
}

export type SanitizeResult =
  | { ok: true; root: SanitizedElement; removed: SanitizeReport }
  | { ok: false; reason: string };

export interface SanitizeOptions {
  /**
   * Prefix stamped onto every `id` and every internal `#`/`url(#…)` reference.
   * Blocks DOM clobbering against app element ids, and fixes the rendering bug
   * where two SVGs in one document that both define `id="gradient"` paint each
   * other's fills. Defaults to a per-call unique token.
   */
  idPrefix?: string;
}

// -- Allowlists -------------------------------------------------------------
//
// Matching is exact and CASE-SENSITIVE. SVG is XML, so `clipPath` is a
// different name from `clippath`, and nothing here is lowercased. That is why
// `<SCRIPT>`, `<ScRiPt>` and `onLoad` need no special rule: they simply are not
// in these sets, and there is no case-folding logic to get wrong.

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
  'marker',
]);

// Deliberately absent, each for a reason recorded in §3.1 of the decision doc:
// script (execution), foreignObject (re-enters HTML parsing), style (inline SVG
// <style> is NOT scoped to the SVG — it restyles the whole app), a and image
// (fragment-only URLs leave them nothing to do), all SMIL (can animate an
// attribute into a javascript: URL, defeating static value checks), filter and
// every fe* primitive (surface + pixel-stealing side channels), switch (what a
// reviewer sees would depend on their locale), metadata (arbitrary foreign XML).

/** Elements whose character data is meaningful. Text elsewhere is dropped. */
const TEXT_CONTENT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

const ALLOWED_ATTRIBUTES = new Set([
  // Structural / geometry
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'd', 'points', 'dx', 'dy', 'rotate', 'transform',
  'viewBox', 'preserveAspectRatio', 'offset',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'pathLength', 'textLength', 'lengthAdjust', 'xml:space',

  // Presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'stroke-miterlimit', 'opacity', 'color', 'display',
  'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask',
  'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity',
  'paint-order', 'vector-effect', 'shape-rendering', 'text-rendering',
  'mix-blend-mode', 'isolation',

  // Text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'letter-spacing', 'word-spacing', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'text-decoration', 'white-space', 'writing-mode', 'direction',
  'unicode-bidi',
]);

// `id` and `style` are handled by dedicated rules, not by the set above.
// `class` is refused outright: it would let a document borrow app CSS classes
// and paint convincing fake chrome. `xmlns*` is refused because we choose the
// namespace ourselves at construction time — a document-supplied one could only
// be an attempt to change that. `role`/`aria-*` are refused so a document
// cannot lie to a screen reader about app chrome.

/** `href` / `xlink:href` are allowed only here, and only as `#fragment`. */
const HREF_ELEMENTS = new Set(['use']);

const ALLOWED_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'stroke-miterlimit', 'opacity', 'color', 'display',
  'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask',
  'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity',
  'paint-order', 'vector-effect', 'shape-rendering', 'text-rendering',
  'mix-blend-mode', 'isolation',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'letter-spacing', 'word-spacing', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'text-decoration', 'white-space', 'writing-mode', 'direction',
  'unicode-bidi',
  'transform', 'transform-origin', 'cursor',
]);

/** The only CSS functions a value may name. `var()` is refused — it would
 *  resolve against app-controlled custom properties. */
const ALLOWED_CSS_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'url']);

/**
 * Named, directly-tested backstop. Strictly redundant given the `#fragment`
 * href pattern and the `url(#id)` rule, and kept precisely so the tests can
 * name these payloads and assert on them.
 */
const DANGEROUS_SUBSTRINGS = [
  'javascript:', 'vbscript:', 'livescript:', 'mocha:', 'data:',
  'expression(', '-moz-binding', 'behavior:', '@import',
];

// -- Structural caps --------------------------------------------------------
//
// Far above any legitimate diagram; they bound tokenizer work and stop a
// document from shipping an SVG bomb.

const MAX_SOURCE_LENGTH = 512 * 1024;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 5000;

// -- Character classes ------------------------------------------------------

/** C0/C1 controls, minus tab/LF/CR which are legal (and common) in SVG. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;
const ID_VALUE = /^[A-Za-z0-9_.\-:]+$/;
const FRAGMENT_REF = /^#([A-Za-z0-9_.\-:]+)$/;
const URL_FRAGMENT = /^url\(\s*['"]?#([A-Za-z0-9_.\-:]+)['"]?\s*\)$/;
const CSS_VALUE_CHARS = /^[A-Za-z0-9 \t\n\r#%.,()\-+_/'"]*$/;

let idPrefixCounter = 0;

/** Thrown to abort the whole block. Never escapes `sanitizeSvg`. */
class RejectedError extends Error {}

// -- Entry point ------------------------------------------------------------

export function sanitizeSvg(source: string, options: SanitizeOptions = {}): SanitizeResult {
  if (source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `source exceeds ${MAX_SOURCE_LENGTH} bytes` };
  }
  const idPrefix = options.idPrefix ?? `attn-svg-${++idPrefixCounter}-`;
  const removed: SanitizeReport = { elements: [], attributes: [] };
  const ctx: Ctx = { src: source, pos: 0, elementCount: 0, idPrefix, removed };

  try {
    skipWhitespace(ctx);
    if (ctx.src.startsWith('<svg', ctx.pos) === false) {
      reject('block does not start with <svg');
    }
    const root = parseElement(ctx, 0);
    skipWhitespace(ctx);
    if (ctx.pos !== ctx.src.length) reject('trailing content after </svg>');
    // The root element itself must survive; an `<svg>` whose tag was somehow
    // filtered has nothing to render.
    if (root === null || root.tag !== 'svg') reject('root element is not <svg>');
    return { ok: true, root, removed };
  } catch (err) {
    if (err instanceof RejectedError) return { ok: false, reason: err.message };
    throw err;
  }
}

// -- Tokenizer --------------------------------------------------------------

interface Ctx {
  src: string;
  pos: number;
  elementCount: number;
  idPrefix: string;
  removed: SanitizeReport;
}

function reject(message: string): never {
  throw new RejectedError(message);
}

function skipWhitespace(ctx: Ctx): void {
  while (ctx.pos < ctx.src.length && /\s/.test(ctx.src[ctx.pos])) ctx.pos += 1;
}

function readName(ctx: Ctx): string {
  const start = ctx.pos;
  if (ctx.pos >= ctx.src.length || !NAME_START.test(ctx.src[ctx.pos])) {
    reject(`expected a name at offset ${ctx.pos}`);
  }
  ctx.pos += 1;
  while (ctx.pos < ctx.src.length && NAME_CHAR.test(ctx.src[ctx.pos])) ctx.pos += 1;
  return ctx.src.slice(start, ctx.pos);
}

/**
 * Parse the element beginning at `<`. Returns null when the element is not in
 * the allowlist — its subtree is still consumed (so the scanner stays in sync)
 * and then discarded wholesale. Dropping the subtree, rather than unwrapping
 * it, is what makes `<foreignObject><img onerror>` safe.
 */
function parseElement(ctx: Ctx, depth: number): SanitizedElement | null {
  if (depth > MAX_DEPTH) reject(`nesting deeper than ${MAX_DEPTH}`);
  if (++ctx.elementCount > MAX_ELEMENTS) reject(`more than ${MAX_ELEMENTS} elements`);

  if (ctx.src[ctx.pos] !== '<') reject(`expected '<' at offset ${ctx.pos}`);
  ctx.pos += 1;
  const tag = readName(ctx);
  const keep = ALLOWED_ELEMENTS.has(tag);
  if (!keep && !ctx.removed.elements.includes(tag)) ctx.removed.elements.push(tag);

  const attrs: SanitizedAttribute[] = [];
  let selfClosing = false;

  for (;;) {
    const hadSpace = /\s/.test(ctx.src[ctx.pos] ?? '');
    skipWhitespace(ctx);
    if (ctx.pos >= ctx.src.length) reject('unterminated start tag');
    const ch = ctx.src[ctx.pos];
    if (ch === '>') {
      ctx.pos += 1;
      break;
    }
    if (ch === '/') {
      ctx.pos += 1;
      if (ctx.src[ctx.pos] !== '>') reject("expected '>' after '/'");
      ctx.pos += 1;
      selfClosing = true;
      break;
    }
    // Attributes must be separated by whitespace; `a="1"b="2"` is malformed.
    if (!hadSpace) reject(`expected whitespace before attribute at offset ${ctx.pos}`);

    const rawName = readName(ctx);
    skipWhitespace(ctx);
    if (ctx.src[ctx.pos] !== '=') {
      // Valueless attributes are not well-formed XML, and SVG is XML. Fail
      // closed rather than guess at an intended value.
      reject(`attribute '${rawName}' has no value`);
    }
    ctx.pos += 1;
    skipWhitespace(ctx);
    const quote = ctx.src[ctx.pos];
    if (quote !== '"' && quote !== "'") {
      reject(`attribute '${rawName}' has an unquoted value`);
    }
    ctx.pos += 1;
    const valueStart = ctx.pos;
    const end = ctx.src.indexOf(quote, ctx.pos);
    if (end < 0) reject(`unterminated value for attribute '${rawName}'`);
    const rawValue = ctx.src.slice(valueStart, end);
    ctx.pos = end + 1;

    if (!keep) continue;
    const attr = sanitizeAttribute(tag, rawName, rawValue, ctx);
    if (attr) attrs.push(attr);
    else if (!ctx.removed.attributes.includes(rawName)) ctx.removed.attributes.push(rawName);
  }

  const children: SanitizedNode[] = [];
  if (!selfClosing) {
    parseChildren(ctx, tag, depth, keep, children);
  }

  if (!keep) return null;
  return { kind: 'element', tag, attrs, children };
}

function parseChildren(
  ctx: Ctx,
  tag: string,
  depth: number,
  keep: boolean,
  out: SanitizedNode[],
): void {
  const keepsText = keep && TEXT_CONTENT_ELEMENTS.has(tag);
  for (;;) {
    if (ctx.pos >= ctx.src.length) reject(`unclosed <${tag}>`);
    const next = ctx.src.indexOf('<', ctx.pos);
    if (next < 0) reject(`unclosed <${tag}>`);
    if (next > ctx.pos) {
      const raw = ctx.src.slice(ctx.pos, next);
      ctx.pos = next;
      if (keepsText) {
        const text = decodeEntities(raw);
        assertNoControlChars(text);
        if (text.length > 0) out.push({ kind: 'text', text });
      }
    }

    // `<!--` … `-->` is dropped. Every other `<!` construct (DOCTYPE, ENTITY,
    // CDATA) and every `<?` processing instruction rejects the block: that one
    // rule closes XXE, billion-laughs, and `<?xml-stylesheet href="evil"?>`.
    if (ctx.src.startsWith('<!--', ctx.pos)) {
      const close = ctx.src.indexOf('-->', ctx.pos + 4);
      if (close < 0) reject('unterminated comment');
      ctx.pos = close + 3;
      continue;
    }
    if (ctx.src.startsWith('<!', ctx.pos)) {
      reject('DTD, DOCTYPE and CDATA sections are refused');
    }
    if (ctx.src.startsWith('<?', ctx.pos)) {
      reject('processing instructions are refused');
    }
    if (ctx.src.startsWith('</', ctx.pos)) {
      ctx.pos += 2;
      const closeName = readName(ctx);
      skipWhitespace(ctx);
      if (ctx.src[ctx.pos] !== '>') reject(`unterminated close tag </${closeName}`);
      ctx.pos += 1;
      if (closeName !== tag) reject(`</${closeName}> does not close <${tag}>`);
      return;
    }

    const child = parseElement(ctx, depth + 1);
    if (child && keep) out.push(child);
  }
}

// -- Entity decoding --------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode the five XML predefined entities and numeric character references.
 *
 * Any other `&name;` rejects the block. That is not merely conservative: SVG is
 * XML, and without a DTD (which we also refuse) an undefined entity is an error
 * a browser would reject too. It also forecloses entity-obfuscated payloads
 * such as `&#106;avascript:` reaching a value check undecoded.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== '&') {
      out += ch;
      i += 1;
      continue;
    }
    const semi = input.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 32) reject('unterminated entity reference');
    const body = input.slice(i + 1, semi);
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits.length === 0 || !(hex ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/).test(digits)) {
        reject(`malformed numeric entity '&${body};'`);
      }
      const code = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        reject(`numeric entity out of range '&${body};'`);
      }
      out += String.fromCodePoint(code);
    } else {
      const mapped = XML_ENTITIES[body];
      if (mapped === undefined) reject(`unknown entity reference '&${body};'`);
      out += mapped;
    }
    i = semi + 1;
  }
  return out;
}

function assertNoControlChars(value: string): void {
  if (CONTROL_CHARS.test(value)) reject('value contains control characters');
}

// -- Attribute rules --------------------------------------------------------

function sanitizeAttribute(
  tag: string,
  rawName: string,
  rawValue: string,
  ctx: Ctx,
): SanitizedAttribute | null {
  const value = decodeEntities(rawValue);
  assertNoControlChars(value);

  // `href` / `xlink:href`: only on <use>, only a same-document fragment. This
  // single rule closes javascript:, data:text/html, data:image/svg+xml,
  // <use href="http…">, protocol-relative //evil, and every render-time beacon.
  // It runs after entity decoding and after whitespace/control stripping, so
  // `&#106;avascript:` and `java&#9;script:` are caught too.
  if (rawName === 'href' || rawName === 'xlink:href') {
    if (!HREF_ELEMENTS.has(tag)) return null;
    const match = FRAGMENT_REF.exec(value.trim());
    if (!match) return null;
    return { name: rawName, value: `#${ctx.idPrefix}${match[1]}` };
  }

  if (rawName === 'id') {
    if (!ID_VALUE.test(value)) return null;
    return { name: 'id', value: `${ctx.idPrefix}${value}` };
  }

  if (rawName === 'style') {
    const style = sanitizeStyle(value, ctx);
    return style ? { name: 'style', value: style } : null;
  }

  if (!ALLOWED_ATTRIBUTES.has(rawName)) return null;

  const checked = checkValue(value, ctx);
  return checked === null ? null : { name: rawName, value: checked };
}

/**
 * Value rules shared by every allowlisted attribute. Returns the (possibly
 * id-rewritten) value, or null to drop the attribute.
 */
function checkValue(value: string, ctx: Ctx): string | null {
  const normalized = value.replace(/[\s\u0000-\u001F\u007F-\u009F]/g, '').toLowerCase();
  for (const bad of DANGEROUS_SUBSTRINGS) {
    if (normalized.includes(bad)) return null;
  }
  if (normalized.includes('url(')) {
    const match = URL_FRAGMENT.exec(value.trim());
    if (!match) return null;
    return `url(#${ctx.idPrefix}${match[1]})`;
  }
  return value;
}

/**
 * Rebuild the style attribute from surviving declarations only — nothing from
 * the original string is passed through verbatim.
 */
function sanitizeStyle(value: string, ctx: Ctx): string | null {
  // Comments, escapes, at-rules and markup have no legitimate place in an
  // inline style attribute, and every one of them is an obfuscation primitive.
  if (/[\\<>{}]/.test(value) || value.includes('/*') || value.includes('@')) return null;

  const kept: string[] = [];
  for (const rawDecl of value.split(';')) {
    const decl = rawDecl.trim();
    if (decl.length === 0) continue;
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const rawPropValue = decl.slice(colon + 1).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(prop)) continue;
    if (rawPropValue.length === 0 || rawPropValue.includes('!')) continue;
    if (!CSS_VALUE_CHARS.test(rawPropValue)) continue;

    let fnOk = true;
    for (const m of rawPropValue.matchAll(/([A-Za-z-]+)\s*\(/g)) {
      if (!ALLOWED_CSS_FUNCTIONS.has(m[1].toLowerCase())) fnOk = false;
    }
    if (!fnOk) continue;

    const checked = checkValue(rawPropValue, ctx);
    if (checked === null) continue;
    kept.push(`${prop}: ${checked}`);
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

// -- Reporting helper -------------------------------------------------------

/** Total count of dropped element names + attribute names, for the UI chip. */
export function removalCount(report: SanitizeReport): number {
  return report.elements.length + report.attributes.length;
}

// -- Allowlist predicates ---------------------------------------------------
//
// Exported so the renderer can re-check the DOM it actually constructed
// (`auditConstructedSvg` in embedded-svg-view.ts) against the same tables,
// independently of the tokenizer and the tree builder. The allowlists are a
// declarative table that is easy to review by eye; the tokenizer is the part
// with bugs in it. Re-checking the finished DOM means a tokenizer or builder
// defect is not on its own sufficient to land a payload — two independent
// stages have to fail together.

export function isAllowedElement(tag: string): boolean {
  return ALLOWED_ELEMENTS.has(tag);
}

export function isAllowedAttribute(tag: string, name: string): boolean {
  if (name === 'id' || name === 'style') return true;
  if (name === 'href' || name === 'xlink:href') return HREF_ELEMENTS.has(tag);
  return ALLOWED_ATTRIBUTES.has(name);
}
