// Renders the sanitised form of an `embedded_svg` node (attn-vlmz.4.2).
//
// The security-critical property lives here, not in the sanitiser: this module
// builds the picture with `createElementNS` / `setAttribute` / `createTextNode`
// from the sanitiser's data tree. `innerHTML` is never used on this path, so no
// sanitised output is ever handed back to a parser and mutation-XSS is
// structurally impossible. It also means the worst a tokenizer bug can do is
// draw the wrong picture: the builder below can only construct element names
// and attributes that already passed the allowlist.
//
// Threat model: planning/embedded-svg-threat-model.md.

import {
  SVG_NS,
  XLINK_NS,
  isAllowedAttribute,
  isAllowedElement,
  removalCount,
  sanitizeSvg,
  type SanitizedElement,
  type SanitizedNode,
} from './svg-sanitizer';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Class on the block container; also the hook for the sizing rules below. */
export const EMBEDDED_SVG_CLASS = 'embedded-svg';

// -- DOM construction -------------------------------------------------------

function buildNode(node: SanitizedNode): Node {
  if (node.kind === 'text') return document.createTextNode(node.text);

  const el = document.createElementNS(SVG_NS, node.tag);
  for (const { name, value } of node.attrs) {
    if (name === 'href' || name === 'xlink:href') {
      // Mirror into both forms: SVG 2 reads `href`, older engines read the
      // xlink-namespaced one. The value is already constrained to `#fragment`.
      el.setAttribute('href', value);
      el.setAttributeNS(XLINK_NS, 'xlink:href', value);
    } else if (name === 'xml:space') {
      el.setAttributeNS(XML_NS, 'xml:space', value);
    } else {
      el.setAttribute(name, value);
    }
  }
  for (const child of node.children) el.appendChild(buildNode(child));
  return el;
}

/**
 * Second, independent gate: re-check the DOM we actually built against the same
 * allowlist tables, walking real nodes rather than the sanitiser's tree.
 *
 * This is not belt-and-braces theatre. The bespoke part of this feature is the
 * tokenizer; the allowlists are a declarative table. Auditing the finished DOM
 * means a tokenizer or tree-builder defect is not on its own enough to land a
 * payload — the parser and this check would both have to be wrong in the same
 * direction. It also catches the namespace class directly: anything that is not
 * in the SVG namespace fails here regardless of how it got created.
 *
 * Returns a description of the first violation, or null when the tree is clean.
 */
function auditConstructedSvg(root: Element): string | null {
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    if (el.namespaceURI !== SVG_NS) {
      return `<${el.nodeName}> is not in the SVG namespace`;
    }
    if (!isAllowedElement(el.localName)) {
      return `<${el.localName}> is not allowlisted`;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.prefix ? `${attr.prefix}:${attr.localName}` : attr.localName;
      if (/^on/i.test(name)) return `event handler '${name}' reached the DOM`;
      if (!isAllowedAttribute(el.localName, name)) {
        return `attribute '${name}' on <${el.localName}> is not allowlisted`;
      }
      const flattened = attr.value.replace(/[\s\u0000-\u001F\u007F-\u009F]/g, '').toLowerCase();
      if (/(javascript|vbscript|livescript|mocha|data):/.test(flattened)) {
        return `dangerous URL scheme in '${name}'`;
      }
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return null;
}

/** Absolute CSS lengths only — a percentage carries no intrinsic size. */
function parseAbsoluteLength(raw: string | null): number | null {
  if (!raw) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(raw);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Make the SVG obey the reading column.
 *
 * An author's `width`/`height` becomes a `viewBox` (so the intrinsic aspect
 * ratio survives) and is then removed, handing the box to CSS — the same trick
 * `mermaid-nodeview.ts` uses via `ensureViewBox`. Without this, an SVG declaring
 * `width="4000"` gets clamped by `max-width` while its height does not, and the
 * picture distorts.
 *
 * The original absolute width, when there was one, becomes a `max-width` so a
 * 24px glyph is not upscaled to the full 960px column. An SVG that declared no
 * absolute size (the responsive `viewBox` + `preserveAspectRatio` form, which is
 * what the bug reporter's file used) fills the column, which is what it asked
 * for.
 */
function normalizeRootSizing(svg: SVGElement): void {
  const width = parseAbsoluteLength(svg.getAttribute('width'));
  const height = parseAbsoluteLength(svg.getAttribute('height'));
  if (!svg.hasAttribute('viewBox') && width !== null && height !== null) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  if (width !== null) svg.style.maxWidth = `${width}px`;
}

// -- Chrome -----------------------------------------------------------------

function removalNote(elements: string[], attributes: string[]): HTMLElement {
  const note = document.createElement('div');
  note.className = 'embedded-svg-note';
  const parts: string[] = [];
  if (elements.length > 0) parts.push(`${elements.join(', ')}`);
  if (attributes.length > 0) parts.push(`${attributes.join(', ')}`);
  // textContent, never innerHTML — these strings come from the document.
  note.textContent = `Sanitiser removed: ${parts.join(' · ')}`;
  note.title =
    'attn strips scripts, event handlers, external references and stylesheets ' +
    'from embedded SVG. The file on disk is unchanged.';
  return note;
}

function fallback(source: string, reason: string): HTMLElement {
  const details = document.createElement('details');
  details.className = 'embedded-svg-fallback';

  const summary = document.createElement('summary');
  summary.textContent = `SVG not rendered — ${reason}`;
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.textContent = source;
  details.appendChild(pre);

  return details;
}

// -- Entry point ------------------------------------------------------------

/**
 * Build the rendered block for one `embedded_svg` node. Always returns an
 * element: on rejection the raw source is shown as text in a collapsed
 * `<details>`, so the reader loses the picture but never the content.
 */
export function renderEmbeddedSvg(source: string): HTMLElement {

  const container = document.createElement('div');
  container.className = EMBEDDED_SVG_CLASS;
  container.contentEditable = 'false';
  // The node is an atom; nothing inside it is editable content.
  container.setAttribute('data-embedded-svg', source);

  const result = sanitizeSvg(source);
  if (!result.ok) {
    container.appendChild(fallback(source, result.reason));
    return container;
  }

  const svg = buildNode(result.root as SanitizedElement) as SVGElement;

  // Fail closed if the constructed DOM disagrees with the allowlist: show the
  // source instead of a picture we cannot vouch for.
  const violation = auditConstructedSvg(svg);
  if (violation !== null) {
    container.appendChild(fallback(source, `failed the post-build audit — ${violation}`));
    return container;
  }

  normalizeRootSizing(svg);
  container.appendChild(svg);

  // A reviewer approving a document should be able to see that what they are
  // looking at is not all of what the author sent. Silent stripping would let
  // an attacker hide content from the human while it stays in the file.
  if (removalCount(result.removed) > 0) {
    container.appendChild(removalNote(result.removed.elements, result.removed.attributes));
  }

  return container;
}

// -- Styles -----------------------------------------------------------------
//
// TEMPORARY HOME. These belong in `web/styles/prosemirror.css` (and
// `.embedded-svg` belongs in the hand-maintained shared-column allowlist,
// `.ProseMirror > :is(…)`), but that file is owned by another workstream right
// now. Injecting them here keeps the feature self-contained and correct;
// moving them out is a straight copy plus deleting this function.
//
// Sizes are in `em` so they track `--attn-doc-scale` — the document scale, not
// the app chrome scale. See the contract at the top of `web/styles/typeset.css`.

const STYLE_ELEMENT_ID = 'attn-embedded-svg-styles';

