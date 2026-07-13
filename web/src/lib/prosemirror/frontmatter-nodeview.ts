// Folded frontmatter card NodeView. Renders a document's leading YAML block as
// a collapsible metadata card (key → value pairs) instead of the run-on serif
// paragraph it used to become. Display-only: the raw block round-trips
// byte-exact through the node's `value` attr, so nothing is lost.

import type { Node as PmNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';

interface Pair {
  key: string;
  value: string;
}

/**
 * Light, display-only YAML flatten: top-level `key: value` lines become pairs;
 * nested/complex values collapse to a compact one-line hint. This never feeds
 * serialization (the raw text does), so it only has to be readable.
 */
function summarize(raw: string): { pairs: Pair[]; count: number } {
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

export function frontmatterNodeView(node: PmNode): NodeView {
  const raw = String(node.attrs.value ?? '');
  const { pairs, count } = summarize(raw);

  const details = document.createElement('details');
  details.className = 'frontmatter-card';
  details.contentEditable = 'false';

  const summary = document.createElement('summary');
  const chev = document.createElement('span');
  chev.className = 'frontmatter-chev';
  chev.textContent = '▶';
  const label = document.createElement('span');
  label.className = 'frontmatter-label';
  label.textContent = 'Frontmatter';
  const meta = document.createElement('span');
  meta.className = 'frontmatter-meta';
  const author = pairs.find((p) => p.key === 'author' || p.key === 'name');
  meta.textContent =
    (author ? `${author.key}: ${author.value} · ` : '') +
    `${count} field${count === 1 ? '' : 's'}`;
  summary.append(chev, label, meta);

  const dl = document.createElement('dl');
  dl.className = 'frontmatter-pairs';
  for (const { key, value } of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  details.append(summary, dl);

  return {
    dom: details,
    // Atom node — no editable content. Keep ProseMirror out of the card's DOM.
    ignoreMutation: () => true,
    stopEvent: (event) => event.type !== 'mousedown' && event.type !== 'click',
  };
}
