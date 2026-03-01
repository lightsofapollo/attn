<script lang="ts">
  interface Props {
    src: string;
  }

  let { src }: Props = $props();
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;

  function handleWheel(e: WheelEvent): void {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.1, Math.min(10, scale * delta));
  }

  function handleMouseDown(e: MouseEvent): void {
    if (scale > 1) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  }

  function handleMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function handleMouseUp(): void {
    dragging = false;
  }

  function resetView(): void {
    scale = 1;
    panX = 0;
    panY = 0;
  }

  $effect(() => {
    void src;
    resetView();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="relative flex h-full items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
  onwheel={handleWheel}
  onmousedown={handleMouseDown}
  onmousemove={handleMouseMove}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  role="img"
>
  <img
    {src}
    alt=""
    class="max-h-full max-w-full object-contain select-none"
    style="transform: scale({scale}) translate({panX / scale}px, {panY / scale}px)"
    draggable="false"
  />
  {#if scale !== 1}
    <button
      class="absolute bottom-4 right-4 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground opacity-70 hover:opacity-100"
      onclick={resetView}
    >Reset</button>
  {/if}
</div>
