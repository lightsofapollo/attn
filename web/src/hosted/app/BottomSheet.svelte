<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
  }

  const { title, onclose, children }: Props = $props();

  let closeButton = $state<HTMLButtonElement | undefined>();

  // Sheets announce their title, take focus, and close on Escape or veil tap
  // (ios-ux.md §11). The invoking control restores focus in the parent.
  $effect(() => {
    closeButton?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }

  function onVeilClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onclose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="bottom-sheet-veil" onclick={onVeilClick} onkeydown={onkeydown}>
  <div class="bottom-sheet" role="dialog" aria-modal="true" aria-label={title}>
    <div class="bottom-sheet-head">
      <h2>{title}</h2>
      <button class="button" type="button" bind:this={closeButton} onclick={onclose}>
        Close
      </button>
    </div>
    {@render children()}
  </div>
</div>
