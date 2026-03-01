<script lang="ts">
  import { EditorState } from 'prosemirror-state';
  import { EditorView, type NodeView } from 'prosemirror-view';
  import { Node as PmNode } from 'prosemirror-model';
  import {
    SearchQuery,
    findNext as searchFindNext,
    findPrev as searchFindPrev,
    getMatchHighlights,
    getSearchState,
    search,
    setSearchState,
  } from 'prosemirror-search';
  import { tick } from 'svelte';
  import { keymap } from 'prosemirror-keymap';
  import { baseKeymap } from 'prosemirror-commands';
  import { history, redo, undo } from 'prosemirror-history';
  import { codeHighlightPlugin } from './prosemirror/code-highlight';
  import { codeBlockNodeView } from './prosemirror/code-block-nodeview';
  import { mathNodeView } from './prosemirror/math';
  import { mermaidNodeView } from './prosemirror/mermaid-nodeview';
  import { editSave } from './ipc';
  import { markdownParser, markdownSerializer, schema } from './schema';

  interface Props {
    markdown: string;
    editable?: boolean;
    onSave?: () => void;
    onCancel?: () => void;
    onLinkNavigate?: (href: string) => void;
    onCheckboxToggle?: (md: string) => void;
    onDirtyChange?: (dirty: boolean) => void;
  }

  let {
    markdown,
    editable = false,
    onSave,
    onCancel,
    onLinkNavigate,
    onCheckboxToggle,
    onDirtyChange,
  }: Props = $props();
  let editorEl: HTMLElement | undefined = $state(undefined);
  let view: EditorView | undefined;
  let findOpen = $state(false);
  let findQuery = $state('');
  let findMatchCount = $state(0);
  let lastMarkdown = '';
  let dirty = false;
  let findInputEl: HTMLInputElement | undefined = $state(undefined);
  let findBarEl: HTMLFormElement | undefined = $state(undefined);

  let lastSafeModeLength = -1;
  const PARSE_WARN_MS = 120;
  const LARGE_MARKDOWN_CHAR_LIMIT = 350_000;
  const SAFE_MODE_PREVIEW_CHAR_LIMIT = 50_000;

  function setDirty(next: boolean): void {
    if (dirty === next) return;
    dirty = next;
    if (onDirtyChange) {
      onDirtyChange(next);
    }
  }

  function emptyDoc(): PmNode {
    return schema.topNodeType.createAndFill()!;
  }

  function buildSafeModeDoc(md: string, reason: string): PmNode {
    const blocks: PmNode[] = [];
    blocks.push(
      schema.nodes.paragraph.create(
        null,
        schema.text(`Large document loaded in safe mode (${reason}) to prevent UI freezes.`),
      ),
    );

    const preview = md.slice(0, SAFE_MODE_PREVIEW_CHAR_LIMIT);
    if (preview) {
      blocks.push(schema.nodes.code_block.create({ params: 'plaintext' }, schema.text(preview)));
    }
    if (md.length > SAFE_MODE_PREVIEW_CHAR_LIMIT) {
      blocks.push(
        schema.nodes.paragraph.create(
          null,
          schema.text(`Preview truncated at ${SAFE_MODE_PREVIEW_CHAR_LIMIT.toLocaleString()} characters.`),
        ),
      );
    }
    return schema.topNodeType.create(null, blocks);
  }

  function parseMarkdownDoc(md: string, phase: 'initial' | 'update'): PmNode {
    if (md.length > LARGE_MARKDOWN_CHAR_LIMIT) {
      if (lastSafeModeLength !== md.length) {
        console.warn(
          `[attn] markdown too large for full ProseMirror parse: ${md.length} chars; `
          + `using safe mode`,
        );
        lastSafeModeLength = md.length;
      }
      return buildSafeModeDoc(md, 'size_limit');
    }

    if (lastSafeModeLength !== -1) {
      lastSafeModeLength = -1;
    }

    const start = performance.now();
    try {
      const doc = markdownParser.parse(md) ?? emptyDoc();
      const elapsed = performance.now() - start;
      if (elapsed > PARSE_WARN_MS) {
        console.warn(
          `[attn] slow markdown parse (${phase}): ${elapsed.toFixed(1)}ms `
          + `for ${md.length} chars`,
        );
      }
      return doc;
    } catch (error) {
      console.error('[attn] markdown parse failed; using safe mode', error);
      return buildSafeModeDoc(md, 'parse_error');
    }
  }

  function buildPlugins(md: string) {
    const plugins = [
      history(),
      search(),
    ];
    if (md.length <= LARGE_MARKDOWN_CHAR_LIMIT) {
      plugins.push(codeHighlightPlugin());
    }
    plugins.push(
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
        'Mod-f': () => {
          void openFindPanel();
          return true;
        },
        'Mod-g': () => {
          if (!findOpen) {
            void openFindPanel();
          } else {
            findNextMatch();
          }
          return true;
        },
        'Shift-Mod-g': () => {
          if (!findOpen) {
            void openFindPanel();
          } else {
            findPrevMatch();
          }
          return true;
        },
        'Mod-s': () => {
          if (onSave) onSave();
          return true;
        },
        'Escape': () => {
          if (onCancel) onCancel();
          return true;
        },
      }),
      keymap(baseKeymap),
    );
    return plugins;
  }

  // Custom NodeView for task_list_item — makes checkbox clickable
  function taskListItemNodeView(
    node: PmNode,
    editorView: EditorView,
    getPos: () => number | undefined,
  ): NodeView {
    const li = document.createElement('li');
    li.className = 'task-list-item';
    li.dataset.checked = node.attrs.checked ? 'true' : 'false';

    const checkboxWrap = document.createElement('span');
    checkboxWrap.className = 'task-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = node.attrs.checked;
    // Checkbox is always clickable (both read-only and edit mode)
    checkbox.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const tr = editorView.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        checked: !node.attrs.checked,
      });
      editorView.dispatch(tr);
      // Serialize and send via IPC after checkbox toggle
      const md = markdownSerializer.serialize(editorView.state.doc);
      editSave(md);
      if (onCheckboxToggle) {
        onCheckboxToggle(md);
      }
    });

    checkboxWrap.appendChild(checkbox);
    li.appendChild(checkboxWrap);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'task-content';
    li.appendChild(contentDiv);

    return {
      dom: li,
      contentDOM: contentDiv,
      update(updatedNode: PmNode) {
        if (updatedNode.type !== node.type) return false;
        node = updatedNode;
        checkbox.checked = node.attrs.checked;
        li.dataset.checked = node.attrs.checked ? 'true' : 'false';
        return true;
      },
    };
  }

  function createState(md: string): EditorState {
    const doc = parseMarkdownDoc(md, 'initial');
    return EditorState.create({
      doc,
      plugins: buildPlugins(md),
    });
  }

  function refreshMatchCount(): void {
    if (!view) {
      findMatchCount = 0;
      return;
    }
    findMatchCount = getMatchHighlights(view.state).find().length;
  }

  function updateSearchQuery(): void {
    if (!view) return;
    const query = new SearchQuery({ search: findQuery });
    view.dispatch(setSearchState(view.state.tr, query));
    refreshMatchCount();
  }

  function ensureSelectionVisible(): void {
    if (!view) return;

    const viewport = (
      view.dom.closest('[data-slot="scroll-area-viewport"]')
      ?? view.dom.closest('.attn-content-viewport')
    ) as HTMLElement | null;
    if (!viewport) return;

    const coords = view.coordsAtPos(view.state.selection.head, 1);
    const viewportRect = viewport.getBoundingClientRect();
    const topMargin = (findOpen ? (findBarEl?.offsetHeight ?? 0) + 16 : 24);
    const bottomMargin = 24;

    if (
      coords.top >= viewportRect.top + topMargin
      && coords.bottom <= viewportRect.bottom - bottomMargin
    ) {
      return;
    }

    const yInContent = coords.top - viewportRect.top + viewport.scrollTop;
    const centeredTop = Math.max(0, yInContent - viewport.clientHeight / 2);
    viewport.scrollTo({ top: centeredTop });
  }

  function findNextMatch(): void {
    if (!view || !findQuery.trim()) return;
    searchFindNext(view.state, view.dispatch, view);
    refreshMatchCount();
    requestAnimationFrame(ensureSelectionVisible);
  }

  function findPrevMatch(): void {
    if (!view || !findQuery.trim()) return;
    searchFindPrev(view.state, view.dispatch, view);
    refreshMatchCount();
    requestAnimationFrame(ensureSelectionVisible);
  }

  async function openFindPanel(): Promise<void> {
    if (!view) return;

    findOpen = true;

    const searchState = getSearchState(view.state);
    if (searchState) {
      findQuery = searchState.query.search;
    }

    if (!findQuery && !view.state.selection.empty) {
      const selected = view.state.doc.textBetween(
        view.state.selection.from,
        view.state.selection.to,
        ' ',
      ).trim();
      if (selected) {
        findQuery = selected;
      }
    }

    updateSearchQuery();
    await tick();
    findInputEl?.focus();
    findInputEl?.select();
  }

  function closeFindPanel(clearQuery = true): void {
    findOpen = false;
    if (!view) return;
    if (clearQuery) {
      findQuery = '';
      view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: '' })));
      findMatchCount = 0;
    }
  }

  function handleFindSubmit(e: SubmitEvent): void {
    e.preventDefault();
    findNextMatch();
  }

  function handleFindKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFindPanel();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevMatch();
      } else {
        findNextMatch();
      }
    }
  }

  function handleEditorClick(event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return false;

    // In edit mode, require Cmd/Ctrl+click so cursor placement still works.
    if (editable && !(event.metaKey || event.ctrlKey)) {
      return false;
    }

    const href = anchor.getAttribute('href')?.trim();
    if (!href) return false;
    event.preventDefault();
    if (onLinkNavigate) {
      onLinkNavigate(href);
      return true;
    }
    return false;
  }

  export function getMarkdown(): string {
    if (!view) return markdown;
    return markdownSerializer.serialize(view.state.doc);
  }

  export function hasUnsavedChanges(): boolean {
    return dirty;
  }

  export function resetToMarkdown(nextMarkdown: string): void {
    if (!view) return;
    const updateStart = performance.now();
    const updateDoc = parseMarkdownDoc(nextMarkdown, 'update');
    const state = EditorState.create({
      doc: updateDoc,
      plugins: buildPlugins(nextMarkdown),
    });
    console.info(`[attn] pm update done in ${(performance.now() - updateStart).toFixed(1)}ms`);
    view.updateState(state);
    if (findOpen && findQuery) {
      updateSearchQuery();
    }
    lastMarkdown = nextMarkdown;
    setDirty(false);
  }

  export function openFind(): void {
    void openFindPanel();
  }

  // Create EditorView on mount
  $effect(() => {
    if (!editorEl) return;
    const state = createState(markdown);
    view = new EditorView(editorEl, {
      state,
      editable: () => editable,
      handleDOMEvents: {
        click: (_view, event) => handleEditorClick(event as MouseEvent),
      },
      dispatchTransaction(tr) {
        if (!view) return;
        const nextState = view.state.apply(tr);
        view.updateState(nextState);
        if (tr.docChanged && editable) {
          setDirty(true);
        }
      },
      nodeViews: {
        task_list_item: taskListItemNodeView,
        code_block(node, editorView, getPos) {
          const mermaid = mermaidNodeView(node, editorView, getPos);
          if (mermaid) return mermaid;
          const math = mathNodeView(node, editorView, getPos);
          if (math) return math;
          return codeBlockNodeView(node, editorView, getPos);
        },
      },
    });
    lastMarkdown = markdown;
    setDirty(false);

    return () => {
      view?.destroy();
      view = undefined;
    };
  });

  // React to markdown prop changes (from outside, e.g. file watcher updates)
  $effect(() => {
    if (!view) return;
    // Only update if the markdown actually changed from what we last set
    if (markdown === lastMarkdown) return;
    resetToMarkdown(markdown);
  });

  // React to editable changes
  $effect(() => {
    if (view) {
      view.setProps({ editable: () => editable });
    }
  });
</script>

<div class="editor-container">
  {#if findOpen}
    <form bind:this={findBarEl} class="pm-find-bar" onsubmit={handleFindSubmit}>
      <input
        bind:this={findInputEl}
        bind:value={findQuery}
        class="pm-find-input"
        type="text"
        placeholder="Find in document..."
        oninput={updateSearchQuery}
        onkeydown={handleFindKeydown}
      />
      <span class="pm-find-count">
        {#if findQuery}
          {#if findMatchCount === 0}
            No matches
          {:else}
            {findMatchCount} match{findMatchCount === 1 ? '' : 'es'}
          {/if}
        {/if}
      </span>
      <button type="button" class="pm-find-btn" aria-label="Previous match" onclick={findPrevMatch}>↑</button>
      <button type="submit" class="pm-find-btn" aria-label="Next match">↓</button>
      <button type="button" class="pm-find-btn" aria-label="Close find" onclick={() => closeFindPanel()}>✕</button>
    </form>
  {/if}
  <div bind:this={editorEl} class="prosemirror-mount"></div>
</div>
