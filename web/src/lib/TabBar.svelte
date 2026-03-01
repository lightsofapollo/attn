<script lang="ts">
  import type { Tab } from './tabs';
  import * as Tabs from '$lib/components/ui/tabs';
  import { ScrollArea } from '$lib/components/ui/scroll-area';

  interface Props {
    tabs: Tab[];
    activeTabId: string;
    onSwitch: (id: string) => void;
    onClose: (id: string) => void;
  }

  let { tabs, activeTabId, onSwitch, onClose }: Props = $props();

  function handleValueChange(value: string): void {
    onSwitch(value);
  }

  function handleMiddleClick(e: MouseEvent, id: string): void {
    if (e.button === 1) {
      e.preventDefault();
      onClose(id);
    }
  }

  function handleCloseClick(e: MouseEvent, id: string): void {
    e.stopPropagation();
    onClose(id);
  }
</script>

<Tabs.Root value={activeTabId} onValueChange={handleValueChange}>
  <div class="h-10 bg-background px-1 pt-0.5">
    <ScrollArea class="w-full" orientation="horizontal">
      <Tabs.List class="h-9 min-w-full w-max justify-start rounded-none border-none bg-transparent p-0">
        {#each tabs as tab (tab.id)}
          <Tabs.Trigger
            value={tab.id}
            class="tab-trigger relative h-full items-center rounded-md px-3 py-0 text-xs text-muted-foreground shadow-none transition-none data-[state=active]:text-foreground hover:bg-accent group gap-1"
            onauxclick={(e: MouseEvent) => handleMiddleClick(e, tab.id)}
          >
            <span class="whitespace-nowrap">{tab.label}</span>
            <span
              class="tab-close opacity-0 group-hover:opacity-50 data-[state=active]:opacity-50 text-base leading-none px-0.5 rounded-sm hover:!opacity-100 hover:bg-accent"
              role="button"
              tabindex={-1}
              onclick={(e: MouseEvent) => handleCloseClick(e, tab.id)}
              onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleCloseClick(e as unknown as MouseEvent, tab.id); }}
            >&times;</span>
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
    </ScrollArea>
  </div>
</Tabs.Root>

<style>
  :global(.tab-trigger) {
    background: color-mix(in oklch, var(--accent) 70%, var(--background) 30%);
  }

  :global(.tab-trigger[data-state="active"]) {
    background: color-mix(in oklch, white 92%, var(--background) 8%);
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--foreground) 12%, transparent);
  }

  /* Close button visibility follows parent trigger state */
  :global([data-state="active"] .tab-close) {
    opacity: 0.5;
  }
</style>
