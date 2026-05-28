<script lang="ts">
  import { markdownSourceUrl } from './markdown-layer';
  import { openExternal } from './ipc';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

  interface Props {
    /** Absolute path of the .html/.htm file to display. */
    path: string;
    /**
     * Disk mtime (ms) of the active file. Bumping it cache-busts the iframe
     * URL so on-disk edits live-reload. Undefined on first open → no `?v=`.
     */
    mtime?: number;
  }

  let { path, mtime }: Props = $props();

  let loading = $state(true);

  // The iframe loads the file through the `attn://` custom protocol — the same
  // mechanism the image/media viewers use. We render it in a sandboxed frame
  // (allow-scripts, NO allow-same-origin → opaque origin) so the page's own JS
  // runs but cannot reach the app's DOM/storage or the native IPC bridge. The
  // CSP served with the response (see src/main.rs) permits remote fonts/CDN
  // libraries for aesthetics while blocking it from reading other local files.
  let src = $derived(
    mtime !== undefined
      ? `${markdownSourceUrl(path)}?v=${mtime}`
      : markdownSourceUrl(path),
  );
  let fileName = $derived(path.split('/').pop() || path);

  // Reset the loading state whenever the source changes (open or live-reload).
  $effect(() => {
    void src;
    loading = true;
  });

  function openInBrowser(): void {
    openExternal(path);
  }
</script>

<div class="flex h-full flex-col" data-slot="html-viewer">
  <div
    class="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/25 px-3 text-xs text-muted-foreground"
  >
    <span class="truncate font-medium text-foreground/80" title={path}>{fileName}</span>
    <button
      class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 opacity-70 hover:bg-muted/60 hover:opacity-100"
      onclick={openInBrowser}
      title="Open in your default browser"
    >
      <ExternalLinkIcon class="size-3.5" aria-hidden="true" />
      Open in browser
    </button>
  </div>

  <div class="relative min-h-0 flex-1">
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
      navigate the top frame, open popups, or submit forms.
    -->
    <iframe
      {src}
      title={fileName}
      class="h-full w-full border-0 bg-white"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      onload={() => (loading = false)}
    ></iframe>
  </div>
</div>
