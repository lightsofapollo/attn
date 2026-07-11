<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import type { WorkspaceService } from './types';

  interface Props {
    service: WorkspaceService;
  }

  const { service }: Props = $props();
  const health = $derived(service.storageHealth());
</script>

<div class="app-shell" data-app-view="open">
  <AppHeader mode={health.mode}>
    {#snippet actions()}
      <a class="button" href="/app">Back to your desk</a>
    {/snippet}
  </AppHeader>
  <main class="desk">
    <DegradedBanner mode={health.mode} />
    <div class="desk-title">
      <div>
        <div class="eyebrow">Import handoff</div>
        <h1>Import into your desk</h1>
      </div>
      <p>Everything imports to this device only</p>
    </div>

    <div class="drop-zone">
      <h2>Drop files to import</h2>
      <p>
        Markdown files, referenced images and assets, whole folders where the browser supports
        them, or a zip. Relative paths are preserved exactly as native attn sees them.
      </p>
      <div class="formats">.md · images &amp; assets · folder · .zip · .attn-workspace (soon)</div>
      <div class="storage-actions" style="justify-content: center;">
        <button class="button primary" type="button">Choose files</button>
      </div>
    </div>
  </main>
</div>
