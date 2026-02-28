import type { EditorView, NodeView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';

type MermaidApi = { render(id: string, definition: string): Promise<{ svg: string }> };

let mermaid: MermaidApi | null = null;
let mermaidLoading: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (mermaid) return Promise.resolve(mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = import('mermaid').then((mod) => {
    const m = mod.default;
    m.initialize({
      startOnLoad: false,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
    });
    mermaid = m as unknown as MermaidApi;
    return mermaid;
  });
  return mermaidLoading;
}

let mermaidCounter = 0;

/**
 * ProseMirror NodeView for code_block nodes with params === 'mermaid'.
 * Renders mermaid diagrams as SVGs. Click to toggle source view.
 */
export function mermaidNodeView(
  node: PmNode,
  _view: EditorView,
  _getPos: () => number | undefined,
): NodeView | undefined {
  const lang = (node.attrs.params as string || '').split(/\s+/)[0].toLowerCase();
  if (lang !== 'mermaid') return undefined;

  const container = document.createElement('div');
  container.className = 'mermaid-container';

  const svgWrap = document.createElement('div');
  svgWrap.className = 'mermaid-render';
  container.appendChild(svgWrap);

  const codeWrap = document.createElement('pre');
  codeWrap.className = 'mermaid-source';
  codeWrap.style.display = 'none';
  const codeEl = document.createElement('code');
  codeWrap.appendChild(codeEl);
  container.appendChild(codeWrap);

  let showSource = false;

  function toggle(): void {
    showSource = !showSource;
    svgWrap.style.display = showSource ? 'none' : '';
    codeWrap.style.display = showSource ? '' : 'none';
  }

  container.addEventListener('dblclick', (e) => {
    e.preventDefault();
    toggle();
  });

  function renderDiagram(code: string): void {
    codeEl.textContent = code;
    const id = `mermaid-${mermaidCounter++}`;
    loadMermaid().then((m) => {
      m.render(id, code).then(({ svg }) => {
        svgWrap.innerHTML = svg;
      }).catch(() => {
        svgWrap.innerHTML = `<pre class="mermaid-error">Failed to render mermaid diagram</pre>`;
      });
    });
  }

  renderDiagram(node.textContent);

  return {
    dom: container,
    // No contentDOM — we manage the content ourselves
    update(updatedNode: PmNode) {
      if (updatedNode.type.name !== 'code_block') return false;
      const updatedLang = (updatedNode.attrs.params as string || '').split(/\s+/)[0].toLowerCase();
      if (updatedLang !== 'mermaid') return false;
      renderDiagram(updatedNode.textContent);
      return true;
    },
    stopEvent() {
      return true;
    },
  };
}
