<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import ShareSheet from './ShareSheet.svelte';
  import type { StorageHealth, WorkspaceAppService, WorkspaceDetail, WorkspaceEntry } from './types';

  interface Props {
    service: WorkspaceAppService;
    workspace: WorkspaceDetail;
    activePath: string | undefined;
    /** Decoded head body when the active entry is Markdown; null otherwise. */
    bodyText?: string | null;
    isNewDraft?: boolean;
  }

  const { service, workspace, activePath, bodyText = null, isNewDraft = false }: Props = $props();

  const health: StorageHealth = $derived(service.storageHealth());
  const activeEntry = $derived(
    workspace.entries.find((entry) => entry.path === activePath) ?? workspace.entries[0],
  );
  const markdownEntries = $derived(
    workspace.entries.filter((entry) => entry.presentation === 'editable'),
  );
  const assetEntries = $derived(
    workspace.entries.filter((entry) => entry.presentation !== 'editable'),
  );

  let shareOpen = $state(false);
  let filesSheetOpen = $state(false);
  let reviewSheetOpen = $state(false);
  let shareButton = $state<HTMLButtonElement | undefined>();
  let dockFilesButton = $state<HTMLButtonElement | undefined>();
  let dockReviewButton = $state<HTMLButtonElement | undefined>();

  function entryHref(entry: WorkspaceEntry): string {
    return `/app/w/${workspace.id}/${entry.path}`;
  }

  function entryGlyph(entry: WorkspaceEntry): string {
    if (entry.presentation === 'editable') return '';
    return entry.presentation === 'preview' ? '▧ ' : '◇ ';
  }

  function closeShare(): void {
    shareOpen = false;
    shareButton?.focus();
  }

  function closeFilesSheet(): void {
    filesSheetOpen = false;
    dockFilesButton?.focus();
  }

  function closeReviewSheet(): void {
    reviewSheetOpen = false;
    dockReviewButton?.focus();
  }
</script>

<div class="editor-shell" data-app-view="workspace" data-workspace-id={workspace.id}>
  <header class="editor-top">
    <div class="top-brand">
      <a class="brand" href="/app" aria-label="Back to your desk">
        <span class="mark" aria-hidden="true">a.</span>attn
      </a>
    </div>
    <div class="doc-name">
      {workspace.name}
      <span class="save-state" data-save-state={workspace.saveState}>· {workspace.saveState}</span>
    </div>
    <div class="share-action">
      <button
        class="button primary"
        type="button"
        bind:this={shareButton}
        onclick={() => (shareOpen = true)}
      >
        Share
      </button>
    </div>
  </header>

  <div class="editor-grid">
    <aside class="file-rail" aria-label="Workspace files">
      <div class="rail-title">
        On this device · {workspace.entries.length}
        {workspace.entries.length === 1 ? 'entry' : 'entries'}
      </div>
      <ul class="file-list">
        {#each markdownEntries as entry (entry.path)}
          <li>
            <a
              class="file"
              class:active={entry.path === activeEntry?.path}
              href={entryHref(entry)}
              aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
            >
              {entry.path}
              <span class="file-size">{entry.sizeLabel}</span>
            </a>
          </li>
        {/each}
        {#each assetEntries as entry (entry.path)}
          <li>
            <a
              class="file asset"
              class:active={entry.path === activeEntry?.path}
              href={entryHref(entry)}
              aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
            >
              {entryGlyph(entry)}{entry.path}
              <span class="file-size">{entry.sizeLabel}</span>
            </a>
          </li>
        {/each}
      </ul>
      <button class="file rail-add" type="button">＋ Add file or asset</button>
    </aside>

    <main class="editor-canvas">
      {#if health.mode !== 'persistent' && health.mode !== 'best-effort'}
        <div style="max-width: 760px; margin: 0 auto 1.5rem;">
          <DegradedBanner mode={health.mode} />
        </div>
      {/if}
      <article class="writing-sheet">
        {#if isNewDraft}
          <div class="eyebrow">New workspace</div>
          <h1>Untitled</h1>
          <p class="placeholder">Tap to start writing…</p>
        {:else if activeEntry && activeEntry.presentation !== 'editable'}
          <div class="eyebrow">
            {activeEntry.presentation === 'preview' ? 'Asset preview' : 'Download only'}
          </div>
          <h1>{activeEntry.path}</h1>
          <div class="asset-preview">
            <strong>{activeEntry.path}</strong>
            {#if activeEntry.presentation === 'preview'}
              Safe raster asset · renders inline when storage lands · {activeEntry.sizeLabel}
            {:else}
              This format is never executed here. Download it or open it in native attn ·
              {activeEntry.sizeLabel}
            {/if}
          </div>
        {:else}
          <div class="eyebrow">Working draft</div>
          <h1>{workspace.name}</h1>
          {#if bodyText !== null && bodyText.length > 0}
            <!-- Markdown source view; the editing surface lands in attn-7xl.3.3. -->
            <div class="plain-md" data-body-text>{bodyText}</div>
          {:else if bodyText !== null}
            <p class="placeholder">Start writing…</p>
          {:else}
            <p class="placeholder">This entry has no Markdown body.</p>
          {/if}
        {/if}
      </article>
    </main>

    <aside class="review-rail" aria-label="Review margin">
      <div class="rail-title">Review margin · {workspace.reviewCards.length}</div>
      {#each workspace.reviewCards as card (card.author + card.body)}
        <div class="review-card">
          <strong>{card.author} · {card.ageLabel}</strong>
          {card.body}
        </div>
      {:else}
        <p class="review-empty">
          No review yet. Share this workspace to open an encrypted room around it.
        </p>
      {/each}
    </aside>
  </div>

  <nav class="thumb-dock" aria-label="Document actions">
    <button type="button" bind:this={dockFilesButton} onclick={() => (filesSheetOpen = true)}>
      Files
    </button>
    <button type="button" bind:this={dockReviewButton} onclick={() => (reviewSheetOpen = true)}>
      Review · {workspace.reviewCards.length}
    </button>
    <button type="button">Edit</button>
    <button type="button" onclick={() => (shareOpen = true)}>Share</button>
  </nav>
</div>

{#if shareOpen}
  <ShareSheet
    workspaceName={workspace.name}
    scope={service.shareScopeFor(workspace)}
    {health}
    onclose={closeShare}
  />
{/if}

{#if filesSheetOpen}
  <BottomSheet title={`Files · ${workspace.entries.length}`} onclose={closeFilesSheet}>
    <ul class="file-list">
      {#each workspace.entries as entry (entry.path)}
        <li>
          <a
            class="file"
            class:asset={entry.presentation !== 'editable'}
            class:active={entry.path === activeEntry?.path}
            href={entryHref(entry)}
            aria-current={entry.path === activeEntry?.path ? 'page' : undefined}
          >
            {entryGlyph(entry)}{entry.path}
            <span class="file-size">{entry.sizeLabel}</span>
          </a>
        </li>
      {/each}
    </ul>
  </BottomSheet>
{/if}

{#if reviewSheetOpen}
  <BottomSheet title={`Review · ${workspace.reviewCards.length}`} onclose={closeReviewSheet}>
    {#each workspace.reviewCards as card (card.author + card.body)}
      <div class="review-card">
        <strong>{card.author} · {card.ageLabel}</strong>
        {card.body}
      </div>
    {:else}
      <p class="review-empty" style="margin-top: 0.5rem;">
        No review yet. Share this workspace to open an encrypted room around it.
      </p>
    {/each}
  </BottomSheet>
{/if}
