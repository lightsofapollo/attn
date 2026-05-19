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
  }

  const { view, from, to, anchorContext, roomId, onClose }: Props = $props();

  const quote = $derived(view.state.doc.textBetween(from, to, '\n', '​'));
  const anchorPos = $derived<PopoverAnchor>(getPopoverAnchor(view, from, to));

  let body = $state('');
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  $effect(() => {
    queueMicrotask(() => textareaEl?.focus());
  });

  async function handleSubmit(): Promise<void> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    const anchor = anchorFromSelection(view, from, to, anchorContext);
    await reviewCreateComment(roomId, anchor, trimmed);
    onClose();
  }

  function handleCancel(): void {
    onClose();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
  aria-label="Comment composer"
  onkeydown={handleKeydown}
>
  <div class="text-xs text-muted-foreground mb-2 italic truncate" title={quote}>
    "{quote}"
  </div>
  <textarea
    bind:this={textareaEl}
    bind:value={body}
    class="w-full min-h-[80px] rounded border bg-background p-2 text-sm"
    placeholder="Add a comment&hellip;"
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
      disabled={body.trim().length === 0}
      class="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
    >
      Submit
    </button>
  </div>
</div>
