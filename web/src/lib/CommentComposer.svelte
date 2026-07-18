<!--
  Comment composer popover (attn-nnj.4.4). Mounted by App.svelte when the
  user hits Cmd/Ctrl+. with a non-empty selection. Receives view + from/to
  + anchorContext + roomId as props and handles submit/cancel internally;
  parent unmounts via onClose to close. Matches the SuggestionComposer
  shape so App.svelte wires both consistently.
-->

<script lang="ts" module>
  let commentDraftCache: { key: string; body: string } | null = null;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import { anchorFromSelection, type ConstructAnchorContext } from './review/anchors';
  import { shouldSubmitOnEnter } from './review/composer-keys';
  import { createAnchorTracker } from './review/popover-anchor.svelte';
  import { reviewCreateComment } from './ipc';
  import type { Anchor, RoomId } from './types';

  interface Props {
    view: EditorView;
    from: number;
    to: number;
    anchorContext: ConstructAnchorContext;
    roomId: RoomId;
    /** Hosted transport injection. Native callers omit this and use IPC. */
    onCreateComment?: (anchor: Anchor, body: string) => Promise<void> | void;
    onClose: () => void;
    /** Fired on SUCCESSFUL submit, before onClose (attn-2aj). The parent
     *  collapses the editor selection here so the selection toolbar does
     *  not resurrect over the just-commented text — cancel paths keep the
     *  selection so the user can retry or pick Suggest instead. */
    onSubmitted?: () => void;
  }

  const {
    view,
    from,
    to,
    anchorContext,
    roomId,
    onCreateComment,
    onClose,
    onSubmitted,
  }: Props = $props();

  const quote = $derived(view.state.doc.textBetween(from, to, '\n', '​'));
  // Tracks the selection through scroll; listener lives only while the
  // composer is mounted (attn-5bq).
  const anchorTracker = createAnchorTracker(() => view, () => from, () => to);
  const anchorPos = $derived(anchorTracker.current);

  const draftKey = $derived(`${roomId}:${from}:${to}`);
  // Intentional open-time restore: props are fixed for this mount.
  let body = $state(
    untrack(() =>
      commentDraftCache?.key === `${roomId}:${from}:${to}` ? commentDraftCache.body : '',
    ),
  );
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  // Escape/outside-click keep the draft; Cancel and submit clear it
  // (the Topmost-Escape rule, attn-5bq).
  $effect(() => {
    commentDraftCache = { key: draftKey, body };
  });

  $effect(() => {
    queueMicrotask(() => textareaEl?.focus({ preventScroll: true }));
  });

  // In-flight guard: the await is a no-op today (fire-and-forget IPC) but
  // spans a daemon round-trip once acks land — double-tapped Enter or a
  // double-clicked Submit must not duplicate the comment.
  let submitting = $state(false);
  let submitError = $state<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (submitting) return;
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    submitting = true;
    submitError = null;
    try {
      const anchor = anchorFromSelection(view, from, to, anchorContext);
      if (onCreateComment) await onCreateComment(anchor, trimmed);
      else await reviewCreateComment(roomId, anchor, trimmed);
      commentDraftCache = null;
      onSubmitted?.();
      onClose();
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Could not send comment';
    } finally {
      submitting = false;
    }
  }

  function handleCancel(): void {
    // Explicit Cancel discards the draft; Escape (below) preserves it.
    commentDraftCache = null;
    onClose();
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Keys belonging to an in-flight IME composition (e.g. Escape closing
    // the candidate list) are the IME's, not ours.
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Close without discarding: the draft cache restores on reopen
      // (Topmost-Escape rule).
      onClose();
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
  {#if submitError}
    <p class="mt-2 text-xs text-destructive" role="alert" data-slot="comment-composer-error">
      {submitError}
    </p>
  {/if}
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
