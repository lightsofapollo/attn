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
-->

<script lang="ts">
  import type { EditorView } from 'prosemirror-view';
  import { getPopoverAnchor, type PopoverAnchor } from './review/popover-anchor';

  interface Props {
    view: EditorView;
    from: number;
    to: number;
    onComment: () => void;
    onSuggest: () => void;
    canSuggest?: boolean;
  }

  const { view, from, to, onComment, onSuggest, canSuggest = true }: Props = $props();

  // A compact bar, so position it tightly above the selection.
  const pos = $derived<PopoverAnchor>(
    getPopoverAnchor(view, from, to, { width: 188, height: 38 }),
  );
</script>

<div
  class="selection-toolbar absolute z-40 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-lg"
  style="top: {pos.recommendedPosition.top}px; left: {pos.recommendedPosition.left}px"
  data-slot="selection-toolbar"
  role="toolbar"
  tabindex="-1"
  aria-label="Review actions"
  onmousedown={(e) => e.preventDefault()}
>
  <button
    type="button"
    data-slot="selection-toolbar-comment"
    class="rounded px-2 py-1 text-xs font-medium text-popover-foreground hover:bg-muted"
    title="Comment (⌘.)"
    onclick={onComment}
  >
    Comment
  </button>
  {#if canSuggest}
    <div class="mx-0.5 h-4 w-px bg-border" aria-hidden="true"></div>
    <button
    type="button"
    data-slot="selection-toolbar-suggest"
    class="rounded px-2 py-1 text-xs font-medium text-popover-foreground hover:bg-muted"
    title="Suggest edit (⌘⇧.)"
    onclick={onSuggest}
  >
    Suggest
    </button>
  {/if}
</div>
