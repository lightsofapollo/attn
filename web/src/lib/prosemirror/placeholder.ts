// Empty-editor placeholder (gate-35): the hosted desktop editor opened to a
// barren canvas with no hint. This decorates a truly-empty document's first
// paragraph with the class + attr the stylesheet's
// `.ProseMirror p.is-editor-empty:first-child::before` rule already renders.

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc } = state;
        const first = doc.firstChild;
        const isEmpty =
          doc.childCount === 1 &&
          first != null &&
          first.isTextblock &&
          first.content.size === 0;
        if (!isEmpty) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, doc.nodeSize - 2, {
            class: 'is-editor-empty',
            'data-placeholder': text,
          }),
        ]);
      },
    },
  });
}
