<!--
  Floating selection toolbar (attn-bit). Appears above a non-empty text
  selection inside a review room and offers discoverable Comment / Suggest
  actions — previously these were keyboard-only (Cmd/Ctrl+. and
  Cmd/Ctrl+Shift+.), which made commenting effectively undiscoverable.

  Mounted by App.svelte while a selection that can be reviewed is active.
  Buttons call back into the SAME openCommentComposer / openSuggestionComposer
  paths the shortcuts use, so behaviour is identical. We `preventDefault` on
  mousedown so clicking a button never collapses the editor selection (the
  composer reads `view.state.selection` when it opens).

  UNAVAILABLE STATES (attn-64iy.2). Suppressing this toolbar whenever composing
  is impossible — App clearing `toolbarSelection` when no snapshot resolves —
  means a user in a room highlights text and nothing appears at all, which from
  outside is indistinguishable from a broken build. So it renders whenever there
  is a review context and says what the state is: `pending` reads as a wait (it
  resolves itself), `blocked` reads as a refusal with its reason. Only `absent`
  — no room at all — keeps it off screen, and there the affordance genuinely
  does not exist.
-->

<script lang="ts">
  import type { EditorView } from 'prosemirror-view';
  import { createAnchorTracker } from './review/popover-anchor.svelte';
  import type { ComposeAvailability } from './review/compose-availability';

  interface Props {
    view: EditorView;
    from: number;
    to: number;
    onComment: () => void;
    onSuggest: () => void;
    canSuggest?: boolean;
    /** Why commenting is / is not possible. Defaults to ready for callers
     *  (tests, alternative shells) that do not model availability. */
    comment?: ComposeAvailability;
    /** Why suggesting is / is not possible. */
    suggest?: ComposeAvailability;
  }

  const {
    view,
    from,
    to,
    onComment,
    onSuggest,
    canSuggest = true,
    comment = { status: 'ready' },
    suggest = { status: 'ready' },
  }: Props = $props();

  // The bar grows a reason line when either action is unavailable, so the
  // tracker needs the taller box or the popover would overlap its own text.
  const reason = $derived(
    comment.status === 'pending' || comment.status === 'blocked'
      ? comment.reason
      : canSuggest && (suggest.status === 'pending' || suggest.status === 'blocked')
        ? suggest.reason
        : null,
  );
  const anchor = createAnchorTracker(
    () => view,
    () => from,
    () => to,
    { width: 240, height: 38 },
  );
  const pos = $derived(anchor.current);

  const commentReady = $derived(comment.status === 'ready');
  const suggestReady = $derived(suggest.status === 'ready');

  /** A disabled control still owes its reason to hover and to assistive tech. */
  function titleFor(label: string, shortcut: string, state: ComposeAvailability): string {
    if (state.status === 'pending' || state.status === 'blocked') return state.reason;
    return `${label} (${shortcut})`;
  }
</script>

<div
  class="selection-toolbar fixed left-0 top-0 z-40 flex max-w-[19rem] flex-col rounded-md border bg-popover p-1 shadow-lg"
  style="transform: translate3d({pos.recommendedPosition.left}px, {pos.recommendedPosition.top}px, 0)"
  data-slot="selection-toolbar"
  data-comment-state={comment.status}
  data-suggest-state={suggest.status}
  role="toolbar"
  tabindex="-1"
  aria-label="Review actions"
  onmousedown={(e) => e.preventDefault()}
>
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      data-slot="selection-toolbar-comment"
      class="rounded px-2 py-1 text-xs font-medium text-popover-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
      title={titleFor('Comment', '⌘.', comment)}
      disabled={!commentReady}
      onclick={onComment}
    >
      {comment.status === 'pending' ? 'Comment…' : 'Comment'}
    </button>
    {#if canSuggest}
      <div class="mx-0.5 h-4 w-px bg-border" aria-hidden="true"></div>
      <button
        type="button"
        data-slot="selection-toolbar-suggest"
        class="rounded px-2 py-1 text-xs font-medium text-popover-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent"
        title={titleFor('Suggest edit', '⌘⇧.', suggest)}
        disabled={!suggestReady}
        onclick={onSuggest}
      >
        {suggest.status === 'pending' ? 'Suggest…' : 'Suggest'}
      </button>
    {/if}
  </div>
  {#if reason}
    <!-- Said in words, not only carried on `title`: a disabled button with a
         tooltip is unreachable by touch and easy to miss by mouse, and this is
         the sentence that turns "nothing happened" into something actionable.
         `role="status"` so it is announced when it appears rather than only
         when focus happens to land on it. -->
    <p
      class="px-2 pb-1 pt-1.5 text-micro leading-snug text-muted-foreground"
      data-slot="selection-toolbar-reason"
      role="status"
    >
      {reason}
    </p>
  {/if}
</div>
