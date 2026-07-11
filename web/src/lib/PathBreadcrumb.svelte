<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
  } from '$lib/components/ui/breadcrumb';
  import { dragWindow } from './ipc';
  import Share2 from '@lucide/svelte/icons/share-2';
  import ExternalLink from '@lucide/svelte/icons/external-link';

  interface Props {
    path: string;
    rootPath?: string;
    onNavigate?: (path: string) => void;
    onShare?: (trigger?: HTMLButtonElement) => void;
    shareEnabled?: boolean;
    /** When set, shows an "open in browser" icon button in the header cluster
     *  (used for HTML files, which can't be shared but can be opened externally). */
    onOpenInBrowser?: () => void;
    avoidWindowControls?: boolean;
    fixed?: boolean;
    topOffsetPx?: number;
    rightInsetPx?: number;
    /** Platform-specific status/actions rendered beside the shared path chrome. */
    actions?: Snippet;
  }

  let {
    path,
    rootPath = '',
    onNavigate,
    onShare,
    shareEnabled = false,
    onOpenInBrowser,
    avoidWindowControls = false,
    fixed = false,
    topOffsetPx = 0,
    rightInsetPx = 16,
    actions,
  }: Props = $props();

  interface Segment {
    name: string;
    fullPath: string;
    isLast: boolean;
  }

  let segments = $derived.by((): Segment[] => {
    if (!path) return [];
    // Show path relative to root directory
    let displayPath = path;
    if (rootPath && path.startsWith(rootPath)) {
      displayPath = path.slice(rootPath.length);
    }
    // Strip leading slash, split into parts
    const parts = displayPath.replace(/^\//, '').split('/').filter(Boolean);
    if (parts.length === 0) return [];
    const result: Segment[] = [];
    // Build segments from the root path forward
    let accumulated = rootPath;
    for (let i = 0; i < parts.length; i++) {
      accumulated = accumulated ? `${accumulated}/${parts[i]}` : `/${parts[i]}`;
      result.push({
        name: parts[i],
        fullPath: accumulated,
        isLast: i === parts.length - 1,
      });
    }
    return result;
  });

  function handleClick(e: MouseEvent, segmentPath: string): void {
    e.preventDefault();
    if (onNavigate) {
      onNavigate(segmentPath);
    }
  }

  function handleShareClick(event: MouseEvent): void {
    if (!shareEnabled) return;
    onShare?.(event.currentTarget as HTMLButtonElement);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={`flex shrink-0 items-center justify-between gap-2 h-[40px] min-w-0 pr-4 pt-3 pb-0 bg-background/95 backdrop-blur-[1px] ${fixed ? 'fixed inset-x-0 z-30' : ''}`}
  style={`-webkit-user-select: none; padding-left: ${avoidWindowControls ? '6.5rem' : '1rem'}; padding-right: ${rightInsetPx}px; ${fixed ? `top: ${topOffsetPx}px;` : ''}`}
  onmousedown={(event) => {
    if (event.target === event.currentTarget) dragWindow(event);
  }}
>
  {#if segments.length > 1}
    <Breadcrumb class="mt-1.5 min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      <BreadcrumbList class="w-max min-w-full flex-nowrap whitespace-nowrap break-normal">
        {#each segments as segment, i (segment.fullPath)}
          {#if i > 0}
            <BreadcrumbSeparator />
          {/if}
          <BreadcrumbItem>
            {#if segment.isLast}
              <BreadcrumbPage class="text-foreground/80 font-medium px-1 py-0.5 -mx-1">{segment.name}</BreadcrumbPage>
            {:else}
              <BreadcrumbLink
                href={segment.fullPath}
                class="text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.05] rounded px-1 py-0.5 -mx-1 transition-colors"
                style="-webkit-app-region: no-drag"
                onclick={(e: MouseEvent) => handleClick(e, segment.fullPath)}
              >{segment.name}</BreadcrumbLink>
            {/if}
          </BreadcrumbItem>
        {/each}
      </BreadcrumbList>
    </Breadcrumb>
  {:else}
    <div class="min-w-0 flex-1" aria-hidden="true"></div>
  {/if}
  {@render actions?.()}
  {#if onOpenInBrowser}
    <button
      type="button"
      class="-mt-3 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/55 text-muted-foreground shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style="-webkit-app-region: no-drag"
      aria-label="Open in browser"
      title="Open in browser"
      onclick={() => onOpenInBrowser?.()}
    >
      <ExternalLink class="size-3.5" aria-hidden="true" />
      <span class="sr-only">Open in browser</span>
    </button>
  {/if}
  {#if onShare}
    <button
      type="button"
      class="-mt-3 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/55 text-muted-foreground shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
      style="-webkit-app-region: no-drag"
      aria-label="Share for review"
      title="Share for review"
      disabled={!shareEnabled}
      onclick={handleShareClick}
    >
      <Share2 class="size-3.5" aria-hidden="true" />
      <span class="sr-only">Share for review</span>
    </button>
  {/if}
</div>
