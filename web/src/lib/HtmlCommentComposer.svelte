<!--
  HtmlCommentComposer — the comment composer for a rendered HTML document.

  A sibling of `CommentComposer.svelte` rather than a variant of it. That one
  is built around a ProseMirror view: it derives the quote via
  `doc.textBetween`, tracks the anchor through scroll with `coordsAtPos`, and
  builds the `Anchor` itself from the live selection. None of that exists here
  — the document lives in a cross-origin frame whose DOM the shell cannot
  touch, so the *frame* proposes the anchor and reports the geometry, and this
  component simply presents them.

  Keeping the two apart is deliberate: it leaves the markdown authoring path
  untouched, which is the path everything else in review depends on.

  The proposal arriving here is untrusted input from the document frame
  (amendments.md #20). The user types the body in this shell-owned surface and
  submits from here — the frame can never author a comment on their behalf.

  @see planning/collab/html-annotation.md §3, §5
-->
<script lang="ts">
  import { shouldSubmitOnEnter } from './review/composer-keys';
  import type { AnchorProposal } from './review/doc-protocol';
  import type { Anchor, ContentHash, FileId, SnapshotId } from './types';

  interface Props {
    /** Anchor + quote proposed by the document frame. */
    proposal: AnchorProposal;
    /** Where to float the composer, in shell viewport coordinates. */
    position: { top: number; left: number };
    fileId: FileId;
    snapshotId: SnapshotId;
    baseHash: ContentHash;
    onCreateComment: (anchor: Anchor, body: string) => Promise<void> | void;
    onClose: () => void;
    onSubmitted?: () => void;
  }

  const {
    proposal,
    position,
    fileId,
    snapshotId,
    baseHash,
    onCreateComment,
    onClose,
    onSubmitted,
  }: Props = $props();

  let body = $state('');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

  $effect(() => {
    textareaEl?.focus();
  });

  const quote = $derived(proposal.quote.trim() || proposal.html.context.scopePreview);

  /**
   * Assemble the wire `Anchor` from the frame's proposal.
   *
   * `position` carries rendered-text offsets rather than markdown source
   * offsets, and `lineRange` is meaningless for HTML — both are documented in
   * html-annotation.md §6, and Rust never interprets either for HTML. `quote`
   * and `context` are reused verbatim because they are plain strings with no
   * markdown semantics, which is what lets the rail render an HTML thread
   * exactly like a markdown one.
   */
  function buildAnchor(): Anchor {
    return {
      v: 2,
      fileId,
      snapshotId,
      baseHash,
      position: {
        byteRange: [proposal.textStart, proposal.textEnd],
        lineRange: [0, 0],
      },
      quote: {
        exact: proposal.quote,
        exactHash: '',
        normalized: proposal.quote.replace(/\s+/g, ' ').trim(),
        normalizedHash: '',
      },
      context: {
        prefix: proposal.prefix,
        suffix: proposal.suffix,
        prefixHash: '',
        suffixHash: '',
      },
      html: proposal.html,
    };
  }

  async function handleSubmit(): Promise<void> {
    if (submitting || body.trim().length === 0) return;
    submitting = true;
    submitError = null;
    try {
      await onCreateComment(buildAnchor(), body.trim());
      onSubmitted?.();
      onClose();
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }

  function handleCancel(): void {
    onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
    }
  }

  function handleBodyKeydown(event: KeyboardEvent): void {
    if (shouldSubmitOnEnter(event)) {
      event.preventDefault();
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
  style="top: {position.top}px; left: {position.left}px"
  role="dialog"
  tabindex="-1"
  aria-label="Comment composer"
  data-slot="html-comment-composer"
  onkeydown={handleKeydown}
>
  <div class="text-xs text-muted-foreground mb-2 italic truncate" title={quote}>
    {#if proposal.html.target === 'element'}
      {proposal.html.context.scopePreview || proposal.html.context.tagName}
    {:else}
      "{quote}"
    {/if}
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
