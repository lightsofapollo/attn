<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  let loaded = $state(false);
  let frame: HTMLIFrameElement;
  let container: HTMLDivElement;
  let observer: IntersectionObserver | undefined;
  let visibilityFrame = 0;
  let lastVisibility: boolean | undefined;

  function sendVisibility(visible: boolean, force = false): void {
    if (!force && visible === lastVisibility) return;
    lastVisibility = visible;
    frame?.contentWindow?.postMessage(
      { type: 'attn-landing-demo-visibility', visible },
      window.location.origin,
    );
  }

  function handleLoad(): void {
    loaded = true;
    checkVisibility();
  }

  function checkVisibility(): void {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const enoughIsVisible = visibleHeight >= Math.min(rect.height * 0.42, window.innerHeight * 0.42);
    sendVisibility(enoughIsVisible);
  }

  function scheduleVisibilityCheck(): void {
    if (visibilityFrame) return;
    visibilityFrame = requestAnimationFrame(() => {
      visibilityFrame = 0;
      checkVisibility();
    });
  }

  function handleDemoMessage(event: MessageEvent): void {
    if (event.origin !== window.location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === 'attn-landing-demo-ready') {
      const rect = container.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      sendVisibility(visibleHeight >= Math.min(rect.height * 0.42, window.innerHeight * 0.42), true);
    }
  }

  onMount(() => {
    observer = new IntersectionObserver(
      scheduleVisibilityCheck,
      { threshold: [0, 0.25, 0.42, 0.72] },
    );
    observer.observe(container);
    window.addEventListener('scroll', scheduleVisibilityCheck, { passive: true });
    window.addEventListener('resize', scheduleVisibilityCheck);
    window.addEventListener('message', handleDemoMessage);
    scheduleVisibilityCheck();
  });

  onDestroy(() => {
    observer?.disconnect();
    window.removeEventListener('scroll', scheduleVisibilityCheck);
    window.removeEventListener('resize', scheduleVisibilityCheck);
    window.removeEventListener('message', handleDemoMessage);
    if (visibilityFrame) cancelAnimationFrame(visibilityFrame);
  });
</script>

<div bind:this={container} class="proof-window real-demo-frame" data-loaded={loaded ? 'true' : 'false'}>
  {#if !loaded}
    <div class="demo-loading" role="status">
      <span aria-hidden="true"></span>
      Opening the live review…
    </div>
  {/if}
  <iframe
    bind:this={frame}
    src="/app?surface=landing-review-demo"
    title="Interactive attn Markdown review: select text and add a comment"
    loading="lazy"
    allow="clipboard-write"
    onload={handleLoad}
  ></iframe>
</div>
