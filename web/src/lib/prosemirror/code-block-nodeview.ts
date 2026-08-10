import type { EditorView, NodeView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import { detectLanguage } from './detect-language';

/* Lucide icon SVG paths (24×24 viewBox) */
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function codeBlockLanguage(node: PmNode): string {
  return ((node.attrs.params as string) || '').split(/\s+/)[0].toLowerCase();
}

function createCopyButton(code: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy-btn';
  btn.setAttribute('aria-label', 'Copy code');
  btn.innerHTML = COPY_ICON;

  btn.addEventListener('click', () => {
    const text = code.textContent ?? '';
    navigator.clipboard.writeText(text);
    btn.innerHTML = CHECK_ICON;
    setTimeout(() => {
      btn.innerHTML = COPY_ICON;
    }, 1500);
  });

  return btn;
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
  // Frame (never scrolls) > scroller > pre > code. The copy button and the
  // language label pin to the frame, so they hold the block's visual
  // top corners while wide content scrolls beneath them.
  const dom = document.createElement('div');
  dom.className = 'code-block';
  const scroller = document.createElement('div');
  scroller.className = 'prose-scroll-x';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.style.margin = '0';
  pre.appendChild(code);
  scroller.appendChild(pre);
  dom.appendChild(scroller);
  dom.appendChild(createCopyButton(code));

  const updateBadge = (currentNode: PmNode): void => {
    const params = (currentNode.attrs.params as string) || '';
    if (params) {
      pre.setAttribute('data-params', params);
      dom.setAttribute('data-params', params);
      dom.removeAttribute('data-detected');
    } else {
      pre.removeAttribute('data-params');
      dom.removeAttribute('data-params');
      // Untagged fence: show what the highlighter guessed (styled as a
      // guess), or nothing when detection stayed unconvinced.
      const detected = detectLanguage(currentNode.textContent);
      if (detected) {
        dom.setAttribute('data-detected', detected);
      } else {
        dom.removeAttribute('data-detected');
      }
    }
  };
  updateBadge(node);

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
      updateBadge(updatedNode);
      return true;
    },
  };
}
