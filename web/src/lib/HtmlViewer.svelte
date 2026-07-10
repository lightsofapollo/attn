<script lang="ts">
  import { onMount } from 'svelte';
  import { markdownSourceUrl } from './markdown-layer';
  import { htmlViewerSandbox } from './html-viewer-sandbox';

  interface Props {
    /**
     * Owner/local mode: absolute path of the .html/.htm file to display. The
     * iframe loads it via the `attn://` custom protocol. Mutually exclusive
     * with `content`.
     */
    path?: string;
    /**
     * Reviewer mode: raw HTML source to render directly via `srcdoc`. Used when
     * displaying a shared read-only snapshot — the reviewer has no local file on
     * disk, so the bytes received over the encrypted channel are rendered
     * inline. Mutually exclusive with `path`.
     */
    content?: string;
    /**
     * Disk mtime (ms) of the active file. Bumping it cache-busts the iframe
     * URL so on-disk edits live-reload. Undefined on first open → no `?v=`.
     * Path mode only.
     */
    mtime?: number;
    /** Native/local pages retain script support; hosted snapshots disable it. */
    allowScripts?: boolean;
  }

  let { path, content, mtime, allowScripts = true }: Props = $props();

  let loading = $state(true);

  // The iframe is a cross-origin, opaque-origin sandbox, so we can neither
  // style its internal scrollbar nor scroll it from attn's ScrollArea (its
  // content height isn't measurable across origins). To avoid the chunky native
  // scrollbar at a hard edge — and match the app's clean, scrollbar-less look —
  // we make the iframe wider than its clipping wrapper by exactly the platform
  // scrollbar width, so the native vertical scrollbar falls in the clipped
  // gutter. On overlay-scrollbar systems the width is 0 (no clip needed).
  let scrollbarWidth = $state(0);
  onMount(() => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;width:50px;height:50px;overflow:scroll';
    document.body.appendChild(probe);
    scrollbarWidth = probe.offsetWidth - probe.clientWidth;
    probe.remove();
  });

  // The iframe loads the file through the `attn://` custom protocol — the same
  // mechanism the image/media viewers use — in a sandboxed frame (allow-scripts,
  // NO allow-same-origin → opaque origin). The CSP served with the response (see
  // src/main.rs) permits remote fonts/CDN libraries for aesthetics while
  // blocking it from reading other local files. The header (breadcrumb +
  // "Open in browser" button) is shared app chrome rendered by App.svelte.
  // `content` (reviewer/srcdoc) wins when provided; otherwise load the local
  // file via the attn:// protocol (owner/path mode).
  let isContentMode = $derived(content !== undefined);
  let sandbox = $derived(htmlViewerSandbox(allowScripts));
  let src = $derived(
    !isContentMode && path !== undefined
      ? mtime !== undefined
        ? `${markdownSourceUrl(path)}?v=${mtime}`
        : markdownSourceUrl(path)
      : undefined,
  );
  let fileName = $derived(
    path !== undefined ? path.split('/').pop() || path : 'shared document',
  );

  // Reset the loading state whenever the source/content changes (open or
  // live-reload).
  $effect(() => {
    void src;
    void content;
    loading = true;
  });
</script>

<div class="relative h-full w-full overflow-hidden" data-slot="html-viewer">
  {#if loading}
    <div
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
      data-slot="html-viewer-loading"
    >
      Loading…
    </div>
  {/if}
  <!--
    sandbox="allow-scripts" WITHOUT allow-same-origin: the page runs its own
    JavaScript in a unique opaque origin and cannot touch the parent app,
    navigate the top frame, open popups, or submit forms. Width is padded by the
    scrollbar width so the native scrollbar is clipped by the wrapper above.
  -->
  {#if isContentMode}
    <!-- Reviewer mode: the hosted app passes allowScripts=false, producing an
         empty sandbox token list. Native callers retain the historical
         allow-scripts opaque-origin behavior by default. -->
    <iframe
      srcdoc={content}
      title={fileName}
      class="block h-full border-0 bg-white"
      style="width: calc(100% + {scrollbarWidth}px);"
      {sandbox}
      referrerpolicy="no-referrer"
      onload={() => (loading = false)}
    ></iframe>
  {:else}
    <iframe
      {src}
      title={fileName}
      class="block h-full border-0 bg-white"
      style="width: calc(100% + {scrollbarWidth}px);"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      onload={() => (loading = false)}
    ></iframe>
  {/if}
</div>
