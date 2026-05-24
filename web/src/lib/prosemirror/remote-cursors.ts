// Remote participant carets for live co-typing.
//
// Renders each peer's caret as a widget decoration — a thin colored bar with a
// floating name chip — at their broadcast head position. The cursor data is
// pushed in via a meta transaction (keyed by `remoteCursorsKey`) by the
// CollabController whenever a `cursor` wire message arrives, so this plugin
// stays a pure view of that state.
//
// Spec: planning/collab/ui/presence-identity.md (live cursors).

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import type { RemoteCursor } from './collab-controller';

/** Meta key the controller uses to push the current remote-cursor set in. */
export const remoteCursorsKey = new PluginKey<RemoteCursor[]>('attn-remote-cursors');

/** Build the floating caret DOM for one remote participant. */
function buildCaretWidget(cursor: RemoteCursor): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'attn-remote-caret';
  wrap.style.borderColor = cursor.color;
  wrap.setAttribute('data-client-id', cursor.clientID);

  const label = document.createElement('span');
  label.className = 'attn-remote-caret-label';
  label.style.backgroundColor = cursor.color;
  label.textContent = cursor.label;
  wrap.appendChild(label);

  return wrap;
}

/**
 * Plugin that renders remote carets. Its state is the cursor array, replaced
 * whenever a transaction carries a `remoteCursorsKey` meta payload.
 */
export function remoteCursorsPlugin(): Plugin {
  return new Plugin<RemoteCursor[]>({
    key: remoteCursorsKey,
    state: {
      init: () => [],
      apply(tr, prev) {
        const next = tr.getMeta(remoteCursorsKey) as RemoteCursor[] | undefined;
        if (next) return next;
        // Map each remote caret through LOCAL edits so it stays anchored to its
        // content instead of drifting when this user types (the head positions
        // are document offsets — without this they point at shifted text).
        if (!tr.docChanged || prev.length === 0) return prev;
        return prev.map((cursor) => ({ ...cursor, head: tr.mapping.map(cursor.head) }));
      },
    },
    props: {
      decorations(state) {
        const cursors = remoteCursorsKey.getState(state) ?? [];
        if (cursors.length === 0) return DecorationSet.empty;
        const max = state.doc.content.size;
        const decos = cursors.map((cursor) => {
          const pos = Math.min(Math.max(cursor.head, 0), max);
          return Decoration.widget(pos, () => buildCaretWidget(cursor), {
            // side:1 keeps the caret stable to the right of the position so it
            // doesn't get swallowed by adjacent text insertions.
            side: 1,
            // Ignore for ProseMirror's own position mapping/selection.
            ignoreSelection: true,
            key: `remote-caret-${cursor.clientID}-${pos}`,
          });
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
