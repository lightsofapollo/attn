<script lang="ts">
  import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
  } from '$lib/components/ui/breadcrumb';
  import { dragWindow } from './ipc';

  interface Props {
    path: string;
    rootPath?: string;
    onNavigate?: (path: string) => void;
    avoidWindowControls?: boolean;
    fixed?: boolean;
    topOffsetPx?: number;
  }

  let {
    path,
    rootPath = '',
    onNavigate,
    avoidWindowControls = false,
    fixed = false,
    topOffsetPx = 0,
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
</script>

<div
  class={`flex shrink-0 items-center justify-between h-[40px] pr-4 pt-1 pb-0 bg-background/95 backdrop-blur-[1px] ${fixed ? 'fixed inset-x-0 z-30' : ''}`}
  style={`-webkit-user-select: none; padding-left: ${avoidWindowControls ? '6.5rem' : '1rem'}; ${fixed ? `top: ${topOffsetPx}px;` : ''}`}
  onmousedown={dragWindow}
>
  {#if segments.length > 1}
    <Breadcrumb>
      <BreadcrumbList>
        {#each segments as segment, i (segment.fullPath)}
          {#if i > 0}
            <BreadcrumbSeparator />
          {/if}
          <BreadcrumbItem>
            {#if segment.isLast}
              <BreadcrumbPage class="text-xs text-foreground/80 font-medium px-1 py-0.5 -mx-1">{segment.name}</BreadcrumbPage>
            {:else}
              <BreadcrumbLink
                href={segment.fullPath}
                class="text-xs text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.05] rounded px-1 py-0.5 -mx-1 transition-colors"
                style="-webkit-app-region: no-drag"
                onclick={(e: MouseEvent) => handleClick(e, segment.fullPath)}
              >{segment.name}</BreadcrumbLink>
            {/if}
          </BreadcrumbItem>
        {/each}
      </BreadcrumbList>
    </Breadcrumb>
  {/if}
</div>
