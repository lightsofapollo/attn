<script lang="ts">
  import type { Snippet } from 'svelte';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
  import { SidebarInset, SidebarProvider } from '$lib/components/ui/sidebar';
  import type { RailMode } from './review/rail-mode';
  import { RAIL_WIDTH_PX } from './review/rail-mode';
  import UnreadBadge from './UnreadBadge.svelte';

  interface Props {
    sidebar: Snippet;
    content: Snippet;
    rail: Snippet;
    banner?: Snippet;
    chrome?: Snippet;
    railMode: RailMode;
    panelOpen: boolean;
    unreadCount?: number;
    onToggleRail?: () => void;
    onRailWheel?: (deltaY: number) => void;
    class?: string;
  }

  let {
    sidebar,
    content,
    rail,
    banner,
    chrome,
    railMode,
    panelOpen,
    unreadCount = 0,
    onToggleRail,
    onRailWheel,
    class: className = '',
  }: Props = $props();
</script>

<SidebarProvider class={`h-svh overflow-hidden ${className}`}>
  {@render sidebar()}
  <SidebarInset class="overflow-hidden">
    {@render banner?.()}
    <div class="relative flex min-h-0 flex-1 flex-row overflow-hidden">
      {@render chrome?.()}
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {@render content()}
      </div>
      <aside
        class="right-rail relative mt-12 flex shrink-0 flex-col overflow-hidden rounded-tl-lg border-l border-t border-border/40 data-[mode=hidden]:border-none bg-sidebar"
        style={`width: ${RAIL_WIDTH_PX[railMode]}px;`}
        data-state={panelOpen ? 'open' : 'closed'}
        data-mode={railMode}
        data-slot="right-rail"
        aria-label="Review margin"
        aria-hidden={railMode === 'hidden'}
        onwheel={(event) => onRailWheel?.(event.deltaY)}
      >
        {#if railMode !== 'hidden'}
          <div
            class={`flex h-10 shrink-0 items-center border-b border-border/40 ${panelOpen ? 'justify-end pr-2' : 'justify-center'}`}
            data-slot="rail-header"
          >
            <button
              type="button"
              class="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              data-slot="rail-toggle"
              data-state={panelOpen ? 'expanded' : 'collapsed'}
              aria-label={panelOpen ? 'Collapse comments rail' : 'Expand comments rail'}
              title={`${panelOpen ? 'Collapse' : 'Expand'} comments (⌘J)`}
              aria-expanded={panelOpen}
              onclick={() => onToggleRail?.()}
            >
              {#if panelOpen}
                <PanelRightClose class="size-4" aria-hidden="true" />
              {:else}
                <PanelRightOpen class="size-4" aria-hidden="true" />
              {/if}
              <UnreadBadge
                count={unreadCount}
                label="unread review updates"
                class="absolute -right-1.5 -top-1.5"
              />
            </button>
          </div>
          <div class="relative mb-2 min-h-0 flex-1 overflow-hidden">
            {@render rail()}
          </div>
        {/if}
      </aside>
    </div>
  </SidebarInset>
</SidebarProvider>
