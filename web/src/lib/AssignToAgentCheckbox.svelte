<!--
  AssignToAgentCheckbox — the "Assign to agent" control shared by the
  markdown and HTML comment composers, so the two can never drift apart.

  A real `<input type="checkbox">` inside one `<label>` (click target,
  keyboard, and accessible name all come for free), restyled with
  `appearance-none` so the box is drawn in the theme's primary colour
  instead of the platform's accent. The tick is a separate glyph revealed by
  `peer-checked`, so the checked state is a shape change, not colour alone.
  In forced-colours mode the native control comes back untouched.
-->
<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';

  interface Props {
    checked?: boolean;
    disabled?: boolean;
  }

  let { checked = $bindable(false), disabled = false }: Props = $props();
</script>

<label
  class="mt-2 flex w-fit cursor-pointer select-none items-center gap-2 text-sm text-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
  data-slot="composer-assign-agent"
>
  <span class="relative inline-flex size-4 shrink-0">
    <input
      bind:checked
      {disabled}
      type="checkbox"
      class="peer absolute inset-0 m-0 size-4 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/60 bg-background transition-colors checked:border-primary checked:bg-primary hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed motion-reduce:transition-none forced-colors:appearance-auto"
    />
    <CheckIcon
      class="pointer-events-none relative m-auto size-3 text-primary-foreground opacity-0 peer-checked:opacity-100 forced-colors:hidden"
      strokeWidth={3}
      aria-hidden="true"
    />
  </span>
  Assign to agent
</label>
