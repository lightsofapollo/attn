<script lang="ts">
  import type { PlanStructure } from './types';
  import { checkboxToggle } from './ipc';

  interface Props {
    html: string;
    structure: PlanStructure;
  }

  let { html, structure }: Props = $props();

  let articleEl: HTMLElement | undefined = $state(undefined);

  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const checkbox = target.closest('input[type="checkbox"]') as HTMLInputElement | null;
    if (!checkbox) return;

    e.preventDefault();
    if (!articleEl) return;

    const allCheckboxes = articleEl.querySelectorAll('input[type="checkbox"]');
    const taskIndex = Array.from(allCheckboxes).indexOf(checkbox);
    if (structure.tasks && taskIndex >= 0 && taskIndex < structure.tasks.length) {
      checkboxToggle(structure.tasks[taskIndex].line, !checkbox.checked);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article bind:this={articleEl} onclick={handleClick}>
  {@html html}
</article>
