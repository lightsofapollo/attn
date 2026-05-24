<!--
  Owner-facing accept/reject popover for an inline suggestion (attn-07i.2
  Phase 2). Appears when the owner's cursor enters a tracked-change mark; mirrors
  the floating SelectionToolbar. In-app UI only (no window.confirm).
-->
<script lang="ts">
  import type { EditorView } from 'prosemirror-view';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import type { SuggestionInfo } from './review/suggestions';
  import { getPopoverAnchor, type PopoverAnchor } from './review/popover-anchor';

  interface Props {
    view: EditorView;
    info: SuggestionInfo;
    onAccept: () => void;
    onReject: () => void;
    onComment: () => void;
  }

  let { view, info, onAccept, onReject, onComment }: Props = $props();

  // Position above the suggestion range, mirroring SelectionToolbar.
  const pos = $derived<PopoverAnchor>(
    getPopoverAnchor(view, info.from, info.to, { width: 320, height: 96 }),
  );
  const top = $derived(pos.recommendedPosition.top);
  const left = $derived(pos.recommendedPosition.left);

  const verb = $derived(info.kind === 'deletion' ? 'deletion' : 'insertion');
  const preview = $derived(
    info.text.length > 60 ? info.text.slice(0, 57) + '…' : info.text,
  );
</script>

<div
  class="suggestion-popover absolute z-40 w-[min(20rem,calc(100vw-2rem))] rounded-md border bg-popover p-2.5 text-popover-foreground shadow-lg"
  style="top: {top}px; left: {left}px"
  data-slot="suggestion-popover"
  role="dialog"
  tabindex="-1"
  aria-label="Suggestion"
  onmousedown={(e) => e.preventDefault()}
>
  <div class="mb-1.5 flex items-baseline justify-between gap-2">
    <span class="truncate text-xs font-medium text-foreground" data-slot="suggestion-author">
      {info.author}
    </span>
    <span class="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
      suggested {verb}
    </span>
  </div>

  {#if preview}
    <p
      class="mb-2 max-h-16 overflow-hidden text-xs text-muted-foreground"
      class:line-through={info.kind === 'deletion'}
      data-slot="suggestion-preview"
    >
      {preview}
    </p>
  {/if}

  <div class="flex items-center justify-end gap-1">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
      data-slot="suggestion-comment"
      onclick={onComment}
    >
      <MessageSquare class="size-3" aria-hidden="true" /> Comment
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted"
      data-slot="suggestion-reject"
      onclick={onReject}
    >
      <X class="size-3" aria-hidden="true" /> Reject
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
      data-slot="suggestion-accept"
      onclick={onAccept}
    >
      <Check class="size-3" aria-hidden="true" /> Accept
    </button>
  </div>
</div>
