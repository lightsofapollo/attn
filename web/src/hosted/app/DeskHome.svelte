<script lang="ts">
  import AppHeader from './AppHeader.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import { expandPicked, prepareImport, type PickedFile } from './import-files';
  import { autofocus } from '../../lib/hosted/autofocus';
  import { parseInviteUrl } from '../../lib/hosted/invite-url';
  import type { ImportFileInput, SharingState, StorageHealth, WorkspaceSummary } from './types';

  interface Props {
    health: StorageHealth;
    workspaces: WorkspaceSummary[];
    /** Open the Join panel on mount (/app#join, attn-ri1). */
    joinIntent?: boolean;
    onCreate: () => void;
    onImport: (name: string, files: ImportFileInput[]) => Promise<void>;
    onRename: (workspaceId: string, name: string) => Promise<void>;
    onDelete: (workspaceId: string) => Promise<void>;
  }

  const { health, workspaces, joinIntent = false, onCreate, onImport, onRename, onDelete }: Props = $props();

  // Join a review (attn-ri1): #join was a dead click — the landing card and
  // the desk quick link both promised a flow that didn't exist. The panel
  // accepts a pasted invite (hosted /review or /s link, or a native attn://
  // URL) and navigates with the fragment — where the room key lives — intact.
  // svelte-ignore state_referenced_locally — open-time intent, deliberate.
  let joinOpen = $state(joinIntent);
  let joinValue = $state('');
  let joinError = $state<string | null>(null);
  let joinInput = $state<HTMLInputElement | undefined>();

  function openJoin(event: MouseEvent): void {
    event.preventDefault();
    joinOpen = true;
    joinError = null;
  }

  // Focus the paste field whichever way the panel opened (#join intent or
  // the quick-link click).
  $effect(() => {
    if (joinOpen) joinInput?.focus();
  });

  function closeJoin(): void {
    joinOpen = false;
    joinError = null;
    if (window.location.hash === '#join') history.replaceState(null, '', '/app');
  }

  function submitJoin(event: SubmitEvent): void {
    event.preventDefault();
    const invite = parseInviteUrl(joinValue);
    if (!invite) {
      joinError = 'That doesn\u2019t look like an attn invite \u2014 paste the full link, including everything after #.';
      return;
    }
    window.location.assign(invite.href);
  }
  const storageUnavailable = $derived(health.mode === 'unavailable');

  let fileInput = $state<HTMLInputElement | undefined>();
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let confirmingDeleteId = $state<string | null>(null);
  let importError = $state<string | null>(null);

  function sharingLabel(sharing: SharingState): string {
    switch (sharing) {
      case 'shared':
        return 'Shared · relay sees only ciphertext';
      case 'backed-up':
        return 'Backed up';
      case 'local-only':
        return 'Local only';
    }
  }

  async function onFilesPicked(): Promise<void> {
    const files = fileInput?.files;
    if (!files || files.length === 0) return;
    importError = null;
    try {
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
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }

  function startRename(workspace: WorkspaceSummary): void {
    renamingId = workspace.id;
    renameValue = workspace.name;
    confirmingDeleteId = null;
  }

  async function commitRename(): Promise<void> {
    if (renamingId && renameValue.trim().length > 0) {
      await onRename(renamingId, renameValue.trim());
    }
    renamingId = null;
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
      <button
        class="quick"
        type="button"
        data-action="new-workspace"
        disabled={storageUnavailable}
        onclick={onCreate}
      >
        <span>One click · starts with untitled.md</span>
        <big>＋ New workspace</big>
      </button>
      <button
        class="quick"
        type="button"
        data-action="import-workspace"
        disabled={storageUnavailable}
        onclick={() => fileInput?.click()}
      >
        <span>Markdown, images, folders, or zip</span>
        <big>↥ Import workspace</big>
      </button>
      <a class="quick" href="/app#join" data-action="join-review" onclick={openJoin}>
        <span>Browser or native link</span>
        <big>↗ Join a review</big>
      </a>
    </div>
    {#if joinOpen}
      <form
        class="join-panel"
        data-slot="join-panel"
        onsubmit={submitJoin}
        aria-label="Join a review"
      >
        <label for="join-invite-input">Paste an invite link</label>
        <div class="join-row">
          <!-- svelte-ignore a11y_autofocus — the panel exists to receive the paste. -->
          <input
            id="join-invite-input"
            bind:this={joinInput}
            bind:value={joinValue}
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="https://attn.sh/s/… or attn://review/…"
          />
          <button class="join-go" type="submit">Join</button>
          <button class="join-cancel" type="button" onclick={closeJoin}>Cancel</button>
        </div>
        {#if joinError}
          <p class="join-error" role="alert">{joinError}</p>
        {:else}
          <p class="join-hint">
            The part after <code>#</code> is the room key — it never reaches the relay.
          </p>
        {/if}
      </form>
    {/if}
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
      <p class="form-error" role="alert">
        Import failed: {importError}
      </p>
    {/if}

    {#if workspaces.length > 0}
      <div class="folio-label">Recently on this device</div>
      {#each workspaces as workspace (workspace.id)}
        <div class="workspace-row" data-workspace-id={workspace.id}>
          {#if renamingId === workspace.id}
            <input
              use:autofocus
              class="rename-input"
              type="text"
              aria-label="Workspace name"
              bind:value={renameValue}
              onkeydown={(event) => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') renamingId = null;
              }}
              onblur={() => void commitRename()}
            />
          {:else}
            <a class="row-open" href={`/app/w/${workspace.id}/${workspace.openPath}`}>
              <strong>{workspace.name}</strong>
            </a>
          {/if}
          <span class="detail">
            {workspace.markdownCount + workspace.assetCount}
            {workspace.markdownCount + workspace.assetCount === 1 ? 'file' : 'files'}
          </span>
          <span class="detail">{workspace.lastEditedLabel}</span>
          <span class="row-tail">
            {#if workspace.sharing === 'shared'}
              <span class="local-badge" title="The relay stores encrypted envelopes only; the key stays in the link fragment."><span class="dot" aria-hidden="true"></span> Shared · relay sees only ciphertext</span>
            {:else}
              <span>{sharingLabel(workspace.sharing)}</span>
            {/if}
            <button class="row-action" type="button" onclick={() => startRename(workspace)}>
              Rename
            </button>
            <button
              class="row-action danger"
              type="button"
              onclick={() => (confirmingDeleteId = workspace.id)}
            >
              Delete
            </button>
          </span>
        </div>
        {#if confirmingDeleteId === workspace.id}
          <div class="confirm-clear" role="alertdialog" aria-label={`Delete ${workspace.name}?`}>
            <strong>Delete “{workspace.name}” from this device?</strong>
            <p style="margin: 0.3rem 0 0; color: var(--hosted-muted);">
              This cannot be undone. Export it first if you need a copy.
            </p>
            <div class="actions">
              <button class="button" type="button" onclick={() => (confirmingDeleteId = null)}>
                Cancel
              </button>
              <button
                class="button danger"
                type="button"
                onclick={async () => {
                  await onDelete(workspace.id);
                  confirmingDeleteId = null;
                }}
              >
                Delete workspace
              </button>
            </div>
          </div>
        {/if}
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
