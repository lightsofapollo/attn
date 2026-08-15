<script lang="ts">
  export type SaveChipState = 'saved' | 'saving' | 'attention' | 'status';

  interface Props {
    /** Full state sentence; visually hidden but always announced by the status region. */
    label: string;
    /** Hover/long-press disclosure. Defaults to the screen-reader sentence. */
    title?: string;
    /** Saved work, an in-flight write, a general status, or an error that needs attention. */
    state?: SaveChipState;
    /** Stable selector for the host surface. */
    dataSlot?: string;
    /** Native autosave detail; omitted on browser surfaces. */
    autosave?: 'armed' | 'held';
    /** Hosted commit counter used by the end-to-end durability checks. */
    commitCount?: number;
    class?: string;
  }

  let {
    label,
    title = label,
    state = 'saved',
    dataSlot = 'save-chip',
    autosave,
    commitCount,
    class: className = '',
  }: Props = $props();
</script>

<!-- A status, never a control: save state reports a fact and opens no surface. -->
<span
  class={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground ${className}`}
  data-slot={dataSlot}
  data-state={state}
  data-save-state={label}
  data-autosave={autosave}
  data-commits={commitCount}
  role="status"
  title={title}
>
  {#if state === 'saved'}
    <svg
      class="size-3.5 text-primary" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <path d="M12.5 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4v4.35" />
      <path d="m16 19 2 2 4-4" />
      <path d="M17 15.13V14a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </svg>
  {:else if state === 'saving'}
    <svg
      class="size-3.5 text-amber-deep" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <path d="M13.33 13H8a1 1 0 0 0-1 1v7" />
      <path d="M14.363 17.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 1 0-3.004-3.004z" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4v.3" />
    </svg>
  {:else if state === 'attention'}
    <svg
      class="size-3.5 text-destructive" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16.5v.5" />
    </svg>
  {:else}
    <svg
      class="size-3.5 text-primary" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8v.5" />
    </svg>
  {/if}
  <span class="sr-only" data-slot={`${dataSlot}-label`}>{label}</span>
</span>
