<script lang="ts">
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';

  interface Props {
    contentHost: HTMLElement;
  }

  let { contentHost }: Props = $props();
  let copied = $state(false);

  function attachContentHost(node: HTMLElement): { destroy: () => void } {
    if (contentHost.parentElement !== node) {
      node.appendChild(contentHost);
    }

    return {
      destroy() {
        if (contentHost.parentElement === node) {
          node.removeChild(contentHost);
        }
      },
    };
  }

  function handleCopy(): void {
    const text = contentHost.textContent ?? '';
    navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }
</script>

<div class="relative group/codeblock">
  <button
    type="button"
    class="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground opacity-0 group-hover/codeblock:opacity-100 transition-opacity cursor-pointer"
    onclick={handleCopy}
    aria-label="Copy code"
  >
    {#if copied}
      <Check class="size-3.5" />
    {:else}
      <Copy class="size-3.5" />
    {/if}
  </button>
  <ScrollArea class="prose-scroll-area-x w-full max-w-full" orientation="horizontal">
    <div class="min-w-max" use:attachContentHost></div>
  </ScrollArea>
</div>
