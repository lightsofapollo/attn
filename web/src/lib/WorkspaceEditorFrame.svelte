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
    /** The shared top header already owns the comments toggle. */
    railToggleInHeader?: boolean;
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
    railToggleInHeader = false,
    class: className = '',
  }: Props = $props();

  // Hug rail (Theme v2, attn-ll9): the margin sits just right of the
  // prose edge so cards stay near their anchors; when a wide block (code,
  // table, mermaid) is meaningfully in view (>=80px) it retreats to the pane
  // edge. No scroll listeners: an IntersectionObserver owns wide-block
  // visibility, and the shift distance is scroll-invariant so it only
  // recomputes on resize / doc mutation.
  const WIDE_BLOCK_SELECTOR =
    '.ProseMirror pre, .ProseMirror table, .ProseMirror .mermaid-container, .ProseMirror .prose-scroll-x';
  let railEl: HTMLElement | null = $state(null);
  let currentShift = 0;
  let shiftAvailable = 0;
  let wideInView = 0;
  const wideVisibility = new WeakMap<Element, boolean>();

  function applyHug(): void {
    const el = railEl;
    if (!el) return;
    const active = railMode !== 'hidden' && panelOpen && wideInView === 0;
    const target = active && shiftAvailable >= 40 ? shiftAvailable : 0;
    if (target !== currentShift) {
      currentShift = target;
      el.style.transform = target ? `translateX(-${target}px)` : '';
    }
  }

  /** One layout read per resize/mutation — never per scroll frame. */
  function measureShift(): void {
    const el = railEl;
    if (!el) { shiftAvailable = 0; return; }
    const prose = document.querySelector('.ProseMirror > p, .ProseMirror > h1, article > p');
    if (!prose) { shiftAvailable = 0; applyHug(); return; }
    const naturalLeft = el.getBoundingClientRect().left + currentShift;
    shiftAvailable = Math.max(0, Math.round(naturalLeft - prose.getBoundingClientRect().right - 28));
    applyHug();
  }

  $effect(() => {
    void panelOpen;
    void railMode;
    const el = railEl;
    if (!el) return;

    // Wide-block visibility, browser-scheduled: rootMargin shrinks the
    // viewport by the 80px "meaningfully in view" band.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const was = wideVisibility.get(entry.target) === true;
          if (entry.isIntersecting !== was) {
            wideVisibility.set(entry.target, entry.isIntersecting);
            wideInView += entry.isIntersecting ? 1 : -1;
          }
        }
        if (wideInView < 0) wideInView = 0;
        applyHug();
      },
      { rootMargin: '-80px 0px -80px 0px' },
    );

    const observeWideBlocks = (): void => {
      io.disconnect();
      wideInView = 0;
      for (const block of document.querySelectorAll(WIDE_BLOCK_SELECTOR)) {
        wideVisibility.set(block, false);
        io.observe(block);
      }
      measureShift();
    };

    // Edits add/remove wide blocks; debounce the rescan to the next frame.
    let mutationRaf = 0;
    const mo = new MutationObserver(() => {
      if (mutationRaf) return;
      mutationRaf = requestAnimationFrame(() => {
        mutationRaf = 0;
        observeWideBlocks();
      });
    });
    // Observe the stable content pane (the rail's sibling), not .ProseMirror
    // itself — the editor element is replaced on file switches.
    const contentPane = el.previousElementSibling;
    if (contentPane) mo.observe(contentPane, { childList: true, subtree: true });

    // Horizontal geometry only changes with layout, not scroll.
    const ro = new ResizeObserver(() => measureShift());
    ro.observe(document.documentElement);
    const pane = el.parentElement;
    if (pane) ro.observe(pane);

    observeWideBlocks();

    return () => {
      io.disconnect();
      mo.disconnect();
      ro.disconnect();
      if (mutationRaf) cancelAnimationFrame(mutationRaf);
      wideInView = 0;
      currentShift = 0;
      el.style.transform = '';
    };
  });
</script>

<SidebarProvider class={`h-svh overflow-hidden ${className}`}>
  {@render sidebar()}
  <SidebarInset class="overflow-hidden">
    {@render chrome?.()}
    {@render banner?.()}
    <div class="relative flex min-h-0 flex-1 flex-row overflow-hidden">
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {@render content()}
      </div>
      <!-- No border on the margin (Docs rule): an empty stretch is
           whitespace on the paper, not a panel — the cards carry their own
           edges. The rail still never scrolls; wheel forwards to the doc. -->
      <aside
        bind:this={railEl}
        class="right-rail relative flex shrink-0 flex-col overflow-hidden bg-background transition-transform duration-200"
        style={`width: ${RAIL_WIDTH_PX[railMode]}px; transition-timing-function: var(--ease);`}
        data-state={panelOpen ? 'open' : 'closed'}
        data-mode={railMode}
        data-slot="right-rail"
        aria-label="Review margin"
        aria-hidden={railMode === 'hidden'}
        onwheel={(event) => onRailWheel?.(event.deltaY)}
      >
        {#if railMode !== 'hidden'}
          {#if railToggleInHeader}
            <div class="h-2 shrink-0" aria-hidden="true"></div>
          {:else}
            <div
              class={`flex h-10 shrink-0 items-center ${panelOpen ? 'justify-end pr-2' : 'justify-center'}`}
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
          {/if}
          <div class="relative mb-2 min-h-0 flex-1 overflow-hidden">
            {@render rail()}
          </div>
        {/if}
      </aside>
    </div>
  </SidebarInset>
</SidebarProvider>
