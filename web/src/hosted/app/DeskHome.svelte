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
    // Push the hash the close path already assumes exists (attn-n01r.40).
    // /app#join opened the panel on a real load, but clicking the tile only set
    // local state, so a reload lost it — while closeJoin() unconditionally
    // replaced the URL as though the hash were present. The two paths now agree.
    if (window.location.hash !== '#join') history.pushState(null, '', '/app#join');
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
    // Return focus to the control that opened the panel (attn-n01r.30).
    // DESIGN.md's Topmost-Escape Rule: "Every overlay stores focus on open and
    // restores it on close." The open half was already right — the panel
    // focuses its input — but closing dropped focus to the document.
    joinTrigger?.focus();
  }

  let joinTrigger = $state<HTMLAnchorElement | undefined>();

  /** Escape closes the topmost layer; "/" focuses the filter; arrows move. */
  function onDeskKeydown(event: KeyboardEvent): void {
    if (event.key === '/' && !typingInField(event.target) && workspaces.length > 0) {
      event.preventDefault();
      filterInput?.focus();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !confirmingDeleteId) {
      if (!typingInField(event.target) || event.target === filterInput) {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
    }
    if (event.key === 'Enter' && event.target === filterInput && selectedIndex >= 0) {
      event.preventDefault();
      openWorkspace(visibleWorkspaces[selectedIndex]);
      return;
    }
    if (event.key !== 'Escape') return;
    if (filterQuery && event.target === filterInput) {
      event.stopPropagation();
      filterQuery = '';
      selectedIndex = -1;
      return;
    }
    if (confirmingDeleteId !== null) {
      event.stopPropagation();
      cancelDelete();
      return;
    }
    if (joinOpen) {
      event.stopPropagation();
      closeJoin();
    }
  }

  /* The delete confirm announces role="alertdialog" but never behaved like one:
     focus was never moved into it, was not trapped, and Escape did not dismiss
     it, so a screen-reader user was told a dialog opened and then found focus
     still on the Delete button behind it (attn-n01r.30). These remember the
     invoking button so focus can go back where it came from. */
  let deleteTrigger: HTMLButtonElement | undefined;

  function openDeleteConfirm(workspaceId: string, trigger: HTMLButtonElement): void {
    deleteTrigger = trigger;
    confirmingDeleteId = workspaceId;
  }

  function cancelDelete(): void {
    confirmingDeleteId = null;
    deleteTrigger?.focus();
    deleteTrigger = undefined;
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

  /* Keyboard model (attn-n01r.29). The desk scored 0/4 on Flexibility and
     Efficiency — the sole keyboard handler in this file was Enter/Escape inside
     the rename input — on the surface PRODUCT.md's primary user opens most, for
     a product whose stated principle is that every action is keyboard-reachable.

     Three things, which is what the finding asked for: a "/" filter that
     narrows the list live, Up/Down to move a selection through it, and Enter to
     open. Selection hangs off the workspace id the rows already carry. */
  let filterQuery = $state('');
  let filterInput = $state<HTMLInputElement | undefined>();
  let selectedIndex = $state(-1);

  const visibleWorkspaces = $derived.by(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q));
  });

  // Keep the selection inside the filtered list as it narrows.
  $effect(() => {
    if (selectedIndex >= visibleWorkspaces.length) selectedIndex = visibleWorkspaces.length - 1;
  });

  function openWorkspace(workspace: WorkspaceSummary): void {
    window.location.assign(`/app/w/${workspace.id}/${workspace.openPath}`);
  }

  function moveSelection(delta: number): void {
    if (visibleWorkspaces.length === 0) return;
    const next = selectedIndex < 0
      ? (delta > 0 ? 0 : visibleWorkspaces.length - 1)
      : Math.min(Math.max(selectedIndex + delta, 0), visibleWorkspaces.length - 1);
    selectedIndex = next;
    document
      .querySelector<HTMLElement>(`[data-workspace-id="${visibleWorkspaces[next].id}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  /** True while a control that owns its own key handling has focus. */
  function typingInField(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }
  let importError = $state<string | null>(null);

  /** Label for the non-shared states. The 'shared' case is handled in the
   *  template, which needs the explanatory title attribute alongside it — this
   *  used to carry an unreachable duplicate of that string (attn-n01r.44). */
  function sharingLabel(sharing: Exclude<SharingState, 'shared'>): string {
    switch (sharing) {
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

<svelte:window onkeydown={onDeskKeydown} />

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

    {#if storageUnavailable}
      <!-- The reason the primary actions cannot be used (attn-n01r.46). The
           `disabled` attribute removes them from the tab order, so a keyboard
           user never encounters them and is never told why. aria-disabled keeps
           them reachable and announced; this element supplies the explanation
           they point at. -->
      <p id="storage-blocked-reason" class="form-error" role="alert">
        This browser profile cannot store workspaces, so creating and importing are unavailable.
        Check private-browsing or site-data settings, then reload.
      </p>
    {/if}
    <div class="quick-actions">
      <button
        class="quick"
        type="button"
        data-action="new-workspace"
        aria-disabled={storageUnavailable}
        aria-describedby={storageUnavailable ? 'storage-blocked-reason' : undefined}
        onclick={() => {
          if (storageUnavailable) return;
          onCreate();
        }}
      >
        <strong class="quick-label">New workspace</strong>
        <span class="quick-note">One click · starts with untitled.md</span>
      </button>
      <button
        class="quick"
        type="button"
        data-action="import-workspace"
        aria-disabled={storageUnavailable}
        aria-describedby={storageUnavailable ? 'storage-blocked-reason' : undefined}
        onclick={() => {
          if (storageUnavailable) return;
          fileInput?.click();
        }}
      >
        <strong class="quick-label">Import workspace</strong>
        <span class="quick-note">Markdown, images, folders, or zip</span>
      </button>
      <a
        class="quick"
        href="/app#join"
        data-action="join-review"
        bind:this={joinTrigger}
        aria-expanded={joinOpen}
        aria-controls="join-panel"
        onclick={openJoin}
      >
        <strong class="quick-label">Join a review</strong>
        <span class="quick-note">Browser or native link</span>
      </a>
    </div>
    {#if joinOpen}
      <form
        id="join-panel"
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
            aria-invalid={joinError ? 'true' : undefined}
            aria-describedby={joinError ? 'join-error' : 'join-hint'}
            placeholder="https://attn.sh/s/… or attn://review/…"
          />
          <button class="join-go" type="submit">Join</button>
          <button class="join-cancel" type="button" onclick={closeJoin}>Cancel</button>
        </div>
        {#if joinError}
          <p id="join-error" class="join-error" role="alert">{joinError}</p>
        {:else}
          <p id="join-hint" class="join-hint">
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
      <!-- A real heading, and a real list (attn-n01r.30). Without both, the
           populated desk exposes LESS structure than the empty state, which has
           its own <h2>: a flat run of divs announces no "list, N items", no
           item position, and gives no way to jump to it. -->
      <div class="folio-head">
        <h2 class="folio-label" id="recent-workspaces">Recently on this device</h2>
        <div class="folio-filter">
          <label class="visually-hidden" for="workspace-filter">Filter workspaces</label>
          <input
            id="workspace-filter"
            bind:this={filterInput}
            bind:value={filterQuery}
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Filter…"
          />
          <kbd aria-hidden="true">/</kbd>
        </div>
      </div>
      <p class="visually-hidden" role="status" aria-live="polite">
        {filterQuery ? `${visibleWorkspaces.length} of ${workspaces.length} workspaces match` : ''}
      </p>
      <ul class="workspace-list" aria-labelledby="recent-workspaces">
      {#each visibleWorkspaces as workspace, index (workspace.id)}
        <li>
        <div
          class="workspace-row"
          data-workspace-id={workspace.id}
          data-selected={index === selectedIndex ? 'true' : undefined}
        >
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
          <!-- On a phone this is one wrapping fact group, not three inherited
               grid cells. On desktop `display: contents` keeps the original
               compact table scan. -->
          <span class="detail-group">
            <span class="detail">
              {workspace.markdownCount + workspace.htmlCount + workspace.assetCount}
              {workspace.markdownCount + workspace.htmlCount + workspace.assetCount === 1 ? 'file' : 'files'}
            </span>
            <span class="detail">{workspace.lastEditedLabel}</span>
            <!-- sizeLabel is computed in toSummary and was never rendered
                 (attn-n01r.6). Showing it makes an empty workspace legibly empty
                 — "0 B" rather than a name that looks like it holds something.
                 This does not decide what New workspace should create; it stops
                 the desk from hiding the answer. -->
            <span class="detail detail-size">{workspace.sizeLabel}</span>
          </span>
          <!-- Review work outranks file facts on a reviewer's desk
               (attn-n01r.34): "3 suggestions waiting" is why you would open
               this workspace; "6 files" is not. Rendered only when the
               workspace actually has a review log, so a local-only row shows
               nothing rather than a zero. -->
          {#if workspace.review && (workspace.review.pendingSuggestions > 0 || workspace.review.openComments > 0)}
            <span class="detail review-pill" data-slot="review-counts">
              {#if workspace.review.pendingSuggestions > 0}
                <span class="review-suggestions">
                  {workspace.review.pendingSuggestions}
                  {workspace.review.pendingSuggestions === 1 ? 'suggestion' : 'suggestions'}
                </span>
              {/if}
              {#if workspace.review.openComments > 0}
                <span class="review-comments">
                  {workspace.review.openComments}
                  {workspace.review.openComments === 1 ? 'comment' : 'comments'}
                </span>
              {/if}
            </span>
          {/if}
          <!-- Touch gets one explicitly named overflow action. The full card
               stays the open target; Rename and Delete remain separately
               reachable from this compact menu. Desktop keeps the fast icons. -->
          <details class="row-menu">
            <summary aria-label={`Manage ${workspace.name}`} title={`Manage ${workspace.name}`}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
                <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            </summary>
            <div class="row-menu-popover">
              <button type="button" onclick={() => startRename(workspace)}>Rename</button>
              <button
                class="danger"
                type="button"
                onclick={(event) => openDeleteConfirm(workspace.id, event.currentTarget)}
              >Delete</button>
            </div>
          </details>
          <div class="row-tail">
            {#if workspace.sharing === 'shared'}
              <span class="row-status local-badge" title="The relay stores encrypted envelopes only; the key stays in the link fragment."><span class="dot" aria-hidden="true"></span> Shared · relay sees only ciphertext</span>
            {:else}
              <span class="row-status">{sharingLabel(workspace.sharing)}</span>
            {/if}
            <!-- Icons, not words (attn-n01r.2). These repeat on every row, so at
                 James's realistic workspace count the three most-repeated words
                 on the desk were "Rename, Delete, Rename, Delete…". Pencil and
                 trash are conventional enough to read without the word; both
                 keep a title for hover and an aria-label naming the workspace,
                 so nothing is lost to assistive tech or to a first-timer who
                 hovers. -->
            <div class="row-desktop-actions">
              <button
                class="row-action"
                type="button"
                title="Rename"
                aria-label={`Rename ${workspace.name}`}
                onclick={() => startRename(workspace)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                class="row-action danger"
                type="button"
                title="Delete"
                aria-label={`Delete ${workspace.name}`}
                onclick={(event) => openDeleteConfirm(workspace.id, event.currentTarget)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1v2" />
                  <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        {#if confirmingDeleteId === workspace.id}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <div
            class="confirm-clear"
            role="alertdialog"
            aria-modal="true"
            tabindex="-1"
            use:autofocus
            aria-label={`Delete ${workspace.name}?`}
          >
            <strong>Delete “{workspace.name}” from this device?</strong>
            <p style="margin: 0.3rem 0 0; color: var(--hosted-muted);">
              This cannot be undone. Export it first if you need a copy.
            </p>
            <div class="actions">
              <button class="button" type="button" onclick={cancelDelete}>
                Cancel
              </button>
              <button
                class="button danger"
                type="button"
                onclick={async () => {
                  await onDelete(workspace.id);
                  confirmingDeleteId = null;
                  deleteTrigger = undefined;
                }}
              >
                Delete workspace
              </button>
            </div>
          </div>
        {/if}
        </li>
      {/each}
      </ul>
    {:else if !storageUnavailable}
      <h2 class="folio-label">Your first sheet</h2>
      <!-- A button, not an <article> (attn-n01r.35). This is the largest,
           warmest, most document-like object on the first-run screen and it had
           no click handler at all — every first-time user clicks it. It is also
           the same offer as the tile above, so it now performs that offer
           rather than restating it.
           The old aria-label ("A half-written Markdown sheet, waiting") named
           the region with art direction that explained nothing about what to do
           and contradicted its own content; the button's text is its name. -->
      <button
        class="empty-desk"
        type="button"
        disabled={storageUnavailable}
        onclick={onCreate}
      >
        <span class="meta">UNTITLED.MD · NOT CREATED YET</span>
        <span class="empty-desk-title">What deserves your attention?</span>
        <span class="empty-desk-body">
          Start with one blank Markdown file. It stays on this device — no account, no upload,
          <span class="cursor-line">no naming step.&nbsp;<span class="caret" aria-hidden="true"></span></span>
        </span>
      </button>
    {/if}
  </main>
</div>
