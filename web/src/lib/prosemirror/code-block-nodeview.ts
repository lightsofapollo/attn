import type { EditorView, NodeView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';

function codeBlockLanguage(node: PmNode): string {
  return ((node.attrs.params as string) || '').split(/\s+/)[0].toLowerCase();
}

/**
 * ProseMirror NodeView for standard code blocks.
 * Mermaid/Math are handled by specialized node views.
 */
export function codeBlockNodeView(
  node: PmNode,
  _view: EditorView,
  _getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement('div');
  dom.className = 'prose-scroll-x';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.style.margin = '0';
  pre.appendChild(code);
  dom.appendChild(pre);

  const updateParams = (params: string): void => {
    if (params) {
      pre.setAttribute('data-params', params);
    } else {
      pre.removeAttribute('data-params');
    }
  };
  updateParams((node.attrs.params as string) || '');

  return {
    dom,
    contentDOM: code,
    update(updatedNode: PmNode) {
      if (updatedNode.type !== node.type) return false;
      const updatedLang = codeBlockLanguage(updatedNode);
      if (updatedLang === 'mermaid' || updatedLang === 'math' || updatedLang === 'latex') {
        return false;
      }
      node = updatedNode;
      updateParams((updatedNode.attrs.params as string) || '');
      return true;
    },
  };
}
