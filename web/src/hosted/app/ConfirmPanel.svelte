<!--
  One destructive-confirmation panel for the whole hosted app (attn-a9f7.1.2).

  Three call sites each declared role="alertdialog" and then behaved
  differently: the desk moved focus but never trapped it, and Storage's two
  panels moved no focus at all, so "Clear all local attn data" announced a
  dialog and left the reader on the button behind it. The contract lives here
  instead — focus in on open, Tab held inside, Escape cancels, focus restored
  to whatever opened it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import { autofocus } from '../../lib/hosted/autofocus';

  interface Props {
    /** Accessible name; states the consequence, not just the verb. */
    label: string;
    title: string;
    body?: Snippet;
    confirmLabel: string;
    onconfirm: () => void | Promise<void>;
    oncancel: () => void;
    /** Optional non-destructive escape hatch, rendered between Cancel and the
     *  destructive action (the desk's "Export first"). */
    extra?: Snippet;
  }

  const { label, title, body, confirmLabel, onconfirm, oncancel, extra }: Props = $props();

  // Captured during init, while the invoking control still holds focus.
  const trigger = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

  let panel = $state<HTMLDivElement | undefined>();

  onDestroy(() => {
    // A confirmed delete removes its own trigger from the DOM; only restore to
    // a control that is still there.
    if (trigger?.isConnected) trigger.focus();
  });

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      // The topmost layer closes; the surfaces below keep their own handlers.
      event.stopPropagation();
      oncancel();
      return;
    }
    if (event.key !== 'Tab' || !panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<div
  bind:this={panel}
  class="confirm-clear"
  role="alertdialog"
  aria-modal="true"
  tabindex="-1"
  use:autofocus
  aria-label={label}
  onkeydown={onKeydown}
>
  <strong>{title}</strong>
  {#if body}{@render body()}{/if}
  <div class="actions">
    <button class="button" type="button" onclick={oncancel}>Cancel</button>
    {#if extra}{@render extra()}{/if}
    <button class="button danger" type="button" onclick={() => void onconfirm()}>{confirmLabel}</button>
  </div>
</div>
