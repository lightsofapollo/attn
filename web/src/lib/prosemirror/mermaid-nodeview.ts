import type { EditorView, NodeView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import Panzoom from '@panzoom/panzoom';

type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, definition: string): Promise<{ svg: string }>;
};

let mermaid: MermaidApi | null = null;
let mermaidLoading: Promise<MermaidApi> | null = null;
const renderCache = new Map<string, string>();
let lastMermaidTheme: 'default' | 'dark' | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

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

function enqueueMermaidRender(task: () => Promise<void>): Promise<void> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(() => undefined, () => undefined);
  return run;
}

let mermaidCounter = 0;

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
    || document.body.classList.contains('dark');
}

function ensureViewBox(svg: SVGElement): void {
  if (svg.hasAttribute('viewBox')) return;
  const width = parseFloat((svg.getAttribute('width') || '').replace(/px$/, ''));
  const height = parseFloat((svg.getAttribute('height') || '').replace(/px$/, ''));
  if (!Number.isNaN(width) && !Number.isNaN(height)) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return;
  }
  try {
    const bbox = (svg as unknown as SVGGraphicsElement).getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      svg.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
    }
  } catch {
    // No-op: keep original sizing if bbox unavailable.
  }
}

function openMermaidFullscreen(
  sourceSvg: SVGElement,
  title = 'Mermaid Diagram',
): () => void {
  const modal = document.createElement('div');
  modal.className = 'mermaid-fullscreen-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', title);

  const content = document.createElement('div');
  content.className = 'mermaid-fullscreen-content';

  const header = document.createElement('div');
  header.className = 'mermaid-fullscreen-header';
  header.innerHTML = `
    <h2 class="mermaid-fullscreen-title">${title}</h2>
    <div class="mermaid-fullscreen-controls">
      <button class="mermaid-fullscreen-btn" data-action="zoom-out" type="button" aria-label="Zoom out" title="Zoom out">−</button>
      <button class="mermaid-fullscreen-btn" data-action="zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>
      <button class="mermaid-fullscreen-btn" data-action="reset" type="button" aria-label="Reset view" title="Reset view">⟲</button>
      <button class="mermaid-fullscreen-btn mermaid-fullscreen-close" data-action="close" type="button" aria-label="Close" title="Close">×</button>
    </div>
  `;

  const viewport = document.createElement('div');
  viewport.className = `mermaid-fullscreen-viewport ${isDarkMode() ? 'dark' : 'light'}`;

  const panzoomHost = document.createElement('div');
  panzoomHost.className = 'mermaid-fullscreen-panzoom';

  const fullscreenSvg = sourceSvg.cloneNode(true) as SVGElement;
  fullscreenSvg.classList.add('mermaid-fullscreen-svg');
  ensureViewBox(fullscreenSvg);
  fullscreenSvg.removeAttribute('style');
  fullscreenSvg.removeAttribute('width');
  fullscreenSvg.removeAttribute('height');
  fullscreenSvg.style.width = '100%';
  fullscreenSvg.style.height = '100%';
  fullscreenSvg.style.maxWidth = '100%';
  fullscreenSvg.style.maxHeight = '100%';
  fullscreenSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  panzoomHost.appendChild(fullscreenSvg);
  viewport.appendChild(panzoomHost);

  const footer = document.createElement('div');
  footer.className = 'mermaid-fullscreen-footer';
  footer.textContent = 'Drag to pan • Scroll to zoom';

  content.appendChild(header);
  content.appendChild(viewport);
  content.appendChild(footer);
  modal.appendChild(content);
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';

  const panzoom = Panzoom(panzoomHost, {
    maxScale: 10,
    minScale: 0.1,
    contain: 'outside',
    cursor: 'grab',
    step: 0.1,
    startScale: 1,
  });

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    panzoom.zoomWithWheel(e, { step: 0.05 });
  };

  const onControlsClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const button = target.closest('button');
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    const action = button.getAttribute('data-action');
    if (action === 'zoom-in') panzoom.zoomIn({ step: 0.2 });
    else if (action === 'zoom-out') panzoom.zoomOut({ step: 0.2 });
    else if (action === 'reset') panzoom.reset();
    else if (action === 'close') close();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === modal) close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '+') {
      e.preventDefault();
      panzoom.zoomIn({ step: 0.2 });
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      panzoom.zoomOut({ step: 0.2 });
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      panzoom.reset();
    }
  };

  viewport.addEventListener('wheel', onWheel, { passive: false });
  header.addEventListener('click', onControlsClick);
  modal.addEventListener('click', onBackdropClick);
  document.addEventListener('keydown', onKeyDown);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    viewport.removeEventListener('wheel', onWheel);
    header.removeEventListener('click', onControlsClick);
    modal.removeEventListener('click', onBackdropClick);
    document.removeEventListener('keydown', onKeyDown);
    panzoom.destroy();
    modal.remove();
    document.body.style.overflow = '';
  };

  return close;
}

/**
 * ProseMirror NodeView for code_block nodes with params === 'mermaid'.
 * Renders mermaid diagrams as SVGs with fullscreen pan/zoom support.
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

  const controls = document.createElement('div');
  controls.className = 'mermaid-controls';
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'mermaid-control-btn';
  fullscreenBtn.type = 'button';
  fullscreenBtn.title = 'Open fullscreen';
  fullscreenBtn.setAttribute('aria-label', 'Open fullscreen');
  fullscreenBtn.textContent = '⛶';
  controls.appendChild(fullscreenBtn);
  container.appendChild(controls);

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
  let closeFullscreen: (() => void) | null = null;

  function toggle(): void {
    showSource = !showSource;
    svgWrap.style.display = showSource ? 'none' : '';
    codeWrap.style.display = showSource ? '' : 'none';
  }

  container.addEventListener('dblclick', (e) => {
    e.preventDefault();
    toggle();
  });

  function openFullscreen(): void {
    const svg = svgWrap.querySelector('svg') as SVGElement | null;
    if (!svg) return;
    closeFullscreen?.();
    closeFullscreen = openMermaidFullscreen(svg);
  }

  controls.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFullscreen();
  });

  function renderDiagram(code: string): Promise<void> {
    codeEl.textContent = code;
    const theme = isDarkMode() ? 'dark' : 'default';
    const cacheKey = `${theme}::${code}`;
    const cached = renderCache.get(cacheKey);
    if (cached) {
      svgWrap.innerHTML = cached;
      return Promise.resolve();
    }

    const id = `mermaid-${mermaidCounter++}`;
    return enqueueMermaidRender(() =>
      loadMermaid().then((m) => {
        if (lastMermaidTheme !== theme) {
          m.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme,
            fontFamily: 'inherit',
          });
          lastMermaidTheme = theme;
        }
        return m.render(id, code).then(({ svg }) => {
        renderCache.set(cacheKey, svg);
        svgWrap.innerHTML = svg;
        const renderedSvg = svgWrap.querySelector('svg') as SVGElement | null;
        if (renderedSvg) {
          renderedSvg.style.cursor = 'pointer';
          renderedSvg.setAttribute('title', 'Open fullscreen');
          renderedSvg.addEventListener('click', openFullscreen);
        }
        }).catch(() => {
          svgWrap.innerHTML = `<pre class="mermaid-error">Failed to render mermaid diagram</pre>`;
        });
      }),
    );
  }

  renderDiagram(node.textContent);

  return {
    dom: container,
    // No contentDOM — we manage the content ourselves
    update(updatedNode: PmNode) {
      if (updatedNode.type.name !== 'code_block') return false;
      const updatedLang = (updatedNode.attrs.params as string || '').split(/\s+/)[0].toLowerCase();
      if (updatedLang !== 'mermaid') return false;
      void renderDiagram(updatedNode.textContent);
      return true;
    },
    stopEvent(event) {
      return event.target instanceof HTMLElement
        && !!event.target.closest('.mermaid-controls');
    },
    destroy() {
      closeFullscreen?.();
      closeFullscreen = null;
    },
  };
}
