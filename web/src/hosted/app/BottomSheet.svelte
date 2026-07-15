<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Quiet meta line under the title (counts, file stats). */
    subtitle?: string;
    onclose: () => void;
    children: Snippet;
  }

  const { title, subtitle, onclose, children }: Props = $props();

  let closeButton = $state<HTMLButtonElement | undefined>();
  let sheetEl = $state<HTMLDivElement | undefined>();

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

  // Swipe-down on the grip dismisses the sheet. Direct manipulation: the
  // sheet tracks the finger 1:1, then either commits (instant unmount — the
  // Truth Rule, no exit choreography) or snaps back on release.
  let dragging = false;
  let dragStartY = 0;
  let dragOffset = 0;

  function onGripDown(event: PointerEvent): void {
    if (!sheetEl) return;
    dragging = true;
    dragStartY = event.clientY;
    dragOffset = 0;
    sheetEl.classList.add('is-dragging');
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onGripMove(event: PointerEvent): void {
    if (!dragging || !sheetEl) return;
    dragOffset = Math.max(0, event.clientY - dragStartY);
    sheetEl.style.transform = dragOffset > 0 ? `translateY(${dragOffset}px)` : '';
  }

  function onGripEnd(): void {
    if (!dragging || !sheetEl) return;
    dragging = false;
    sheetEl.classList.remove('is-dragging');
    if (dragOffset > 88) {
      onclose();
      return;
    }
    dragOffset = 0;
    sheetEl.style.transform = '';
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="bottom-sheet-veil" onclick={onVeilClick} onkeydown={onkeydown}>
  <div class="bottom-sheet" bind:this={sheetEl} role="dialog" aria-modal="true" aria-label={title}>
    <div
      class="bottom-sheet-grip"
      aria-hidden="true"
      onpointerdown={onGripDown}
      onpointermove={onGripMove}
      onpointerup={onGripEnd}
      onpointercancel={onGripEnd}
    >
      <span></span>
    </div>
    <div class="bottom-sheet-head">
      <div class="bottom-sheet-heading">
        <h2>{title}</h2>
        {#if subtitle}<p class="bottom-sheet-subtitle">{subtitle}</p>{/if}
      </div>
      <button class="button" type="button" bind:this={closeButton} onclick={onclose}>
        Close
      </button>
    </div>
    {@render children()}
  </div>
</div>
