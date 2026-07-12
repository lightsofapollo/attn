<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import {
    expandPicked,
    pickedFilesFromDrop,
    pickedFilesFromList,
    prepareImport,
    type PickedFile,
  } from './import-files';
  import type { ImportFileInput, StorageHealth } from './types';

  interface Props {
    health: StorageHealth;
    onImport: (name: string, files: ImportFileInput[]) => Promise<void>;
  }

  const { health, onImport }: Props = $props();

  let fileInput = $state<HTMLInputElement | undefined>();
  let importError = $state<string | null>(null);
  let dropActive = $state(false);
  let importing = $state(false);

  async function importPicked(picked: PickedFile[]): Promise<void> {
    if (picked.length === 0 || importing) return;
    importError = null;
    importing = true;
    try {
      const prepared = prepareImport(await expandPicked(picked));
      await onImport(prepared.name, prepared.files);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      importing = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function onFilesPicked(): Promise<void> {
    const files = fileInput?.files;
    if (!files || files.length === 0) return;
    await importPicked(await pickedFilesFromList(files));
  }

  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dropActive = true;
    event.dataTransfer.dropEffect = 'copy';
  }

  async function onDrop(event: DragEvent): Promise<void> {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    event.preventDefault();
    dropActive = false;
    await importPicked(await pickedFilesFromDrop(transfer));
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
        <div class="eyebrow">Import handoff</div>
        <h1>Import into your desk</h1>
      </div>
      <p>Everything imports to this device only</p>
    </div>

    <div
      class="drop-zone"
      role="group"
      aria-label="Import files"
      class:drop-zone-active={dropActive}
      data-drop-active={dropActive}
      ondragenter={onDragOver}
      ondragover={onDragOver}
      ondragleave={() => (dropActive = false)}
      ondrop={(event) => void onDrop(event)}
    >
      <h2>{dropActive ? 'Release to import' : 'Drop files to import'}</h2>
      <p>
        Markdown files, referenced images and assets, whole folders where the browser supports
        them, or a zip. Relative paths are preserved exactly as native attn sees them.
      </p>
      <div class="formats">.md · images &amp; assets · folder · .zip · .attn-workspace (soon)</div>
      <div class="storage-actions" style="justify-content: center;">
        <button class="button primary" type="button" disabled={importing} onclick={() => fileInput?.click()}>
          {importing ? 'Importing…' : 'Choose files'}
        </button>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".md,.markdown,image/*,application/zip,.zip,*/*"
        style="display: none"
        aria-hidden="true"
        tabindex="-1"
        onchange={onFilesPicked}
      />
      {#if importError}
        <p role="alert" style="color: var(--rust-deep); font: 0.9rem/1.5 var(--sans);">
          Import failed: {importError}
        </p>
      {/if}
    </div>
  </main>
</div>
