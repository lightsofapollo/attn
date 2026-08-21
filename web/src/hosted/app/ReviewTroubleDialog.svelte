<!--
  What happened to the live review, said once, in one place.

  This replaces two inline banners that sat inside the reading column
  (`data-degraded="share-resume-failed"` and `="owner-authority-paused"`). They
  pushed the document down every time the relay hiccuped, and printed the
  runtime's raw error string as the explanation. The owner asked for the state
  to be surfaced in the HEADER and for the detail to live in a modal.

  Focus contract matches ConfirmPanel.svelte, which owns the same contract for
  destructive confirmations: focus in on open, Tab held inside, Escape closes,
  focus restored to the control that opened it. This is a notice rather than a
  confirmation — there is nothing to cancel — so it is `role="dialog"`, not
  `alertdialog`, and its close action is the safe one.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { autofocus } from '../../lib/hosted/autofocus';
  import type { ReviewTrouble } from './review-trouble';

  interface Action {
    label: string;
    run: () => void | Promise<void>;
    /** The recommended move, if there is one. Only ever one per dialog. */
    primary?: boolean;
    pending?: boolean;
  }

  interface Props {
    trouble: ReviewTrouble;
    actions?: Action[];
    onclose: () => void;
  }

  const { trouble, actions = [], onclose }: Props = $props();

  const trigger = typeof document === 'undefined'
    ? null
    : (document.activeElement as HTMLElement | null);

  let panel = $state<HTMLDivElement | undefined>();

  onDestroy(() => {
    if (trigger?.isConnected) trigger.focus();
  });

  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Topmost layer closes; the surfaces below keep their own handlers.
      event.stopPropagation();
      onclose();
      return;
    }
    if (event.key !== 'Tab' || !panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
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

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="cmdk-veil" onclick={onclose}></div>
<div
  bind:this={panel}
  class="review-trouble"
  data-kind={trouble.kind}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  aria-labelledby="review-trouble-title"
  onkeydown={onKeydown}
>
  <h2 class="review-trouble-title" id="review-trouble-title">{trouble.title}</h2>
  <p class="review-trouble-body">{trouble.body}</p>

  {#if trouble.detail}
    <!-- Kept, not deleted. The raw string is the only thing worth pasting into
         a bug report, and hiding it entirely would trade one failure (jargon in
         the face) for another (nothing to report). -->
    <details class="review-trouble-detail">
      <summary>Technical detail</summary>
      <p>{trouble.detail}</p>
    </details>
  {/if}

  <div class="review-trouble-actions">
    <button use:autofocus class="button" type="button" onclick={onclose}>Close</button>
    {#each actions as action (action.label)}
      <button
        class="button"
        class:primary={action.primary}
        type="button"
        disabled={action.pending}
        onclick={() => void action.run()}
      >{action.label}</button>
    {/each}
  </div>
</div>
