<!--
  Comment composer popover (attn-nnj.4.4). Mounted by App.svelte when the
  user hits Cmd/Ctrl+. with a non-empty selection. Receives view + from/to
  + anchorContext + roomId as props and handles submit/cancel internally;
  parent unmounts via onClose to close. Matches the SuggestionComposer
  shape so App.svelte wires both consistently.
-->

<script lang="ts">
  import type { EditorView } from 'prosemirror-view';
  import { anchorFromSelection, type ConstructAnchorContext } from './review/anchors';
  import { shouldSubmitOnEnter } from './review/composer-keys';
  import { getPopoverAnchor, type PopoverAnchor } from './review/popover-anchor';
  import { reviewCreateComment } from './ipc';
  import type { RoomId } from './types';

  interface Props {
    view: EditorView;
    from: number;
    to: number;
    anchorContext: ConstructAnchorContext;
    roomId: RoomId;
    onClose: () => void;
    /** Fired on SUCCESSFUL submit, before onClose (attn-2aj). The parent
     *  collapses the editor selection here so the selection toolbar does
     *  not resurrect over the just-commented text — cancel paths keep the
     *  selection so the user can retry or pick Suggest instead. */
    onSubmitted?: () => void;
  }

  const { view, from, to, anchorContext, roomId, onClose, onSubmitted }: Props = $props();

  const quote = $derived(view.state.doc.textBetween(from, to, '\n', '​'));
  const anchorPos = $derived<PopoverAnchor>(getPopoverAnchor(view, from, to));

  let body = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  $effect(() => {
    queueMicrotask(() => textareaEl?.focus());
  });

  // In-flight guard: the await is a no-op today (fire-and-forget IPC) but
  // spans a daemon round-trip once acks land — double-tapped Enter or a
  // double-clicked Submit must not duplicate the comment.
  let submitting = $state(false);

  async function handleSubmit(): Promise<void> {
    if (submitting) return;
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    submitting = true;
    try {
      const anchor = anchorFromSelection(view, from, to, anchorContext);
      await reviewCreateComment(roomId, anchor, trimmed);
      onSubmitted?.();
      onClose();
    } finally {
      submitting = false;
    }
  }

  function handleCancel(): void {
    onClose();
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Keys belonging to an in-flight IME composition (e.g. Escape closing
    // the candidate list) are the IME's, not ours.
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
      return;
    }
    // Cmd/Ctrl+Enter submits from anywhere in the dialog (buttons
    // included) — parity with SuggestionComposer. The textarea's own
    // handler stopPropagation()s, so this never double-fires.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
    }
  }

  // Enter submits, Shift+Enter inserts a newline (attn-2aj). Attached to
  // the textarea itself (not the dialog wrapper) so it can't swallow Enter
  // aimed at the buttons.
  function handleBodyKeydown(e: KeyboardEvent): void {
    if (shouldSubmitOnEnter(e)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
    }
  }
</script>

<div
  class="comment-composer-backdrop fixed inset-0 z-40"
  role="presentation"
  onclick={handleCancel}
></div>

<div
  class="comment-composer absolute z-50 w-[360px] rounded border bg-popover p-3 shadow-lg"
  style="top: {anchorPos.recommendedPosition.top}px; left: {anchorPos.recommendedPosition.left}px"
  role="dialog"
  tabindex="-1"
  aria-label="Comment composer"
  onkeydown={handleKeydown}
>
  <div class="text-xs text-muted-foreground mb-2 italic truncate" title={quote}>
    "{quote}"
  </div>
  <textarea
    bind:this={textareaEl}
    bind:value={body}
    rows={4}
    class="w-full resize-none rounded border bg-background p-2 text-sm focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50"
    placeholder="Add a comment&hellip;"
    onkeydown={handleBodyKeydown}
  ></textarea>
  <div class="flex justify-end gap-2 mt-2">
    <button
      type="button"
      onclick={handleCancel}
      class="px-3 py-1 text-sm rounded border bg-background hover:bg-muted"
    >
      Cancel
    </button>
    <button
      type="button"
      onclick={handleSubmit}
      disabled={submitting || body.trim().length === 0}
      class="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
    >
      Submit
    </button>
  </div>
</div>
