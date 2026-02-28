<script lang="ts">
  import { EditorState, type Transaction } from 'prosemirror-state';
  import { EditorView, type NodeView } from 'prosemirror-view';
  import type { Node as PmNode } from 'prosemirror-model';
  import { markdownParser, markdownSerializer, schema } from './schema';
  import { keymap } from 'prosemirror-keymap';
  import { baseKeymap } from 'prosemirror-commands';
  import { history, undo, redo } from 'prosemirror-history';
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
  import { codeHighlightPlugin } from './prosemirror/code-highlight';
  import { editSave } from './ipc';

  interface Props {
    markdown: string;
    editable?: boolean;
    onSave?: () => void;
    onCancel?: () => void;
    onCheckboxToggle?: (md: string) => void;
  }

  let { markdown, editable = false, onSave, onCancel, onCheckboxToggle }: Props = $props();
  let editorEl: HTMLElement | undefined = $state(undefined);
  let view: EditorView | undefined;
  let findOpen = $state(false);
  let findQuery = $state('');
  let findMatchCount = $state(0);
  let findInputEl: HTMLInputElement | undefined = $state(undefined);
  let findBarEl: HTMLFormElement | undefined = $state(undefined);

  // Track the last markdown we set, to avoid re-parsing when we already have it
  let lastMarkdown = '';
  let lastSafeModeLength = -1;
  const PARSE_WARN_MS = 120;
  const LARGE_MARKDOWN_CHAR_LIMIT = 350_000;
  const SAFE_MODE_PREVIEW_CHAR_LIMIT = 50_000;

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
        'Mod-s': (_state: EditorState, _dispatch?: (tr: Transaction) => void) => {
          if (onSave) onSave();
          return true;
        },
        'Escape': (_state: EditorState, _dispatch?: (tr: Transaction) => void) => {
          if (onCancel) onCancel();
          return true;
        },
      }),
      keymap(baseKeymap),
    );
    return plugins;
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

    // ProseMirror's scrollIntoView depends on DOM selection being in the editor.
    // When focus is in the find input, we still want matches to jump in our viewport.
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

    // Prefer current search query from plugin state if available.
    const searchState = getSearchState(view.state);
    if (searchState) {
      findQuery = searchState.query.search;
    }

    // Seed from selection on first open.
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
      if (onCheckboxToggle) onCheckboxToggle(md);
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

  // Create EditorView on mount
  $effect(() => {
    if (!editorEl) return;
    const mountStart = performance.now();
    console.info(`[attn] pm mount start chars=${markdown.length}`);
    lastMarkdown = markdown;
    const state = createState(markdown);
    view = new EditorView(editorEl, {
      state,
      editable: () => editable,
      nodeViews: {
        task_list_item: taskListItemNodeView,
      },
    });
    console.info(`[attn] pm mount done in ${(performance.now() - mountStart).toFixed(1)}ms`);
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
    const updateStart = performance.now();
    console.info(`[attn] pm update start chars=${markdown.length}`);
    lastMarkdown = markdown;
    const doc = parseMarkdownDoc(markdown, 'update');
    const state = EditorState.create({
      doc,
      plugins: buildPlugins(markdown),
    });
    view.updateState(state);
    console.info(`[attn] pm update done in ${(performance.now() - updateStart).toFixed(1)}ms`);
    if (findOpen && findQuery) {
      updateSearchQuery();
    }
  });

  // React to editable changes
  $effect(() => {
    if (view) {
      view.setProps({ editable: () => editable });
    }
  });

  export function getMarkdown(): string {
    if (!view) return markdown;
    return markdownSerializer.serialize(view.state.doc);
  }

  export function openFind(): void {
    void openFindPanel();
  }
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
