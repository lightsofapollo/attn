// Framework-free accordion binder + DOM builder.
//
// ============================================================================
// DECISION (attn-vlmz.3.2): an *accordion* set, implemented as a shared
// framework-free core with a thin Svelte wrapper — not a `collapsible` adopt,
// and not a bits-ui `Accordion` wrapper.
//
// Three options were on the table.
//
//   (1) Adopt the existing `components/ui/collapsible` (bits-ui Collapsible).
//       Rejected on shape. A Collapsible is exactly one disclosure with no
//       notion of siblings, so the moment a second disclosure appears next to
//       it there is no shared open-set, no roving arrow-key focus between the
//       headers, and no single/multiple semantics — each consumer re-invents
//       them. The app already has disclosure *sets*, not just lone toggles
//       (the share sheet stacks `share-advanced` + `share-invite-options`;
//       the frontmatter card is a set of one today and the obvious host for
//       more folded document metadata later). Building the set primitive
//       costs almost nothing extra and a set of one is a strict superset of
//       a collapsible, so `collapsible` stays where it is (FileTree's
//       group/collapsible styling depends on it) and gains a sibling.
//
//   (2) Wrap bits-ui's `Accordion`, the way every other primitive in
//       `components/ui` wraps bits-ui. Rejected on the consumer. The reason
//       this issue exists is `prosemirror/frontmatter-nodeview.ts`: a
//       ProseMirror NodeView is imperative DOM (`document.createElement`,
//       return an object with a `dom` property) that lives OUTSIDE the Svelte
//       component tree. bits-ui components can only be rendered by Svelte, so
//       this option forces `mount()`-ing a component into the NodeView.
//
//   (3) What is built here: one core that wires ARIA, keyboard, and state
//       onto elements the caller already owns, plus Svelte components that
//       hand the core their own elements. Both consumers run the SAME code
//       path, so they cannot drift; the NodeView keeps the plain-DOM shape
//       every other NodeView in this repo has (`mermaid-nodeview.ts`,
//       `code-block-nodeview.ts`, `math.ts` are all pure imperative DOM —
//       there is NO Svelte-in-NodeView precedent here to follow); and the
//       logic stays testable under plain `tsx`, which is how `web/` tests run.
//
// The rejected `mount()` route (2) also carries a lifetime hazard worth
// recording: ProseMirror recreates NodeViews on every doc swap, so every
// mount needs a matching `unmount()` in `destroy()`, and Svelte 5's
// `unmount()` is async when the tree has transitions — a swap-heavy editor
// would be one missed `destroy()` away from leaking a live component per
// document. Option (3) has no such pairing to get wrong: `destroy()` only
// removes listeners the core itself added, and the DOM is garbage-collected
// with the NodeView.
// ============================================================================
//
// USAGE FROM A PROSEMIRROR NODEVIEW — the worked example for attn-vlmz.3.3.
// This is the whole integration; there is no bridge layer:
//
//     // This module, NOT the `accordion` barrel — index.ts re-exports the
//     // .svelte components, and a NodeView must not pull those in.
//     import { createAccordionDom } from '$lib/components/ui/accordion/accordion-core';
//
//     export function frontmatterNodeView(node: PmNode): NodeView {
//       const pairs = summarize(String(node.attrs.value ?? ''));
//
//       const dl = document.createElement('dl');
//       // ... fill dl with dt/dd pairs ...
//
//       const { element, controller } = createAccordionDom(
//         [{ value: 'frontmatter', label: 'Frontmatter', meta: `${n} fields`, content: dl }],
//         // bodyClass: '' — the card's own padding lives in
//         // styles/prosemirror.css (.frontmatter-pairs), so opt out of the
//         // primitive's default panel padding rather than fight it.
//         { type: 'single', idPrefix: 'frontmatter', bodyClass: '' },
//       );
//       element.contentEditable = 'false';
//       element.classList.add('frontmatter-card');
//
//       return {
//         dom: element,
//         // Atom node: ProseMirror must not touch or interpret this subtree.
//         ignoreMutation: () => true,
//         // `() => true` (not the old mousedown/click carve-out) so the
//         // trigger's own Enter/Space/Arrow handling is never pre-empted by
//         // the editor's keymap.
//         stopEvent: () => true,
//         destroy: () => controller.destroy(),
//       };
//     }
//
// `controller.destroy()` is idempotent and safe to call from a `destroy()`
// that ProseMirror may invoke more than once.

import {
  accordionChevronClass,
  accordionContentBodyClass,
  accordionContentClass,
  accordionContentInnerClass,
  accordionItemClass,
  accordionRootClass,
  accordionTriggerClass,
  accordionTriggerMetaClass,
} from './accordion-styles';
import {
  type AccordionType,
  type AttrMap,
  NAVIGATION_KEYS,
  accordionItemIds,
  applyToggle,
  contentAttributes,
  itemAttributes,
  nextAccordionId,
  nextTriggerIndex,
  normalizeValue,
  rootAttributes,
  triggerAttributes,
} from './accordion-model';

/** Lucide `chevron-right`, inlined the same way code-block-nodeview.ts inlines
 *  its copy/check glyphs. The Svelte trigger imports the component form of the
 *  same icon.
 *
 *  14px, matching the `size-3.5` on the span that wraps it: the Svelte path
 *  puts that class on the <svg> itself, so the intrinsic size never shows —
 *  here the class lands on the wrapper, and a 24px glyph inside a 14px box
 *  would overflow. */
const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** One row, described by elements the caller already owns. */
export interface AccordionItemSpec {
  value: string;
  /** The focusable header. Should be a real `<button>` so Enter/Space come
   *  for free; the core does not synthesize activation keys. */
  trigger: HTMLElement;
  /** The panel (gets `data-state` / `inert`). Its size follows `data-state`
   *  directly — see accordion-styles.ts; nothing here waits on motion. */
  content: HTMLElement;
  /** Optional wrapper, for `data-state` styling hooks. */
  item?: HTMLElement | null;
  disabled?: boolean;
}

export interface AccordionOptions {
  /** `single` keeps at most one row open. Default `single`. */
  type?: AccordionType;
  /** `single` only: may the open row be closed by its own trigger? Default true. */
  collapsible?: boolean;
  /** Initially open value(s). */
  value?: string | string[] | null;
  /** Wrap arrow-key focus at the ends. Default true. */
  loop?: boolean;
  /** Prefix for generated element ids. Default a fresh `accordion-N`. */
  idPrefix?: string;
  onValueChange?: (value: string[]) => void;
}

export interface AccordionController {
  /** Currently open values, in insertion order. */
  readonly value: string[];
  setValue(next: string | string[] | null | undefined): void;
  toggle(value: string): void;
  /** Remove every listener the core added. Idempotent. */
  destroy(): void;
}

function applyAttrs(el: HTMLElement, attrs: AttrMap): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
}

/**
 * Wire an existing DOM subtree as an accordion.
 *
 * The caller owns the markup; the core owns ARIA state, click/keyboard
 * behaviour, and the open-set. Nothing is queried out of the DOM — items are
 * passed by reference — which is what lets the Svelte wrapper and the
 * NodeView share this function without a selector contract between them.
 */
export function attachAccordion(
  root: HTMLElement,
  items: readonly AccordionItemSpec[],
  options: AccordionOptions = {},
): AccordionController {
  const type: AccordionType = options.type ?? 'single';
  const collapsible = options.collapsible ?? true;
  const loop = options.loop ?? true;
  const prefix = options.idPrefix ?? nextAccordionId();
  const specs = items.slice();

  let open = normalizeValue(options.value, type);
  let destroyed = false;

  // Behaviour and ARIA only — styling stays with whoever built the markup
  // (the Svelte Root's `cn()` call, or `createAccordionDom` below).
  applyAttrs(root, rootAttributes(type));

  const ids = specs.map((spec) => accordionItemIds(prefix, spec.value));

  function render(): void {
    specs.forEach((spec, index) => {
      const isOpen = open.includes(spec.value);
      const disabled = spec.disabled ?? false;
      applyAttrs(spec.trigger, triggerAttributes(ids[index], isOpen, disabled));
      applyAttrs(spec.content, contentAttributes(ids[index], isOpen));
      if (spec.item) applyAttrs(spec.item, itemAttributes(isOpen, disabled));
    });
  }

  function commit(next: string[]): void {
    const changed =
      next.length !== open.length || next.some((v, i) => v !== open[i]);
    open = next;
    render();
    if (changed) options.onValueChange?.(open.slice());
  }

  function toggle(value: string): void {
    const spec = specs.find((s) => s.value === value);
    if (!spec || spec.disabled) return;
    commit(applyToggle(open, value, type, collapsible));
  }

  const cleanups: Array<() => void> = [];

  specs.forEach((spec, index) => {
    const onClick = (event: Event): void => {
      event.preventDefault();
      toggle(spec.value);
    };
    const onKeyDown = (event: Event): void => {
      const key = (event as KeyboardEvent).key;
      if (!NAVIGATION_KEYS.includes(key)) return;
      const target = nextTriggerIndex(key, index, specs, loop);
      if (target === null || target === index) {
        // Still swallow the key: an accordion inside ProseMirror must not let
        // ArrowUp/Home leak out and move the editor's caret.
        event.preventDefault();
        return;
      }
      event.preventDefault();
      specs[target].trigger.focus();
    };

    spec.trigger.addEventListener('click', onClick);
    spec.trigger.addEventListener('keydown', onKeyDown);
    cleanups.push(() => {
      spec.trigger.removeEventListener('click', onClick);
      spec.trigger.removeEventListener('keydown', onKeyDown);
    });
  });

  render();

  return {
    get value() {
      return open.slice();
    },
    setValue(next) {
      if (destroyed) return;
      commit(normalizeValue(next, type));
    },
    toggle(value) {
      if (destroyed) return;
      toggle(value);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}

/** Declarative item for the imperative builder. */
export interface AccordionDomItem {
  value: string;
  /** Header label. A string becomes a text node. */
  label: string | Node;
  /** Optional quiet trailing summary in the header. */
  meta?: string | Node | null;
  /** Panel body. Padding is the caller's call — pass `bodyClass: ''` to skip. */
  content: Node;
  disabled?: boolean;
}

export interface AccordionDomOptions extends AccordionOptions {
  /** Injectable for tests / non-window documents. Defaults to `document`. */
  document?: Document;
  /** Extra classes for the root element. */
  class?: string;
  /** Classes for the header label wrapper. Unclassed by default. */
  labelClass?: string;
  /** Classes for the trailing meta span. Defaults to the primitive's quiet
   *  right-aligned treatment; override when the consumer's own typography
   *  should win (the frontmatter card keeps its meta next to the label). */
  metaClass?: string;
  /** Classes for the panel body wrapper. Defaults to the same padding the
   *  Svelte `Accordion.Content` applies; pass `''` for a full-bleed panel
   *  whose padding comes from elsewhere (e.g. the frontmatter card's rules in
   *  styles/prosemirror.css). */
  bodyClass?: string;
}

export interface AccordionDom {
  element: HTMLElement;
  controller: AccordionController;
  /** Item value -> its panel body element, for callers that want to refill it
   *  on a node update without rebuilding the accordion. */
  bodies: Map<string, HTMLElement>;
}

/**
 * Build a fully-styled accordion out of plain DOM and wire it.
 *
 * This is the entry point for ProseMirror NodeViews — see the worked example
 * at the top of this file. The markup it produces is the same shape the
 * Svelte components produce, and it is wired by the same `attachAccordion`.
 */
export function createAccordionDom(
  items: readonly AccordionDomItem[],
  options: AccordionDomOptions = {},
): AccordionDom {
  const doc = options.document ?? globalThis.document;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const root = el('div', options.class ? `${accordionRootClass} ${options.class}` : accordionRootClass);
  const specs: AccordionItemSpec[] = [];
  const bodies = new Map<string, HTMLElement>();

  for (const item of items) {
    const wrapper = el('div', accordionItemClass);

    const trigger = el('button', accordionTriggerClass);
    const chevron = el('span', accordionChevronClass);
    chevron.innerHTML = CHEVRON_SVG;
    trigger.appendChild(chevron);

    const label = el('span', options.labelClass);
    if (typeof item.label === 'string') label.textContent = item.label;
    else label.appendChild(item.label);
    trigger.appendChild(label);

    if (item.meta != null) {
      const meta = el('span', options.metaClass ?? accordionTriggerMetaClass);
      if (typeof item.meta === 'string') meta.textContent = item.meta;
      else meta.appendChild(item.meta);
      trigger.appendChild(meta);
    }

    const content = el('div', accordionContentClass);
    const inner = el('div', accordionContentInnerClass);
    const body = el('div', options.bodyClass ?? accordionContentBodyClass);
    body.appendChild(item.content);
    inner.appendChild(body);
    content.appendChild(inner);

    wrapper.appendChild(trigger);
    wrapper.appendChild(content);
    root.appendChild(wrapper);

    bodies.set(item.value, body);
    specs.push({ value: item.value, trigger, content, item: wrapper, disabled: item.disabled });
  }

  const controller = attachAccordion(root, specs, options);
  return { element: root, controller, bodies };
}
