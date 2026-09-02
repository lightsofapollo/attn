<script lang="ts">
  import { onMount } from 'svelte';
  import { markdownSourceUrl } from './markdown-layer';
  import { htmlViewerSandbox } from './html-viewer-sandbox';
  import {
    HtmlAnnotationBridge,
    injectDocRuntime,
  } from './review/html-annotation-bridge';
  import { rewriteSharedHtmlImageSources } from './review/html-shared-assets';
  import type { AnnotationBridgeEvents } from './review/html-annotation-bridge';

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
    /** Resolves a share-bound HTML image src to an in-memory Blob URL. */
    resolveAssetUrl?: (src: string) => string | null;
    /** Turn on commenting for either a shared source or a local path. */
    annotate?: boolean;
    /** Wired up once the frame exists, so a parent can drive the rail. */
    annotationEvents?: AnnotationBridgeEvents;
    /** Handed the live bridge so the parent can push anchors and focus. */
    onBridge?: (bridge: HtmlAnnotationBridge | null) => void;
  }

  let {
    path,
    content,
    mtime,
    allowScripts = true,
    resolveAssetUrl,
    annotate = false,
    annotationEvents,
    onBridge,
  }: Props = $props();

  let loading = $state(true);
  let frameEl = $state<HTMLIFrameElement | null>(null);
  let bridge: HtmlAnnotationBridge | null = null;

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
  // Source documents are spliced here. Local path documents request a runtime-
  // augmented attn:// response instead, preserving their normal base URL so
  // `./chart.png` and `style.css` keep resolving from disk.
  let annotating = $derived(annotate);
  let isContentMode = $derived(content !== undefined);
  // The injected runtime needs `allow-scripts`, so annotating a snapshot turns
  // scripts on even where the hosted reviewer would otherwise disable them.
  // The frame stays on an opaque origin either way — no allow-same-origin — so
  // this grants the document no reach into the app, the user's files, or
  // storage. The document's own scripts are assumed hostile regardless, which
  // is why the trust boundary sits in the shell and not in the frame.
  // @see planning/collab/html-annotation.md §3, §4
  let sandbox = $derived(htmlViewerSandbox(allowScripts || annotating));
  let renderedContent = $derived.by(() => {
    if (content === undefined) return content;
    const withSharedAssets = rewriteSharedHtmlImageSources(content, resolveAssetUrl);
    return annotating ? injectDocRuntime(withSharedAssets) : withSharedAssets;
  });
  let src = $derived.by(() => {
    if (isContentMode || path === undefined) return undefined;
    const params = new URLSearchParams();
    if (mtime !== undefined) params.set('v', String(mtime));
    if (annotating) params.set('attn-annotate', '1');
    const query = params.toString();
    return `${markdownSourceUrl(path)}${query ? `?${query}` : ''}`;
  });
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

  // Content changes rebuild the bridge. Path-mode reloads keep this bridge
  // attached: the reloaded frame sends hello again, which replaces its dead
  // port and replays the shell's retained anchor state.
  $effect(() => {
    const frame = frameEl;
    const shouldAnnotate = annotating;
    void renderedContent;

    if (!frame || !shouldAnnotate) {
      bridge?.dispose();
      bridge = null;
      onBridge?.(null);
      return;
    }

    const next = new HtmlAnnotationBridge(frame, annotationEvents ?? {});
    next.connect();
    bridge = next;
    onBridge?.(next);

    return () => {
      next.dispose();
      if (bridge === next) {
        bridge = null;
        onBridge?.(null);
      }
    };
  });
</script>

<div
  class="relative h-full w-full overflow-hidden"
  data-slot="html-viewer"
  data-annotation-mode={annotating ? (isContentMode ? 'content' : 'path') : 'off'}
>
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
    <!-- An annotation transition changes both the sandbox token and srcdoc.
         Recreate the frame so its sandbox is installed before a newly injected
         runtime can execute; updating srcdoc first would make Chrome reject
         that runtime against the old empty sandbox. -->
    {#key sandbox}
      <iframe
        bind:this={frameEl}
        {sandbox}
        srcdoc={renderedContent}
        title={fileName}
        class="block h-full border-0 bg-white"
        style="width: calc(100% + {scrollbarWidth}px);"
        referrerpolicy="no-referrer"
        onload={() => (loading = false)}
      ></iframe>
    {/key}
  {:else}
    <!--
      `bind:this` matters as much here as in the srcdoc branch: without it the
      annotation bridge has no frame to hand shake with, so an owner's local
      HTML file injected the runtime, the runtime said hello, and nothing
      answered — every pill press and element click died in a closed port.
    -->
    <iframe
      bind:this={frameEl}
      {src}
      title={fileName}
      class="block h-full border-0 bg-white"
      style="width: calc(100% + {scrollbarWidth}px);"
      {sandbox}
      referrerpolicy="no-referrer"
      onload={() => (loading = false)}
    ></iframe>
  {/if}
</div>
