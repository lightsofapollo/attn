<!--
  Comment composer popover (attn-nnj.4.4).

  Opens when the user hits Cmd/Ctrl+. with a non-empty ProseMirror selection
  (the keyboard hook is `onCommentComposer`, wired in App.svelte via
  keyboard.ts §12.9). The popover is positioned next to the selection via
  `popover-anchor.ts` (12.8) and shows a preview of the quoted text plus a
  textarea for the comment body.

  Submit path:
    1. Re-derive the 5-layer Anchor via `anchorFromSelection` against the
       *captured* selection range and the *captured* AnchorIndex / snapshot
       context — the editor selection may have moved by submit time, so we
       freeze both at open() time.
    2. Send `reviewCreateComment` IPC for the active room.
    3. Close.

  Cancel path: close without IPC. Esc and click-outside both cancel.

  Note: this component DOES NOT touch reviewStore.events itself — Rust echoes
  the persisted event back via `window.__attn__.reviewEvent`, so the local
  store reflects the new thread once the round-trip completes.
-->

<script lang="ts">
  import type { EditorView } from 'prosemirror-view';
  import { anchorFromSelection, type ConstructAnchorContext } from './review/anchors';
  import { getPopoverAnchor, type PopoverAnchor } from './review/popover-anchor';
  import { reviewCreateComment } from './ipc';
  import type { RoomId } from './types';

  /**
   * Open-state snapshot captured at the moment the composer was triggered.
   * The selection range and anchor context are frozen here so submit always
   * targets the original quote even if the user clicks elsewhere in the
   * editor while typing.
   */
  interface OpenState {
    view: EditorView;
    from: number;
    to: number;
    quote: string;
    ctx: ConstructAnchorContext;
    roomId: RoomId;
    anchorPos: PopoverAnchor;
  }

  let openState: OpenState | null = $state(null);
  let body = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  /**
   * Open the composer against the current PM selection. The caller (App.svelte
   * via the keyboard hook) is responsible for checking `view.state.selection.empty`
   * before invoking — empty selections must not produce a composer.
   */
  export function open(params: {
    view: EditorView;
    ctx: ConstructAnchorContext;
    roomId: RoomId;
  }): void {
    const { view, ctx, roomId } = params;
    const sel = view.state.selection;
    if (sel.empty) return;
    const from = sel.from;
    const to = sel.to;

    // Capture the quoted text now — same separators `anchors.ts` uses for the
    // quote layer, so the preview matches the persisted `quote.exact`.
    const quote = view.state.doc.textBetween(from, to, '\n', '​');
    const anchorPos = getPopoverAnchor(view, from, to);

    openState = { view, from, to, quote, ctx, roomId, anchorPos };
    body = '';

    // Focus on next microtask so the textarea exists in the DOM.
    queueMicrotask(() => textareaEl?.focus());
  }

  /** Close the composer without emitting any IPC. */
  export function close(): void {
    openState = null;
    body = '';
  }

  /** True while the composer popover is mounted. */
  export function isOpen(): boolean {
    return openState !== null;
  }

  async function handleSubmit(): Promise<void> {
    const s = openState;
    if (!s) return;
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    const anchor = anchorFromSelection(s.view, s.from, s.to, s.ctx);
    await reviewCreateComment(s.roomId, anchor, trimmed);
    close();
  }

  function handleCancel(): void {
    close();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
      return;
    }
    // Cmd/Ctrl+Enter submits — convenience binding that does not conflict
    // with the textarea's native Enter (newline) behavior.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
    }
  }
</script>

{#if openState}
  <div
    class="comment-composer-backdrop fixed inset-0 z-40"
    data-slot="comment-composer-backdrop"
    onmousedown={handleCancel}
    role="presentation"
  ></div>
  <div
    class="comment-composer fixed z-50 flex w-[320px] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-sm shadow-lg"
    data-slot="comment-composer"
    data-side={openState.anchorPos.recommendedPosition.side}
    style="top: {openState.anchorPos.recommendedPosition.top}px; left: {openState.anchorPos.recommendedPosition.left}px;"
    role="dialog"
    aria-label="Add comment"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <div
      class="comment-composer-quote max-h-20 overflow-hidden border-l-2 border-primary/60 bg-muted/30 px-2 py-1 text-xs italic text-muted-foreground"
      data-slot="comment-composer-quote"
    >
      {openState.quote}
    </div>
    <textarea
      bind:this={textareaEl}
      bind:value={body}
      class="comment-composer-body min-h-[72px] w-full resize-y rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      data-slot="comment-composer-body"
      placeholder="Write a comment…"
      rows="3"
    ></textarea>
    <div class="comment-composer-actions flex justify-end gap-2">
      <button
        type="button"
        class="comment-composer-cancel rounded border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
        data-slot="comment-composer-cancel"
        onclick={handleCancel}
      >Cancel</button>
      <button
        type="button"
        class="comment-composer-submit rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        data-slot="comment-composer-submit"
        disabled={body.trim().length === 0}
        onclick={() => { void handleSubmit(); }}
      >Submit</button>
    </div>
  </div>
{/if}
