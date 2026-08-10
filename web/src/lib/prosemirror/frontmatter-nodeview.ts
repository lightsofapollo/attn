// Folded frontmatter card NodeView. Renders a document's leading YAML block as
// a collapsible metadata card (key → value pairs) instead of the run-on serif
// paragraph it used to become. Display-only: the raw block round-trips
// byte-exact through the node's `value` attr, so nothing is lost.
//
// Built on the shared accordion primitive (attn-vlmz.3.2/.3.3). The card used
// to hand-roll `<details>`/`<summary>` with a '▶' text chevron and its own
// rotate transform, sharing nothing with the rest of the app; it now gets its
// open/close, chevron, keyboard (Enter/Space/Arrow/Home/End), focus ring, ARIA
// wiring, and reduced-motion behaviour from `components/ui/accordion` — the
// same code path the Svelte `<Accordion>` components run. Only the card's
// identity (border, mono key/value grid, uppercase label) stays local, in
// styles/prosemirror.css.
//
// The accordion is used through its framework-free surface rather than by
// mounting a Svelte component: a NodeView is imperative DOM outside the
// component tree, and every other NodeView in this directory is plain DOM
// too. See the decision record atop accordion-core.ts.

import type { Node as PmNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
// The core module, not the `accordion` barrel: the barrel re-exports the
// .svelte components, which drags the Svelte compiler into anything that
// imports it (including the tsx test runner). Non-Svelte consumers take the
// framework-free surface directly.
import { createAccordionDom } from '../components/ui/accordion/accordion-core';

interface Pair {
  key: string;
  value: string;
}

/**
 * Light, display-only YAML flatten: top-level `key: value` lines become pairs;
 * nested/complex values collapse to a compact one-line hint. This never feeds
 * serialization (the raw text does), so it only has to be readable.
 */
export function summarize(raw: string): { pairs: Pair[]; count: number } {
  const pairs: Pair[] = [];
  let currentKey: string | null = null;
  let nestedLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    const indented = /^\s+/.test(line);
    if (topLevel && !indented) {
      const key = topLevel[1];
      const value = topLevel[2].trim();
      currentKey = key;
      nestedLines = 0;
      pairs.push({ key, value });
    } else if (indented && currentKey) {
      // Fold nested content into the parent's value as a compact hint.
      nestedLines += 1;
      const last = pairs[pairs.length - 1];
      if (last) last.value = last.value || `${nestedLines} field${nestedLines === 1 ? '' : 's'}`;
      else pairs.push({ key: currentKey, value: `${nestedLines} fields` });
    }
  }
  return { pairs, count: pairs.length };
}

/** The quiet summary beside the label: an author-ish key when there is one,
 *  then the field count. Unchanged from the hand-rolled card. */
export function metaLine(pairs: Pair[], count: number): string {
  const author = pairs.find((p) => p.key === 'author' || p.key === 'name');
  return (
    (author ? `${author.key}: ${author.value} · ` : '') +
    `${count} field${count === 1 ? '' : 's'}`
  );
}

export function frontmatterNodeView(node: PmNode): NodeView {
  const raw = String(node.attrs.value ?? '');
  const { pairs, count } = summarize(raw);

  const dl = document.createElement('dl');
  dl.className = 'frontmatter-pairs';
  for (const { key, value } of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  const { element, controller } = createAccordionDom(
    [{ value: 'frontmatter', label: 'Frontmatter', meta: metaLine(pairs, count), content: dl }],
    {
      type: 'single',
      idPrefix: 'frontmatter',
      class: 'frontmatter-card',
      labelClass: 'frontmatter-label',
      // The card's own typography, not the primitive's right-aligned default:
      // the meta reads as a continuation of the label, as it always has.
      metaClass: 'frontmatter-meta',
      // The dl carries its own padding (.frontmatter-pairs), so opt out of the
      // primitive's panel padding rather than stack the two.
      bodyClass: '',
    },
  );
  element.contentEditable = 'false';

  return {
    dom: element,
    // Atom node — no editable content. Keep ProseMirror out of the card's DOM.
    ignoreMutation: () => true,
    // Every event, not the old mousedown/click carve-out: the trigger is a
    // real button now, and the editor's keymap must not contend with its
    // Enter/Space/Arrow handling. The cost is that clicking the card no longer
    // creates a ProseMirror NodeSelection; arrowing into the atom from an
    // adjacent block still does, so the block remains selectable and
    // deletable by keyboard.
    stopEvent: () => true,
    // ProseMirror recreates NodeViews on every document swap. This releases
    // the two listeners the accordion bound to the trigger; it is idempotent.
    destroy: () => controller.destroy(),
  };
}
