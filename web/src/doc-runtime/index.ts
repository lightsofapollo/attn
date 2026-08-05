/**
 * attn HTML annotation runtime — runs *inside* the document frame.
 *
 * The frame is an opaque-origin sandbox, so the shell cannot touch its DOM.
 * Everything that needs a DOM — selection, geometry, highlight painting,
 * selector resolution — happens here, and results travel to the shell over a
 * private `MessagePort`.
 *
 * This code shares a JavaScript context with the document's own scripts, which
 * are untrusted. It is therefore written to be *unprivileged*: it proposes
 * anchors and reports geometry, and holds no review state worth stealing. The
 * shell treats everything it sends as untrusted input.
 *
 * @see planning/collab/html-annotation.md §1, §3, §5
 */

import type {
  AnchorGeometry,
  AnchorProposal,
  AnchorRenderState,
  AnchorResolution,
  DocMessage,
  DocRect,
  RenderableAnchor,
  ScopeCandidate,
  ShellMessage,
} from '../lib/review/doc-protocol';
import {
  DOC_HELLO,
  DOC_PROTOCOL_VERSION,
  SHELL_INIT,
} from '../lib/review/doc-protocol';
import {
  anchorForElement,
  anchorForRange,
  documentText,
  resolveAnchor,
  textOffsetOf,
} from './selectors';
import { RUNTIME_STYLES } from './styles';

const HIGHLIGHT_BUCKET = 'attn-text';
const HIGHLIGHT_ACTIVE_BUCKET = 'attn-text-active';
/** Context captured either side of a selection, for later disambiguation. */
const CONTEXT_CHARS = 64;

interface LiveAnchor {
  spec: RenderableAnchor;
  range: Range | null;
  element: Element | null;
  status: AnchorResolution['status'];
  confidence: number;
  overlay: HTMLElement | null;
  pin: HTMLElement | null;
}

let port: MessagePort | null = null;
let root: HTMLElement;
let layer: HTMLElement;
let gutterPin: HTMLButtonElement;
let flyout: HTMLElement;
let selectionPill: HTMLButtonElement;

const anchors = new Map<string, LiveAnchor>();
/** Scope candidates offered in the current hover, keyed by their scopeId. */
const scopeElements = new Map<string, Element>();
let hoverChain: Element[] = [];
let pendingRange: Range | null = null;
let scopeSeq = 0;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function send(message: DocMessage): void {
  port?.postMessage(message);
}

function toDocRect(rect: DOMRect): DocRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Merge the many client rects of a multi-line range into per-line bands. */
function rectsOf(target: Range | Element | null): DocRect[] {
  if (!target) return [];
  const list = Array.from(target.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  return list.slice(0, 128).map(toDocRect);
}

// ---------------------------------------------------------------------------
// Scope chain (validated by planning/collab/prototypes/html-annotation.html)
// ---------------------------------------------------------------------------

/** Structural scopes a comment may anchor to, finest to coarsest. */
const SCOPE_TAGS = new Set([
  'TD', 'TH', 'TR', 'LI', 'FIGURE', 'PRE', 'TABLE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'P', 'IMG', 'FIGCAPTION', 'UL', 'OL',
]);

const isCell = (el: Element): boolean => el.tagName === 'TD' || el.tagName === 'TH';

function candidateChain(el: Element): Element[] {
  const chain: Element[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor !== root && chain.length < 12) {
    if (SCOPE_TAGS.has(cursor.tagName)) chain.push(cursor);
    cursor = cursor.parentElement;
  }
  return chain;
}

/**
 * The gutter pin defaults to the band-level scope (row/block) rather than a
 * cell: the pin lives in the left margin, where a horizontal band reads as a
 * line comment does.
 */
function defaultTarget(chain: Element[]): Element | undefined {
  return chain.find((el) => !isCell(el)) ?? chain[0];
}

function rowIndexOf(tr: Element): number {
  const section = tr.parentElement;
  if (!section) return 1;
  return Array.from(section.children).filter((c) => c.tagName === 'TR').indexOf(tr) + 1;
}

function scopeTitle(el: Element): string {
  if (isCell(el)) return 'cell';
  if (el.tagName === 'TR') return el.closest('thead') ? 'header row' : `row ${rowIndexOf(el)}`;
  if (el.tagName === 'LI') return 'list item';
  if (el.tagName === 'PRE') return 'code block';
  if (/^H[1-6]$/.test(el.tagName)) return 'heading';
  return el.tagName.toLowerCase();
}

function scopePreview(el: Element): string | null {
  if (el.tagName === 'TR') {
    const cells = Array.from(el.querySelectorAll('th,td')).map((c) => c.textContent?.trim() ?? '');
    const label = el.closest('thead') ? 'header row' : `row ${rowIndexOf(el)}`;
    const rest = [cells[0], cells[1]].filter(Boolean).join(' · ');
    return rest ? `${label} · ${rest}` : label;
  }
  if (isCell(el)) {
    const tr = el.closest('tr');
    const column = tr ? Array.from(tr.children).indexOf(el) : -1;
    const headerRow = el.closest('table')?.querySelector('thead tr');
    const columnName = headerRow?.children[column]?.textContent?.trim();
    const value = el.textContent?.trim() ?? '';
    return columnName ? `${columnName}: ${value}` : value;
  }
  const text = el.textContent?.trim() ?? '';
  return text ? text.slice(0, 80) : null;
}

function commentsOn(el: Element): number {
  let count = 0;
  for (const anchor of anchors.values()) {
    if (anchor.element === el) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Text immediately before and after *this* range.
 *
 * Derived from the range itself rather than by searching the document for the
 * quote: a search finds the first occurrence, which is the wrong one precisely
 * when the text repeats — the case prefix/suffix exist to disambiguate.
 */
function contextAround(range: Range): { prefix: string; suffix: string } {
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);

  const after = root.ownerDocument.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);

  return {
    prefix: before.toString().slice(-CONTEXT_CHARS),
    suffix: after.toString().slice(0, CONTEXT_CHARS),
  };
}

function proposalForRange(range: Range): AnchorProposal {
  const startOffset = textOffsetOf(root, range.startContainer, range.startOffset);
  const endOffset = textOffsetOf(root, range.endContainer, range.endOffset);
  const quote = range.toString();
  const { prefix, suffix } = contextAround(range);
  return {
    html: anchorForRange(root, range),
    quote: quote.slice(0, 4000),
    prefix,
    suffix,
    textStart: startOffset,
    textEnd: endOffset,
  };
}

function proposalForElement(el: Element): AnchorProposal {
  const preview = scopePreview(el) ?? scopeTitle(el);
  const html = anchorForElement(root, el, preview);
  const quote = (el.textContent ?? '').trim().slice(0, 4000);
  return {
    html,
    quote,
    prefix: '',
    suffix: '',
    textStart: html.textPosition?.start ?? 0,
    textEnd: html.textPosition?.end ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Text selection
// ---------------------------------------------------------------------------

function selectionIsLive(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0;
}

function onSelectionChange(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    pendingRange = null;
    hideSelectionPill();
    send({ type: 'selectionCleared', v: DOC_PROTOCOL_VERSION });
    return;
  }
  const range = selection.getRangeAt(0);
  if (range.toString().trim().length === 0) return;
  pendingRange = range.cloneRange();
  const rects = rectsOf(range);
  const last = rects[rects.length - 1];
  showSelectionPill(last);
  send({
    type: 'selection',
    v: DOC_PROTOCOL_VERSION,
    proposal: proposalForRange(range),
    rects,
    caret: last ?? { x: 0, y: 0, width: 0, height: 0 },
  });
}

function showSelectionPill(near: DocRect | undefined): void {
  if (!near) return;
  selectionPill.style.left = `${near.x + near.width}px`;
  selectionPill.style.top = `${near.y + near.height + 8}px`;
  selectionPill.classList.add('is-visible');
}

function hideSelectionPill(): void {
  selectionPill.classList.remove('is-visible');
}

// ---------------------------------------------------------------------------
// Gutter pin + scope breadcrumb
// ---------------------------------------------------------------------------

function onPointerMove(event: MouseEvent): void {
  // An active text selection owns the interaction; the two gestures must never
  // compete for the same drag.
  if (selectionIsLive()) {
    hideGutterPin();
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) return;
  const chain = candidateChain(target);
  const block = defaultTarget(chain);
  if (!block) {
    hideGutterPin();
    return;
  }
  hoverChain = chain;
  positionGutterPin(block);
  publishScopeHover(chain);
}

function positionGutterPin(block: Element): void {
  const rect = block.getBoundingClientRect();
  gutterPin.style.top = `${rect.top + window.scrollY + rect.height / 2 - 12}px`;
  gutterPin.classList.add('is-visible');
  const count = commentsOn(block);
  gutterPin.dataset.count = count > 0 ? String(count) : '';
  gutterPin.classList.toggle('has-comments', count > 0);
}

function hideGutterPin(): void {
  gutterPin.classList.remove('is-visible');
  flyout.classList.remove('is-visible');
}

function publishScopeHover(chain: Element[]): void {
  scopeElements.clear();
  const candidates: ScopeCandidate[] = chain.slice(0, 8).map((el) => {
    const scopeId = `scope-${(scopeSeq += 1)}`;
    scopeElements.set(scopeId, el);
    return {
      scopeId,
      title: scopeTitle(el),
      preview: scopePreview(el),
      selector: anchorForElement(root, el, '').cssSelector,
      commentCount: commentsOn(el),
      rects: rectsOf(el),
    };
  });
  send({ type: 'scopeHover', v: DOC_PROTOCOL_VERSION, chain: candidates });
  renderFlyout(candidates);
}

function renderFlyout(candidates: ScopeCandidate[]): void {
  flyout.textContent = '';
  for (const candidate of candidates) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'attn-scope-item';
    const title = document.createElement('span');
    title.className = 'attn-scope-title';
    title.textContent = candidate.title;
    item.appendChild(title);
    if (candidate.preview) {
      const preview = document.createElement('span');
      preview.className = 'attn-scope-preview';
      preview.textContent = candidate.preview;
      item.appendChild(preview);
    }
    if (candidate.commentCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'attn-scope-count';
      badge.textContent = String(candidate.commentCount);
      item.appendChild(badge);
    }
    item.addEventListener('mouseenter', () => outline(scopeElements.get(candidate.scopeId)));
    item.addEventListener('click', (event) => {
      event.preventDefault();
      pickScope(candidate.scopeId);
    });
    flyout.appendChild(item);
  }
}

let outlineEl: HTMLElement | null = null;

function outline(el: Element | undefined): void {
  outlineEl?.remove();
  outlineEl = null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'attn-outline';
  box.style.cssText = `top:${rect.top + window.scrollY}px;left:${rect.left + window.scrollX}px;width:${rect.width}px;height:${rect.height}px`;
  layer.appendChild(box);
  outlineEl = box;
}

function pickScope(scopeId: string): void {
  const el = scopeElements.get(scopeId);
  if (!el) return;
  hideGutterPin();
  outline(undefined);
  send({
    type: 'scopePicked',
    v: DOC_PROTOCOL_VERSION,
    proposal: proposalForElement(el),
    rects: rectsOf(el),
  });
}

// ---------------------------------------------------------------------------
// Painting anchors
// ---------------------------------------------------------------------------

/**
 * Text highlights use the CSS Custom Highlight API, so no wrapper spans are
 * injected — the document's own DOM is never mutated by a highlight, which
 * keeps its scripts and our selectors from fighting over the tree.
 */
function repaintHighlights(): void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!highlights || typeof Highlight === 'undefined') return;
  const base: Range[] = [];
  const active: Range[] = [];
  for (const anchor of anchors.values()) {
    if (anchor.spec.html.target !== 'text_range' || !anchor.range) continue;
    (anchor.spec.state === 'active' ? active : base).push(anchor.range);
  }
  highlights.set(HIGHLIGHT_BUCKET, new Highlight(...base));
  highlights.set(HIGHLIGHT_ACTIVE_BUCKET, new Highlight(...active));
}

/**
 * Element anchors get an overlay whose fill is `pointer-events: none`, so the
 * user can still select — and comment on — the text underneath. Only the small
 * pin and count chip are interactive.
 */
function paintElementAnchor(anchor: LiveAnchor): void {
  anchor.overlay?.remove();
  anchor.pin?.remove();
  anchor.overlay = null;
  anchor.pin = null;
  if (anchor.spec.html.target !== 'element' || !anchor.element) return;

  const rect = anchor.element.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const left = rect.left + window.scrollX;

  const overlay = document.createElement('div');
  overlay.className = 'attn-overlay';
  overlay.dataset.state = anchor.spec.state;
  overlay.style.cssText = `top:${top}px;left:${left}px;width:${rect.width}px;height:${rect.height}px`;
  layer.appendChild(overlay);
  anchor.overlay = overlay;

  // Persistent marker: a committed comment stays visible without hovering, so
  // the document reads as annotated at a glance.
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'attn-pin';
  pin.dataset.state = anchor.spec.state;
  pin.textContent = anchor.spec.label ?? '1';
  pin.style.cssText = `top:${top - 10}px;left:${left - 14}px`;
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    send({
      type: 'anchorActivated',
      v: DOC_PROTOCOL_VERSION,
      anchorId: anchor.spec.anchorId,
    });
  });
  layer.appendChild(pin);
  anchor.pin = pin;
}

function resolveAndPaint(spec: RenderableAnchor): LiveAnchor {
  const resolution = resolveAnchor(root, {
    anchor: spec.html,
    quote: spec.quote,
    prefix: spec.prefix,
    suffix: spec.suffix,
  });
  const anchor: LiveAnchor = {
    spec,
    range: resolution.range,
    element: resolution.element,
    status: resolution.status,
    confidence: resolution.confidence,
    overlay: null,
    pin: null,
  };
  paintElementAnchor(anchor);
  return anchor;
}

function renderAnchors(specs: RenderableAnchor[]): void {
  for (const anchor of anchors.values()) {
    anchor.overlay?.remove();
    anchor.pin?.remove();
  }
  anchors.clear();
  for (const spec of specs) {
    anchors.set(spec.anchorId, resolveAndPaint(spec));
  }
  repaintHighlights();
  publishResolutions();
}

function publishResolutions(): void {
  const results: AnchorResolution[] = [];
  for (const anchor of anchors.values()) {
    results.push({
      anchorId: anchor.spec.anchorId,
      status: anchor.status,
      confidence: anchor.confidence,
      rects: rectsOf(anchor.range ?? anchor.element),
    });
  }
  send({ type: 'anchorsResolved', v: DOC_PROTOCOL_VERSION, results });
}

function publishGeometry(): void {
  const results: AnchorGeometry[] = [];
  for (const anchor of anchors.values()) {
    results.push({
      anchorId: anchor.spec.anchorId,
      rects: rectsOf(anchor.range ?? anchor.element),
    });
  }
  send({
    type: 'geometry',
    v: DOC_PROTOCOL_VERSION,
    results,
    scrollTop: window.scrollY,
  });
}

function setAnchorState(anchorId: string, state: AnchorRenderState): void {
  const anchor = anchors.get(anchorId);
  if (!anchor) return;
  anchor.spec = { ...anchor.spec, state };
  if (anchor.overlay) anchor.overlay.dataset.state = state;
  if (anchor.pin) anchor.pin.dataset.state = state;
  repaintHighlights();
}

function focusAnchor(anchorId: string, scrollIntoView: boolean): void {
  const anchor = anchors.get(anchorId);
  if (!anchor || !scrollIntoView) return;
  const target = anchor.element ?? anchor.range?.startContainer.parentElement;
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------------------------------------------------------------------
// Reflow
// ---------------------------------------------------------------------------

let frame = 0;

/**
 * Rects are reported in the frame's own viewport coordinates and the shell
 * cannot observe this frame's scroll cross-origin, so every reflow has to be
 * pushed. Coalesced to one animation frame so a smooth scroll does not become
 * a message storm.
 */
function scheduleReflow(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const anchor of anchors.values()) paintElementAnchor(anchor);
    repaintHighlights();
    publishGeometry();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function handleShellMessage(message: ShellMessage): void {
  switch (message.type) {
    case 'renderAnchors':
      renderAnchors(message.anchors);
      break;
    case 'setAnchorState':
      setAnchorState(message.anchorId, message.state);
      break;
    case 'focusAnchor':
      focusAnchor(message.anchorId, message.scrollIntoView);
      break;
    case 'pickScope':
      pickScope(message.scopeId);
      break;
    case 'dismissSelection':
      window.getSelection()?.removeAllRanges();
      pendingRange = null;
      hideSelectionPill();
      break;
    case 'theme':
      root.dataset.attnTheme = message.mode;
      break;
    default:
      break;
  }
}

function mountChrome(): void {
  const style = document.createElement('style');
  style.textContent = RUNTIME_STYLES;
  document.head.appendChild(style);

  layer = document.createElement('div');
  layer.className = 'attn-layer';
  document.body.appendChild(layer);

  gutterPin = document.createElement('button');
  gutterPin.type = 'button';
  gutterPin.className = 'attn-gutter-pin';
  gutterPin.setAttribute('aria-label', 'Comment on this block');
  gutterPin.addEventListener('mouseenter', () => flyout.classList.add('is-visible'));
  gutterPin.addEventListener('click', (event) => {
    event.preventDefault();
    const block = defaultTarget(hoverChain);
    if (!block) return;
    const entry = [...scopeElements.entries()].find(([, el]) => el === block);
    if (entry) pickScope(entry[0]);
  });
  layer.appendChild(gutterPin);

  flyout = document.createElement('div');
  flyout.className = 'attn-flyout';
  flyout.addEventListener('mouseleave', () => flyout.classList.remove('is-visible'));
  gutterPin.appendChild(flyout);

  selectionPill = document.createElement('button');
  selectionPill.type = 'button';
  selectionPill.className = 'attn-pill';
  selectionPill.textContent = 'Comment';
  // mousedown would collapse the selection before the click lands.
  selectionPill.addEventListener('mousedown', (event) => event.preventDefault());
  selectionPill.addEventListener('click', () => {
    if (!pendingRange) return;
    send({
      type: 'selection',
      v: DOC_PROTOCOL_VERSION,
      proposal: proposalForRange(pendingRange),
      rects: rectsOf(pendingRange),
      caret: rectsOf(pendingRange).slice(-1)[0] ?? { x: 0, y: 0, width: 0, height: 0 },
    });
  });
  layer.appendChild(selectionPill);
}

function attachPort(candidate: MessagePort): void {
  port = candidate;
  port.onmessage = (event: MessageEvent) => {
    // The port is private, but the document's own scripts share this context
    // and could reach it, so shape is still checked before use.
    const data = event.data as ShellMessage | undefined;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.v !== DOC_PROTOCOL_VERSION) return;
    handleShellMessage(data);
  };
  port.start();

  send({
    type: 'ready',
    v: DOC_PROTOCOL_VERSION,
    textLength: documentText(root).length,
    title: document.title.slice(0, 200),
  });
}

function boot(): void {
  root = document.body;
  mountChrome();

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousemove', onPointerMove, { passive: true });
  window.addEventListener('scroll', scheduleReflow, { passive: true });
  window.addEventListener('resize', scheduleReflow, { passive: true });
  new ResizeObserver(scheduleReflow).observe(document.body);

  window.addEventListener('message', (event: MessageEvent) => {
    // Origin is always "null" for an opaque frame, so it carries no information.
    // The shell is identified by being our parent; the port it hands over is
    // what makes every later message trustworthy.
    if (event.source !== window.parent) return;
    const data = event.data as { type?: unknown } | undefined;
    if (!data || data.type !== SHELL_INIT) return;
    const [candidate] = event.ports;
    if (candidate) attachPort(candidate);
  });

  window.parent.postMessage({ type: DOC_HELLO, v: DOC_PROTOCOL_VERSION }, '*');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
