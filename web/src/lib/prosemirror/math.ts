import type { EditorView, NodeView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';

type KatexApi = { renderToString(tex: string, opts?: Record<string, unknown>): string };

let katex: KatexApi | null = null;
let katexLoading: Promise<KatexApi> | null = null;

function loadKatex(): Promise<KatexApi> {
  if (katex) return Promise.resolve(katex);
  if (katexLoading) return katexLoading;
  katexLoading = import('katex').then((mod) => {
    // Also inject KaTeX CSS
    if (!document.querySelector('link[href*="katex"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
      document.head.appendChild(link);
    }
    katex = mod.default as unknown as KatexApi;
    return katex;
  });
  return katexLoading;
}

/**
 * ProseMirror NodeView for code_block nodes with params === 'math' or 'latex'.
 * Renders LaTeX as formatted math using KaTeX. Double-click to toggle source.
 */
export function mathNodeView(
  node: PmNode,
  _view: EditorView,
  _getPos: () => number | undefined,
): NodeView | undefined {
  const lang = (node.attrs.params as string || '').split(/\s+/)[0].toLowerCase();
  if (lang !== 'math' && lang !== 'latex') return undefined;

  const container = document.createElement('div');
  container.className = 'math-container';

  const renderWrap = document.createElement('div');
  renderWrap.className = 'math-render';
  container.appendChild(renderWrap);

  const codeWrap = document.createElement('pre');
  codeWrap.className = 'math-source';
  codeWrap.style.display = 'none';
  const codeEl = document.createElement('code');
  codeWrap.appendChild(codeEl);
  container.appendChild(codeWrap);

  let showSource = false;

  container.addEventListener('dblclick', (e) => {
    e.preventDefault();
    showSource = !showSource;
    renderWrap.style.display = showSource ? 'none' : '';
    codeWrap.style.display = showSource ? '' : 'none';
  });

  function renderMath(tex: string): void {
    codeEl.textContent = tex;
    loadKatex().then((k) => {
      try {
        renderWrap.innerHTML = k.renderToString(tex, {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        renderWrap.innerHTML = `<pre class="math-error">Failed to render math</pre>`;
      }
    });
  }

  renderMath(node.textContent);

  return {
    dom: container,
    update(updatedNode: PmNode) {
      if (updatedNode.type.name !== 'code_block') return false;
      const updatedLang = (updatedNode.attrs.params as string || '').split(/\s+/)[0].toLowerCase();
      if (updatedLang !== 'math' && updatedLang !== 'latex') return false;
      renderMath(updatedNode.textContent);
      return true;
    },
    stopEvent(event) {
      // Allow ProseMirror/browser keyboard + clipboard shortcuts to propagate.
      // Only keep our local dblclick toggle isolated.
      return event.type === 'dblclick';
    },
  };
}
