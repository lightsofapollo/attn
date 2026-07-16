<script lang="ts">
  import { EditorState, Plugin, TextSelection, type Command } from 'prosemirror-state';
  import { EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
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
  import { tick, untrack } from 'svelte';
  import { keymap } from 'prosemirror-keymap';
  import { baseKeymap, chainCommands, selectAll, setBlockType, toggleMark } from 'prosemirror-commands';
  import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
  import { history, redo, undo } from 'prosemirror-history';
  import { collab } from 'prosemirror-collab';
  import { remoteCursorsPlugin } from './prosemirror/remote-cursors';
  import { codeHighlightPlugin } from './prosemirror/code-highlight';
  import { codeBlockNodeView } from './prosemirror/code-block-nodeview';
  import { frontmatterNodeView } from './prosemirror/frontmatter-nodeview';
  import { markdownInputRules } from './prosemirror/markdown-input-rules';
  import { placeholderPlugin } from './prosemirror/placeholder';
  import { mathNodeView } from './prosemirror/math';
  import { mermaidNodeView } from './prosemirror/mermaid-nodeview';
  import { tablePlugins } from './prosemirror/tables';
  import { recordReviewSelectionDebug } from './review/selection-debug';
  import { editSave } from './ipc';
  import { markdownParser, markdownSerializer, schema } from './schema';
  import {
    suggestChanges,
    suggestChangesKey,
    isSuggestChangesEnabled,
    enableSuggestChanges,
    disableSuggestChanges,
    transformToSuggestionTransaction,
    revertSuggestions,
  } from '@handlewithcare/prosemirror-suggest-changes';

  interface Props {
    markdown: string;
    editable?: boolean;
    /** Hint shown over a truly-empty document (gate-35). */
    placeholder?: string;
    onSave?: () => void;
    onCancel?: () => void;
    onLinkNavigate?: (href: string) => void;
    /**
     * Fired on every editor click with the clicked suggestion's id (read off the
     * `<ins/del data-id>` element), or `null` when the click wasn't on a
     * suggestion. The owner uses it to show/hide the accept/reject popover
     * (attn-07i.2 Phase 2).
     */
    onSuggestionClick?: (id: string | null) => void;
    onCheckboxToggle?: (md: string) => void;
    onDirtyChange?: (dirty: boolean) => void;
    /**
     * Extra ProseMirror plugins appended AFTER the built-in plugins.
     * Built-ins (history, search, code-highlight, tables, keymaps) load first
     * so injected plugins can see their decorations and state.
     */
    plugins?: Plugin[];
    /**
     * Extra nodeViews merged on top of the built-in nodeViews. Injected
     * entries win on key collision so callers can override built-ins.
     */
    nodeViews?: Record<string, NodeViewConstructor>;
    /**
     * Invoked once the underlying `EditorView` is mounted (and again after a
     * full re-mount). Callers use this to dispatch their own meta-only
     * transactions — e.g. the review-decorations plugin host watches store
     * mutations and pokes the view to rebuild its `DecorationSet`. The
     * returned `EditorView` reference must NOT be retained past the
     * companion `onTeardown` notification (provided via the `view` arg's
     * `destroy` lifecycle inside this component).
     */
    onReady?: (view: EditorView) => void;
    /**
     * When set, the editor joins a live co-typing session: the
     * `prosemirror-collab` plugin is installed at version 0 with this client
     * id, and the editor STOPS resetting from the `markdown` prop (collab
     * steps become the source of truth). The parent seeds v0 by passing the
     * agreed shared-doc markdown and keeping it stable for the session.
     * `undefined` = normal markdown-driven editor (unchanged behavior).
     */
    collabClientId?: string;
    /**
     * Bumped by the parent to force a full editor RE-CREATE at the current
     * `markdown` + `collabClientId` — used to switch the live collab doc to a
     * different file (a folder share is N independently co-edited files). A
     * plugin reconfigure can't do this: `prosemirror-collab` keys its plugin
     * state by a shared PluginKey, so reconfiguring preserves the old doc +
     * version. Re-creating the view installs collab fresh at v0 on the new
     * file's base doc. Changing it is the ONLY thing besides `editorEl` that
     * tears down + rebuilds the view.
     */
    collabEpoch?: number;
    /**
     * Stable file identity for continuity across a same-file collab epoch
     * replacement. When unchanged, selection/focus/scroll survive the
     * required EditorView rebuild; a different key starts cleanly.
     */
    collabContinuityKey?: string;
    /** Fired after every local doc-changing transaction during a collab session. */
    onCollabDocChange?: () => void;
    /** Fired when the local selection (caret) moves during a collab session. */
    onCollabSelectionChange?: (head: number) => void;
    /**
     * Inline suggesting mode (attn-07i.2). When true, local edits are captured
     * as tracked-change suggestions (insertion/deletion marks) instead of
     * directly mutating the doc — reviewers suggest, the owner edits directly.
     */
    suggesting?: boolean;
    /**
     * The local author's display name, encoded into each suggestion's id so the
     * owner can attribute it (the marks themselves carry only an id).
     */
    suggestionAuthor?: string;
  }

  let {
    markdown,
    editable = false,
    placeholder = 'Start typing — # for a heading, ⌘K for commands',
    onSave,
    onCancel,
    onLinkNavigate,
    onSuggestionClick,
    onCheckboxToggle,
    onDirtyChange,
    plugins: extraPlugins,
    nodeViews: extraNodeViews,
    onReady,
    collabClientId,
    collabEpoch = 0,
    collabContinuityKey,
    onCollabDocChange,
    onCollabSelectionChange,
    suggesting = false,
    suggestionAuthor,
  }: Props = $props();

  // Suggestion ids encode the author (the marks carry only an id) so the owner
  // can show "suggested by <name>", and are random so they never collide across
  // peers (the library's default auto-increment ids would). The author is
  // URL-encoded so a `~` or space in the name can't break parsing on `~`.
  function generateSuggestionId(): string {
    const who = encodeURIComponent(suggestionAuthor ?? 'anon');
    const rand =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${who}~${rand}`;
  }

  // The on-disk file holds ACCEPTED content only: revert pending suggestion
  // marks on a throwaway transaction, then serialize, so the saved markdown
  // never contains insertion/deletion marks (a reviewer's pending suggestion
  // must not rewrite the owner's file — that was the original bug).
  function serializeAccepted(): string {
    if (!view) return '';
    let doc = view.state.doc;
    revertSuggestions(view.state, (tr) => {
      doc = tr.doc;
    });
    return markdownSerializer.serialize(doc);
  }
  let editorEl: HTMLElement | undefined = $state(undefined);
  let view: EditorView | undefined;
  let findOpen = $state(false);
  let findQuery = $state('');
  let findMatchCount = $state(0);
  let lastMarkdown = '';
  let dirty = false;
  let findInputEl: HTMLInputElement | undefined = $state(undefined);
  let findBarEl: HTMLFormElement | undefined = $state(undefined);
  // Reactive "the EditorView is mounted" signal so the suggesting-mode effect
  // below fires after mount (`view` itself is a plain let, not reactive).
  let viewReady = $state(false);

  let lastSafeModeLength = -1;
  const PARSE_WARN_MS = 120;
  const LARGE_MARKDOWN_CHAR_LIMIT = 350_000;
  const SAFE_MODE_PREVIEW_CHAR_LIMIT = 50_000;
  let pendingLocalSaveNormalized: string | null = null;

  interface CollabRemountContinuity {
    key: string;
    anchor: number;
    head: number;
    hadFocus: boolean;
    scroller: HTMLElement | null;
    scrollTop: number;
    scrollLeft: number;
    windowScrollX: number;
    windowScrollY: number;
  }

  let collabRemountContinuity: CollabRemountContinuity | null = null;

  function nearestScrollContainer(node: HTMLElement): HTMLElement | null {
    let parent = node.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|overlay)/u.test(style.overflowY + style.overflowX)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function restoreCollabRemountContinuity(
    editorView: EditorView,
    continuity: CollabRemountContinuity,
  ): void {
    const max = editorView.state.doc.content.size;
    const anchor = Math.max(0, Math.min(continuity.anchor, max));
    const head = Math.max(0, Math.min(continuity.head, max));
    try {
      const selection = TextSelection.between(
        editorView.state.doc.resolve(anchor),
        editorView.state.doc.resolve(head),
      );
      editorView.dispatch(editorView.state.tr.setSelection(selection));
      if (continuity.hadFocus) editorView.focus();
    } finally {
      // `EditorView.focus()` may ask the browser to reveal the new selection.
      // Restore the exact reading position after the replacement DOM exists.
      continuity.scroller?.scrollTo({
        top: continuity.scrollTop,
        left: continuity.scrollLeft,
        behavior: 'auto',
      });
      if (window.scrollX !== continuity.windowScrollX || window.scrollY !== continuity.windowScrollY) {
        window.scrollTo({
          left: continuity.windowScrollX,
          top: continuity.windowScrollY,
          behavior: 'auto',
        });
      }
    }
    recordReviewSelectionDebug('editor-remount-restored', {
      key: continuity.key.slice(0, 8),
      from: editorView.state.selection.from,
      to: editorView.state.selection.to,
      hadFocus: continuity.hadFocus,
      scrollTop: continuity.scrollTop,
    });
  }

  function normalizeMarkdownForCompare(md: string): string {
    return md
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n$/, '');
  }

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
      // Track-changes state (enabled per-role below). Harmless when disabled.
      suggestChanges(),
    ];
    // Live co-typing: install collab at v0 + a doc-change notifier. collab()
    // uses a module-shared PluginKey, so a `reconfigure` preserves its state
    // (version + unconfirmed steps) across plugin-list changes.
    if (collabClientId) {
      plugins.push(collab({ version: 0, clientID: collabClientId }));
      plugins.push(remoteCursorsPlugin());
      plugins.push(
        new Plugin({
          view: () => ({
            update: (v, prev) => {
              if (!v.state.doc.eq(prev.doc)) {
                onCollabDocChange?.();
              }
              if (!v.state.selection.eq(prev.selection)) {
                onCollabSelectionChange?.(v.state.selection.head);
              }
            },
          }),
        }),
      );
    }
    if (md.length <= LARGE_MARKDOWN_CHAR_LIMIT) {
      plugins.push(codeHighlightPlugin());
    }
    // Live markdown authoring (attn-vea): typed `# `, `- `, `**b**`, ``` etc.
    // become real nodes/marks, so the editor never shows literal syntax.
    plugins.push(markdownInputRules(schema));
    plugins.push(placeholderPlugin(placeholder));
    plugins.push(...tablePlugins());
    // List structure keys, ahead of baseKeymap so Enter reaches
    // splitListItem before splitBlock. Without this, Enter inside a list
    // splits the paragraph WITHIN the item — the list never continues, and
    // a retyped `- ` marker nests a fresh list one level down per line
    // (the attn-2zf staircase).
    const listKeys: Record<string, Command> = {};
    const itemTypes = [schema.nodes.list_item, schema.nodes.task_list_item].filter(
      (t): t is NonNullable<typeof t> => Boolean(t),
    );
    if (itemTypes.length > 0) {
      listKeys['Enter'] = chainCommands(...itemTypes.map((t) => splitListItem(t)));
      listKeys['Tab'] = chainCommands(...itemTypes.map((t) => sinkListItem(t)));
      listKeys['Shift-Tab'] = chainCommands(...itemTypes.map((t) => liftListItem(t)));
    }
    plugins.push(
      keymap(listKeys),
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
          if (view) {
            const current = serializeAccepted();
            pendingLocalSaveNormalized = normalizeMarkdownForCompare(current);
          }
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
    // Injected plugins from $props append AFTER built-ins so they observe
    // built-in decorations (e.g. review-decorations layered over code-highlight).
    if (extraPlugins && extraPlugins.length > 0) {
      plugins.push(...extraPlugins);
    }
    return plugins;
  }

  function buildNodeViews(): Record<string, NodeViewConstructor> {
    const builtIn: Record<string, NodeViewConstructor> = {
      task_list_item: taskListItemNodeView,
      frontmatter: (node) => frontmatterNodeView(node),
      code_block(node, editorView, getPos) {
        const mermaid = mermaidNodeView(node, editorView, getPos);
        if (mermaid) return mermaid;
        const math = mathNodeView(node, editorView, getPos);
        if (math) return math;
        return codeBlockNodeView(node, editorView, getPos);
      },
    };
    // Injected nodeViews win on key collision — caller can override built-ins.
    return extraNodeViews ? { ...builtIn, ...extraNodeViews } : builtIn;
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
    checkbox.disabled = !editable;
    checkbox.setAttribute('aria-disabled', String(!editable));
    // Keep the editor selection alive when the checkbox is clicked; the
    // toggle itself binds to `click` below so keyboard (Space) and AT
    // activation persist too — mousedown never fires for those, which
    // silently lost keyboard toggles to the next watcher reload (attn-6d2).
    checkbox.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    checkbox.addEventListener('click', () => {
      // Let the native toggle stand — every activation path (mouse, Space,
      // AT) fires `click` and flips `.checked`, so the pixels are already
      // correct. We must NOT preventDefault: a checkbox reverts its native
      // flip AFTER the handler when the default is cancelled, which clobbered
      // both the explicit set and update() (Truth Rule, attn-6d2). Instead we
      // dispatch a transaction to make the node attrs MATCH the DOM.
      if (!editable) {
        checkbox.checked = node.attrs.checked; // read-only: keep DOM in sync
        return;
      }
      const pos = getPos();
      if (pos === undefined) return;
      const next = checkbox.checked;
      const tr = editorView.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        checked: next,
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
    // Notify the parent of the clicked suggestion (read the id off the
    // <ins/del data-id> element — no coords needed, so it works under
    // automation), or null to dismiss the popover when clicking elsewhere.
    if (onSuggestionClick) {
      const sugEl = target?.closest('ins[data-id], del[data-id]') as HTMLElement | null;
      let id: string | null = null;
      if (sugEl?.dataset.id) {
        try {
          id = String(JSON.parse(sugEl.dataset.id));
        } catch {
          id = sugEl.dataset.id;
        }
      }
      onSuggestionClick(id);
    }
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

  function handleEditorKeydown(editorView: EditorView, event: KeyboardEvent): boolean {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta || event.altKey) return false;

    const key = event.key.toLowerCase();

    // Keep native clipboard operations unhandled by app-level logic.
    if (key === 'c' || key === 'v' || key === 'x') {
      return false;
    }

    // Ensure select-all is always available inside the editor surface.
    if (key === 'a' && !event.shiftKey) {
      return selectAll(editorView.state, editorView.dispatch, editorView);
    }

    return false;
  }

  export function getMarkdown(): string {
    if (!view) return markdown;
    // Accepted content only — pending suggestions are excluded from the file.
    return serializeAccepted();
  }

  export function hasUnsavedChanges(): boolean {
    return dirty;
  }

  export function resetToMarkdown(nextMarkdown: string): void {
    if (!view) return;
    const bookmark = view.state.selection.getBookmark();
    const updateDoc = parseMarkdownDoc(nextMarkdown, 'update');
    let state = EditorState.create({
      doc: updateDoc,
      plugins: buildPlugins(nextMarkdown),
    });
    try {
      const selection = bookmark.resolve(state.doc);
      state = state.apply(state.tr.setSelection(selection));
    } catch {
      // If previous selection can't be restored, keep default selection.
    }
    view.updateState(state);
    if (findOpen && findQuery) {
      updateSearchQuery();
    }
    lastMarkdown = nextMarkdown;
    setDirty(false);
  }

  export function commitSaved(): void {
    if (!view) return;
    lastMarkdown = serializeAccepted();
    setDirty(false);
  }

  export function undoStep(): void {
    if (!view) return;
    undo(view.state, view.dispatch, view);
  }

  export function redoStep(): void {
    if (!view) return;
    redo(view.state, view.dispatch, view);
  }

  export function openFind(): void {
    void openFindPanel();
  }

  // ————— touch formatting commands (attn-7xl.3.5) —————
  // Used by the mobile edit bar; each command keeps focus in the editor so
  // the iOS keyboard stays up.

  export function toggleBold(): void {
    if (!view) return;
    toggleMark(schema.marks.strong)(view.state, view.dispatch);
    view.focus();
  }

  export function toggleItalic(): void {
    if (!view) return;
    toggleMark(schema.marks.em)(view.state, view.dispatch);
    view.focus();
  }

  export function toggleHeading(level: number): void {
    if (!view) return;
    const cursor = view.state.selection.$from;
    const isSame =
      cursor.parent.type === schema.nodes.heading && cursor.parent.attrs.level === level;
    const command = isSame
      ? setBlockType(schema.nodes.paragraph)
      : setBlockType(schema.nodes.heading, { level });
    command(view.state, view.dispatch);
    view.focus();
  }

  export function toggleBulletList(): void {
    if (!view) return;
    const applied = wrapInList(schema.nodes.bullet_list)(view.state, view.dispatch);
    if (!applied) {
      liftListItem(schema.nodes.list_item)(view.state, view.dispatch);
    }
    view.focus();
  }

  // Create the EditorView ONCE, on mount. The only tracked dependency is
  // `editorEl`; every reactive read inside (markdown, buildPlugins →
  // extraPlugins/collabClientId, buildNodeViews → extraNodeViews) is wrapped in
  // `untrack` so a prop change can't destroy + recreate the whole view. That
  // recreate path used to fire on every review-decoration update — throwing
  // away the user's selection/scroll/undo and (during a live session) wiping
  // remote carets by re-running onReady. Subsequent changes are applied
  // in place by the dedicated reactors below: markdown → resetToMarkdown,
  // editable → setProps, plugins/nodeViews → reconfigure.
  $effect(() => {
    if (!editorEl) return;
    const el = editorEl;
    // Tracked: a `collabEpoch` bump forces a full teardown + rebuild so the
    // live collab session re-seeds at v0 on a different file's base doc.
    void collabEpoch;
    const continuityKey = collabContinuityKey;
    untrack(() => {
      const state = createState(markdown);
      view = new EditorView(el, {
        state,
        editable: () => editable,
        handleDOMEvents: {
          click: (_view, event) => handleEditorClick(event as MouseEvent),
          keydown: (editorView, event) => handleEditorKeydown(editorView, event as KeyboardEvent),
        },
        dispatchTransaction(tr) {
          if (!view) return;
          // Inline suggesting: when enabled (reviewers), convert a local user
          // edit into tracked-change marks instead of mutating the doc. Mirrors
          // the library's `withSuggestChanges` guard — never re-suggest remote
          // collab steps (`collab$`), undo/redo (`history$`), or the library's
          // own apply/revert transactions (`skip`).
          let applied = tr;
          if (
            tr.docChanged
            && isSuggestChangesEnabled(view.state)
            && !tr.getMeta('history$')
            && !tr.getMeta('collab$')
            && !('skip' in (tr.getMeta(suggestChangesKey) ?? {}))
          ) {
            // Only doc-changing edits become suggestions; selection/meta-only
            // transactions (e.g. setting the comment anchor) pass through, so
            // they don't get rewritten and lose their selection.
            applied = transformToSuggestionTransaction(tr, view.state, generateSuggestionId);
          }
          const nextState = view.state.apply(applied);
          view.updateState(nextState);
          if (applied.docChanged && editable) {
            setDirty(true);
          }
        },
        nodeViews: buildNodeViews(),
      });
      const continuity = collabRemountContinuity;
      collabRemountContinuity = null;
      if (view && continuityKey && continuity?.key === continuityKey) {
        restoreCollabRemountContinuity(view, continuity);
      }
      lastMarkdown = markdown;
      setDirty(false);
      if (onReady && view) {
        onReady(view);
      }
      viewReady = true;
      recordReviewSelectionDebug('editor-ready', {
        epoch: collabEpoch,
        key: continuityKey?.slice(0, 8) ?? null,
        from: view?.state.selection.from ?? null,
        to: view?.state.selection.to ?? null,
      });
    });

    return () => {
      viewReady = false;
      const retiringView = view;
      if (retiringView && continuityKey) {
        const scroller = nearestScrollContainer(retiringView.dom);
        collabRemountContinuity = {
          key: continuityKey,
          anchor: retiringView.state.selection.anchor,
          head: retiringView.state.selection.head,
          hadFocus: retiringView.hasFocus(),
          scroller,
          scrollTop: scroller?.scrollTop ?? 0,
          scrollLeft: scroller?.scrollLeft ?? 0,
          windowScrollX: window.scrollX,
          windowScrollY: window.scrollY,
        };
      }
      recordReviewSelectionDebug('editor-teardown', {
        epoch: collabEpoch,
        key: continuityKey?.slice(0, 8) ?? null,
        from: retiringView?.state.selection.from ?? null,
        to: retiringView?.state.selection.to ?? null,
      });
      retiringView?.destroy();
      if (view === retiringView) view = undefined;
    };
  });

  // Sync suggesting mode with the `suggesting` prop: reviewers suggest (tracked
  // changes), the owner edits directly. Re-runs when the role resolves (the
  // prop flips) or after a remount (`viewReady`).
  $effect(() => {
    const want = suggesting;
    if (!viewReady || !view) return;
    const enabled = isSuggestChangesEnabled(view.state);
    const dispatch = (tr: import('prosemirror-state').Transaction) => view?.dispatch(tr);
    if (want && !enabled) {
      enableSuggestChanges(view.state, dispatch);
    } else if (!want && enabled) {
      disableSuggestChanges(view.state, dispatch);
    }
  });

  // React to markdown prop changes (from outside, e.g. file watcher updates)
  $effect(() => {
    if (!view) return;
    // During a live collab session the collab steps are the source of truth —
    // ignore external markdown updates so a snapshot republish / file-watcher
    // tick can't clobber the live document.
    if (collabClientId) return;
    // Only update if the markdown actually changed from what we last set
    if (markdown === lastMarkdown) return;
    const normalizedIncoming = normalizeMarkdownForCompare(markdown);
    if (pendingLocalSaveNormalized && normalizedIncoming === pendingLocalSaveNormalized) {
      pendingLocalSaveNormalized = null;
      lastMarkdown = markdown;
      setDirty(false);
      return;
    }
    // Preserve undo history/cursor when incoming text is effectively the same
    // content we already have in the editor (common after save/watcher round-trip).
    const currentMarkdown = serializeAccepted();
    if (normalizeMarkdownForCompare(currentMarkdown) === normalizedIncoming) {
      lastMarkdown = markdown;
      setDirty(false);
      return;
    }
    resetToMarkdown(markdown);
  });

  // React to editable changes
  $effect(() => {
    if (view) {
      view.setProps({ editable: () => editable });
      for (const checkbox of view.dom.querySelectorAll<HTMLInputElement>(
        '.task-checkbox input[type="checkbox"]',
      )) {
        checkbox.disabled = !editable;
        checkbox.setAttribute('aria-disabled', String(!editable));
      }
    }
  });

  // React to injected plugins/nodeViews changing at runtime. Built-ins always
  // load first via buildPlugins(); nodeViews via buildNodeViews().
  $effect(() => {
    // Touch the reactive props so Svelte tracks them.
    void extraPlugins;
    void extraNodeViews;
    if (!view) return;
    const nextState = view.state.reconfigure({ plugins: buildPlugins(lastMarkdown) });
    view.updateState(nextState);
    view.setProps({ nodeViews: buildNodeViews() });
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
