<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import { expandPicked, prepareImport } from './import-files';
  import { fileDrop, filesToPicked } from './file-drop';
  import type { ImportFileInput, StorageHealth } from './types';

  interface Props {
    health: StorageHealth;
    onImport: (name: string, files: ImportFileInput[]) => Promise<void>;
  }

  const { health, onImport }: Props = $props();

  let fileInput = $state<HTMLInputElement | undefined>();
  let importError = $state<string | null>(null);

  async function importFiles(files: Iterable<File>): Promise<void> {
    importError = null;
    try {
      const prepared = prepareImport(await expandPicked(await filesToPicked(files)));
      await onImport(prepared.name, prepared.files);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }

  function onFilesPicked(): void {
    const files = fileInput?.files;
    if (files && files.length > 0) void importFiles(Array.from(files));
  }
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
        <!-- "Import handoff" was our internal name for the flow (attn-08fa.8). -->
        <div class="eyebrow">Bring files in</div>
        <h1>Import into your desk</h1>
      </div>
      <p>Everything imports to this device only</p>
    </div>

    <div class="drop-zone" use:fileDrop={{ onFiles: (files) => void importFiles(files) }}>
      <h2>Drop files to import</h2>
      <p>
        Markdown files, referenced images and assets, whole folders where the browser supports
        them, or a zip. Relative paths are preserved exactly as native attn sees them.
      </p>
      <!-- ".attn-workspace (soon)" shipped a roadmap note in product chrome
           (attn-08fa.8): it advertises a format the page cannot accept, so the
           only thing a reader can do with it is try and fail. -->
      <div class="formats">.md · images &amp; assets · folder · .zip</div>
      <div class="storage-actions drop-zone-actions">
        <button class="button primary" type="button" onclick={() => fileInput?.click()}>
          Choose files
        </button>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".md,.markdown,image/*,application/zip,.zip,*/*"
        class="visually-removed"
        aria-hidden="true"
        tabindex="-1"
        onchange={onFilesPicked}
      />
      {#if importError}
        <!-- Title, next step, then the raw message as evidence — the same shape
             the storage page and reviewer-lifecycle use (attn-08fa.8). It read
             "Import failed: {raw DOMException}", which names no cause the reader
             can act on. -->
        <div class="form-error" role="alert">
          <strong>Those files didn’t import</strong>
          <p>Nothing was added to your desk. Check the files are Markdown, images, a folder, or a zip, then try again.</p>
          <small>{importError}</small>
        </div>
      {/if}
    </div>
  </main>
</div>
