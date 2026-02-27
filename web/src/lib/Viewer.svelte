<script lang="ts">
  import { checkboxToggle } from './ipc';

  interface Props {
    html: string;
  }

  let { html }: Props = $props();

  let articleEl: HTMLElement | undefined = $state(undefined);

  function handleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const checkbox = target.closest('input[type="checkbox"]') as HTMLInputElement | null;
    if (!checkbox) return;

    e.preventDefault();
    const li = checkbox.closest('li');
    if (!li || !articleEl) return;

    const allItems = articleEl.querySelectorAll('li');
    const index = Array.from(allItems).indexOf(li);
    if (index >= 0) {
      checkboxToggle(index, !checkbox.checked);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article bind:this={articleEl} onclick={handleClick}>
  {@html html}
</article>
