<script lang="ts">
  interface Props {
    count: number;
    label?: string;
    class?: string;
  }

  let { count, label = 'unread review updates', class: className = '' }: Props = $props();
  const display = $derived(count > 99 ? '99+' : String(count));
</script>

{#if count > 0}
  <span
    class="unread-badge inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none tabular-nums text-primary-foreground {className}"
    data-slot="unread-badge"
    data-count={count}
    aria-label={`${count} ${label}`}
  >
    <span aria-hidden="true">{display}</span>
  </span>
{/if}
