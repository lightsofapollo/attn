<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import type { StorageHealth, WorkspaceSummary } from './types';

  interface Props {
    health: StorageHealth;
    workspaces: WorkspaceSummary[];
  }

  const { health, workspaces }: Props = $props();
  const meterWarn = $derived(health.mode === 'quota-pressure');

  // Destructive action uses an in-app confirmation panel, never a browser
  // confirm dialog.
  let confirmingClear = $state(false);

  const persistenceStatus = $derived.by(() => {
    switch (health.mode) {
      case 'persistent':
        return {
          headline: '● Protected from automatic cleanup',
          detail:
            'This origin has persistent storage. Clearing Safari website data still removes it.',
          warn: false,
        };
      case 'best-effort':
        return {
          headline: '◐ Best-effort storage',
          detail:
            'The browser may evict this origin under pressure. On iOS, adding attn to the Home Screen improves persistence. Keep Markdown backups current.',
          warn: true,
        };
      case 'session-only':
        return {
          headline: '◌ Private session',
          detail:
            'This private session may erase your desk when it closes. Export anything you need to keep.',
          warn: true,
        };
      case 'quota-pressure':
        return {
          headline: '▲ Storage is nearly full',
          detail:
            'Writes are paused so nothing is silently overwritten. Export or delete a workspace to continue.',
          warn: true,
        };
      case 'unavailable':
        return {
          headline: '⊘ Local storage unavailable',
          detail:
            'This browser currently blocks local document storage (for example Lockdown Mode). Nothing can be stored or cleared here.',
          warn: true,
        };
    }
  });
</script>

<div class="app-shell" data-app-view="storage">
  <AppHeader mode={health.mode}>
    {#snippet actions()}
      <a class="button" href="/app">Back to your desk</a>
    {/snippet}
  </AppHeader>
  <main class="desk">
    <DegradedBanner mode={health.mode} />
    <div class="desk-title">
      <div>
        <div class="eyebrow">This browser profile</div>
        <h1>Storage &amp; recovery</h1>
      </div>
      <p>Nothing here is stored in an attn account</p>
    </div>

    <div class="storage-grid">
      <section class="storage-panel" aria-label="Local workspaces">
        <h2>Local workspaces</h2>
        {#each workspaces as workspace (workspace.id)}
          <div class="workspace-row">
            <strong>{workspace.name}</strong>
            <span class="detail">{workspace.sizeLabel}</span>
            <span class="detail">{workspace.backupLabel}</span>
            <button class="button" type="button">Export</button>
          </div>
        {:else}
          <p style="color: var(--muted); font: 0.92rem/1.5 var(--sans);">
            No local workspaces in this browser profile yet.
          </p>
        {/each}
        <div class="storage-actions">
          <button class="button primary" type="button">Export all Markdown</button>
          <button class="button" type="button">Import backup</button>
        </div>
      </section>

      <aside class="storage-panel" aria-label="Persistence and quota">
        <div class="status-box" class:warn={persistenceStatus.warn}>
          <strong>{persistenceStatus.headline}</strong>
          <p>{persistenceStatus.detail}</p>
          <div class="meter" class:warn={meterWarn} role="presentation">
            <span style={`width: ${Math.round(health.usedFraction * 100)}%`}></span>
          </div>
          <small>{health.usedLabel} used of about {health.quotaLabel} available</small>
        </div>

        {#if !confirmingClear}
          <button
            class="button danger"
            type="button"
            style="margin-top: 1rem;"
            onclick={() => (confirmingClear = true)}
          >
            Clear all local attn data
          </button>
        {:else}
          <div class="confirm-clear" role="alertdialog" aria-label="Confirm clearing all local attn data">
            <strong>Delete every local workspace in this browser?</strong>
            <p style="margin: 0.3rem 0 0; color: var(--muted);">
              This cannot be undone. Shared rooms are not recalled, but their local source copies
              are removed.
            </p>
            <div class="actions">
              <button class="button" type="button" onclick={() => (confirmingClear = false)}>
                Cancel
              </button>
              <button class="button danger" type="button">Delete everything</button>
            </div>
          </div>
        {/if}
      </aside>
    </div>
  </main>
</div>
