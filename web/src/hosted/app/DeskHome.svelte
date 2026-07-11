<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import type { SharingState, WorkspaceService } from './types';

  interface Props {
    service: WorkspaceService;
  }

  const { service }: Props = $props();
  const health = $derived(service.storageHealth());
  const workspaces = $derived(service.listWorkspaces());
  const storageUnavailable = $derived(health.mode === 'unavailable');

  function sharingLabel(sharing: SharingState): string {
    switch (sharing) {
      case 'shared':
        return 'Shared';
      case 'backed-up':
        return 'Backed up';
      case 'local-only':
        return 'Local only';
    }
  }
</script>

<div class="app-shell" data-app-view="home">
  <AppHeader mode={health.mode}>
    {#snippet actions()}
      <a class="button" href="/app/storage">Storage</a>
    {/snippet}
  </AppHeader>
  <main class="desk">
    <DegradedBanner mode={health.mode} />
    <div class="desk-title">
      <div>
        <div class="eyebrow">Local workspaces</div>
        <h1>Your desk</h1>
      </div>
      <p>No account · {health.quotaLabel === 'unavailable' ? 'storage unavailable' : `${health.quotaLabel} available`}</p>
    </div>

    <div class="quick-actions">
      <a
        class="quick"
        href="/app#new"
        data-action="new-workspace"
        aria-disabled={storageUnavailable ? 'true' : undefined}
      >
        <span>One click · starts with untitled.md</span>
        <big>＋ New workspace</big>
      </a>
      <a class="quick" href="/open">
        <span>Markdown, images, folders, or zip</span>
        <big>↥ Import workspace</big>
      </a>
      <a class="quick" href="/app#join" data-action="join-review">
        <span>Browser or native link</span>
        <big>↗ Join a review</big>
      </a>
    </div>

    {#if workspaces.length > 0}
      <div class="folio-label">Recently on this device</div>
      {#each workspaces as workspace (workspace.id)}
        <a class="workspace-row" href={`/app/w/${workspace.id}/${workspace.openPath}`}>
          <strong>{workspace.name}</strong>
          <span class="detail">
            {workspace.markdownCount + workspace.assetCount}
            {workspace.markdownCount + workspace.assetCount === 1 ? 'file' : 'files'}
          </span>
          <span class="detail">{workspace.lastEditedLabel}</span>
          {#if workspace.sharing === 'shared'}
            <span class="local-badge"><span class="dot" aria-hidden="true"></span> Shared</span>
          {:else}
            <span>{sharingLabel(workspace.sharing)}</span>
          {/if}
        </a>
      {/each}
    {:else if !storageUnavailable}
      <div class="folio-label">Your first sheet</div>
      <article class="empty-desk" aria-label="A half-written Markdown sheet, waiting">
        <div class="meta">UNTITLED.MD · NOT CREATED YET</div>
        <h2>What deserves your attention?</h2>
        <p>
          Start with one blank Markdown file. It stays on this device — no account, no upload,
          <span class="cursor-line">no naming step.&nbsp;<span class="caret" aria-hidden="true"></span></span>
        </p>
      </article>
    {/if}
  </main>
</div>
