<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import { expandPicked, prepareImport, type PickedFile } from './import-files';
  import type { ImportFileInput, StorageHealth, WorkspaceSummary } from './types';

  interface Props {
    health: StorageHealth;
    workspaces: WorkspaceSummary[];
    rooms: string[];
    onImport: (name: string, files: ImportFileInput[]) => Promise<void>;
    onExportWorkspace: (workspaceId: string) => Promise<void>;
    onExportAll: () => Promise<void>;
    onClearAll: () => Promise<void>;
    onForgetRoom: (roomId: string) => Promise<void>;
  }

  const {
    health,
    workspaces,
    rooms,
    onImport,
    onExportWorkspace,
    onExportAll,
    onClearAll,
    onForgetRoom,
  }: Props = $props();
  const meterWarn = $derived(health.mode === 'quota-pressure');

  // Destructive action uses an in-app confirmation panel, never a browser
  // confirm dialog.
  let confirmingClear = $state(false);
  let confirmingForget = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let importInput = $state<HTMLInputElement | undefined>();

  async function guard(action: () => Promise<void>): Promise<void> {
    actionError = null;
    try {
      await action();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function onBackupPicked(): Promise<void> {
    const files = importInput?.files;
    if (!files || files.length === 0) return;
    await guard(async () => {
      const picked: PickedFile[] = [];
      for (const file of Array.from(files)) {
        picked.push({
          name: file.name,
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      const prepared = prepareImport(await expandPicked(picked));
      await onImport(prepared.name, prepared.files);
    });
    if (importInput) importInput.value = '';
  }

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
            <button class="button" type="button" onclick={() => void guard(() => onExportWorkspace(workspace.id))}>
              Export
            </button>
          </div>
        {:else}
          <p style="color: var(--hosted-muted); font: 0.92rem/1.5 var(--sans);">
            No local workspaces in this browser profile yet.
          </p>
        {/each}
        <div class="storage-actions">
          <button class="button primary" type="button" onclick={() => void guard(onExportAll)}>
            Export all workspaces
          </button>
          <button class="button" type="button" onclick={() => importInput?.click()}>
            Import backup
          </button>
          <input
            bind:this={importInput}
            type="file"
            multiple
            style="display: none"
            aria-hidden="true"
            tabindex="-1"
            onchange={() => void onBackupPicked()}
          />
        </div>
        {#if actionError}
          <p role="alert" style="color: var(--rust-deep); font: 0.9rem/1.5 var(--sans);">
            {actionError}
          </p>
        {/if}

        <h2 style="margin-top: 3rem;">Remembered review rooms</h2>
        <p style="color: var(--hosted-muted); font: 0.88rem/1.5 var(--sans); max-width: 52ch;">
          Forgetting a room crypto-erases its local key first — the sealed copy on this device
          becomes permanently unreadable. The room itself keeps running for other participants.
        </p>
        {#each rooms as roomId (roomId)}
          <div class="workspace-row">
            <strong style="font: 0.85rem var(--mono);">{roomId}</strong>
            <span class="detail">E2EE review room</span>
            <span class="detail"></span>
            <button
              class="button danger"
              type="button"
              onclick={() => (confirmingForget = roomId)}
            >
              Forget
            </button>
          </div>
          {#if confirmingForget === roomId}
            <div class="confirm-clear" role="alertdialog" aria-label={`Forget room ${roomId}?`}>
              <strong>Forget this room on this device?</strong>
              <p style="margin: 0.3rem 0 0; color: var(--hosted-muted);">
                The local key is deleted first, so the remembered copy can never be read again
                here. Your invite link (if you still have it) can rejoin while the room lives.
              </p>
              <div class="actions">
                <button class="button" type="button" onclick={() => (confirmingForget = null)}>
                  Cancel
                </button>
                <button
                  class="button danger"
                  type="button"
                  onclick={async () => {
                    await guard(() => onForgetRoom(roomId));
                    confirmingForget = null;
                  }}
                >
                  Forget room
                </button>
              </div>
            </div>
          {/if}
        {:else}
          <p style="color: var(--hosted-muted); font: 0.92rem/1.5 var(--sans);">
            No remembered review rooms in this browser profile.
          </p>
        {/each}
      </section>

      <aside class="storage-panel" aria-label="Persistence and quota">
        <div class="status-box" class:warn={persistenceStatus.warn}>
          <strong>{persistenceStatus.headline}</strong>
          <p>{persistenceStatus.detail}</p>
          <div class="meter" class:warn={meterWarn} role="presentation">
            <span style={`width: ${Math.round(health.usedFraction * 100)}%`}></span>
          </div>
          <small>{health.usedLabel} used of about {health.quotaLabel} available</small>
          <p style="margin-top: 0.6rem; font: 0.72rem var(--mono); color: var(--hosted-muted);">
            Large files use the browser's origin file system when available and fall back to
            encrypted database storage when it isn't. Either way, content is sealed.
          </p>
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
            <p style="margin: 0.3rem 0 0; color: var(--hosted-muted);">
              This cannot be undone. Shared rooms are not recalled, but their local source copies
              are removed.
            </p>
            <div class="actions">
              <button class="button" type="button" onclick={() => (confirmingClear = false)}>
                Cancel
              </button>
              <button
                class="button danger"
                type="button"
                onclick={async () => {
                  await guard(onClearAll);
                  confirmingClear = false;
                }}
              >
                Delete everything
              </button>
            </div>
          </div>
        {/if}
      </aside>
    </div>
  </main>
</div>
