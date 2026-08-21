<script lang="ts">
  import ConfirmPanel from './ConfirmPanel.svelte';
  import DegradedBanner from './DegradedBanner.svelte';
  import { expandPicked, prepareImport } from './import-files';
  import { filesToPicked, type DroppedFile } from './file-drop';
  import { autofocus } from '../../lib/hosted/autofocus';
  import { appHashIntent, appWorkspaceUrl } from '../../lib/hosted/routes';
  import { deskEnterOpensSelection } from './desk-keys';
  import { parseInviteUrl } from '../../lib/hosted/invite-url';
  import type { ImportFileInput, SharingState, StorageHealth, WorkspaceSummary } from './types';

  interface Props {
    health: StorageHealth;
    workspaces: WorkspaceSummary[];
    /** Owned by the shell so the query survives a trip into a workspace and
     *  back (attn-a9f7.3.1). */
    filterQuery?: string;
    onCreate: (intent?: 'blank' | 'import') => void;
    onImport: (name: string, files: ImportFileInput[]) => Promise<void>;
    onRename: (workspaceId: string, name: string) => Promise<void>;
    onDelete: (workspaceId: string) => Promise<void>;
    onExportWorkspace: (workspaceId: string) => Promise<void>;
    /** In-app open. The rows stay real links for middle-click and copy-link;
     *  this is the keyboard and same-tab path (attn-a9f7.3.1). */
    onOpenWorkspace: (workspaceId: string, filePath: string) => void;
  }

  let {
    health,
    workspaces,
    filterQuery = $bindable(''),
    onCreate,
    onImport,
    onRename,
    onDelete,
    onExportWorkspace,
    onOpenWorkspace,
  }: Props = $props();

  // Join a review (attn-ri1): #join was a dead click — the landing card and
  // the desk quick link both promised a flow that didn't exist. The panel
  // accepts a pasted invite (hosted /review or /s link, or a native attn://
  // URL) and navigates with the fragment — where the room key lives — intact.
  //
  // The URL is asked at every mount, not handed down from boot (attn-ze60.3).
  // The desk unmounts when a workspace opens and mounts again on the way back,
  // so a boot-time `#join` outlived the URL it came from: cancel the panel —
  // which strips the hash — open a workspace, press Back, and it reopened over
  // an address bar that said plain /app. Both halves of the panel's own
  // contract already write to the fragment, which makes it the honest record.
  let joinOpen = $state(appHashIntent(window.location.hash) === 'join');
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
    /* Enter opens the selection from anywhere the arrows can move it
       (attn-a9f7.1.1). This used to require focus in the filter field, so the
       advertised path — press ↓, press Enter — did nothing on a cold desk, and
       the keyboard model stopped one keystroke short of its own payoff.

       It cannot borrow the arrow gate wholesale, though (attn-1l2f.4): the
       handler is on the window, and Enter is how every control on a row is
       activated. Matching the arrow gate meant a focused Rename or Delete
       button answered Enter by opening the selected workspace instead. So
       Enter is the desk's only when no control is holding it. */
    if (event.key === 'Enter' && selectedIndex >= 0 && !confirmingDeleteId) {
      if (deskEnterOpensSelection(event.target as HTMLElement | null, filterInput)) {
        const target = visibleWorkspaces[selectedIndex];
        if (!target) return;
        event.preventDefault();
        openWorkspace(target);
        return;
      }
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

  /* Focus in, Tab trapped, Escape out, focus restored — the whole contract now
     belongs to ConfirmPanel (attn-a9f7.1.2), so the desk and Storage cannot
     drift apart again. */
  function openDeleteConfirm(workspaceId: string): void {
    confirmingDeleteId = workspaceId;
    exportedBeforeDelete = false;
  }

  function cancelDelete(): void {
    confirmingDeleteId = null;
  }

  /* "Export it first" was advice with no affordance (attn-a9f7.1.5): the user
     had to cancel, cross to Storage, export, and come back. */
  let exportedBeforeDelete = $state(false);
  let exportingBeforeDelete = $state(false);

  async function exportBeforeDelete(workspaceId: string): Promise<void> {
    exportingBeforeDelete = true;
    try {
      await onExportWorkspace(workspaceId);
      exportedBeforeDelete = true;
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      exportingBeforeDelete = false;
    }
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
  /* The import tile offers a folder as well as files. `webkitdirectory` is the
     only way a browser hands over a directory tree, and `expandPicked` already
     reads the `webkitRelativePath` it produces. */
  let folderInput = $state<HTMLInputElement | undefined>();

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
  let filterInput = $state<HTMLInputElement | undefined>();
  let selectedIndex = $state(-1);

  const matchingWorkspaces = $derived.by(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q));
  });

  /* The hundredth-visit desk, not the first (attn-a9f7.3.3). PRODUCT.md asks
     for the daily user, and for that reader the question the desk answers is
     "where is work waiting for me", not "what did I touch last". Rows with
     unanswered review work lift into their own group, in the same recency
     order; everything else keeps the list it always had. Neither heading has
     to lie about what it contains. */
  function isWaiting(workspace: WorkspaceSummary): boolean {
    const review = workspace.review;
    return !!review && (review.pendingSuggestions > 0 || review.openComments > 0);
  }

  const waitingWorkspaces = $derived(matchingWorkspaces.filter(isWaiting));
  const recentWorkspaces = $derived(matchingWorkspaces.filter((w) => !isWaiting(w)));

  /* Selection indexes this flat order, so ↑/↓ walk both groups as one list. */
  const visibleWorkspaces = $derived([...waitingWorkspaces, ...recentWorkspaces]);

  // Keep the selection inside the filtered list as it narrows.
  $effect(() => {
    if (selectedIndex >= visibleWorkspaces.length) selectedIndex = visibleWorkspaces.length - 1;
  });

  function openWorkspace(workspace: WorkspaceSummary): void {
    onOpenWorkspace(workspace.id, workspace.openPath);
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

  /* One import path for the tile, the well's two buttons and the well's drop
     (attn-mkmz.5) — they are the same act and must not be able to disagree. */
  async function importPickedFiles(files: Array<File | DroppedFile>): Promise<void> {
    if (files.length === 0) return;
    importError = null;
    try {
      // The shared reader, not a second copy of it: this file had its own
      // File → PickedFile loop, which meant a dropped folder's paths were
      // handled here and only here, and differently from every other surface.
      const prepared = prepareImport(await expandPicked(await filesToPicked(files)));
      await onImport(prepared.name, prepared.files);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      // Reset so re-choosing the same selection fires `change` again.
      if (fileInput) fileInput.value = '';
      if (folderInput) folderInput.value = '';
    }
  }

  async function onFilesPicked(): Promise<void> {
    const files = fileInput?.files;
    if (!files || files.length === 0) return;
    await importPickedFiles(Array.from(files));
  }

  async function onFolderPicked(): Promise<void> {
    const files = folderInput?.files;
    if (!files || files.length === 0) return;
    await importPickedFiles(Array.from(files));
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

<!-- The first-run sheet and the "New workspace" tile are the same offer, and
     both were carrying the pencil (attn-a9f7.1.7). On the empty desk the
     caret keeps it; the tile steps back to ink. -->
<main class="desk" data-desk-state={workspaces.length === 0 ? 'empty' : 'populated'}>
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
        // The tile's own note says "starts with untitled.md" — an explicit
        // request for an empty page, so the canvas does not then offer to
        // import one.
        onCreate('blank');
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
      <label for="join-invite-input">Paste a review link</label>
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
  <input
    bind:this={folderInput}
    type="file"
    webkitdirectory
    style="display: none"
    aria-hidden="true"
    tabindex="-1"
    onchange={onFolderPicked}
  />
  {#if importError}
    <p class="form-error" role="alert">
      Import failed: {importError}
    </p>
  {/if}

  {#if workspaces.length > 0}
    <!-- The filter narrows every group, so it sits above all of them rather
         than inside one (attn-a9f7.3.3). The section headings below name the
         lists — this row would otherwise contribute a third, competing one and
         a duplicate id. Real headings and real lists are still the contract
         (attn-n01r.30); they just belong to the groups now. -->
    <div class="folio-head folio-head-filter-only">
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
        <kbd class="kbd-chip" aria-hidden="true">/</kbd>
      </div>
    </div>
    <p class="visually-hidden" role="status" aria-live="polite">
      {filterQuery ? `${visibleWorkspaces.length} of ${workspaces.length} workspaces match` : ''}
    </p>
    {#snippet workspaceRow(workspace: WorkspaceSummary, index: number)}
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
          <a class="row-open" href={appWorkspaceUrl(workspace.id, workspace.openPath)}>
            <strong>{workspace.name}</strong>
          </a>
        {/if}
        <!-- Second column, not fifth (attn-a9f7.3.3): on a reviewer's desk the
             answer to "why would I open this" outranks the file count, and it
             now sits where the eye lands after the name. The empty cell keeps
             every row's columns aligned without minting a review-counts slot,
             which the share tests read as "review work is waiting". -->
        {#if isWaiting(workspace)}
          <span class="detail review-pill" data-slot="review-counts">
            {#if workspace.review && workspace.review.pendingSuggestions > 0}
              <span class="review-suggestions">
                {workspace.review.pendingSuggestions}
                {workspace.review.pendingSuggestions === 1 ? 'suggestion' : 'suggestions'}
              </span>
            {/if}
            {#if workspace.review && workspace.review.openComments > 0}
              <span class="review-comments">
                {workspace.review.openComments}
                {workspace.review.openComments === 1 ? 'comment' : 'comments'}
              </span>
            {/if}
          </span>
        {:else}
          <span class="review-slot-empty" aria-hidden="true"></span>
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
              onclick={() => openDeleteConfirm(workspace.id)}
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
              onclick={() => openDeleteConfirm(workspace.id)}
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
        <ConfirmPanel
          label={`Delete ${workspace.name}?`}
          title={`Delete “${workspace.name}” from this device?`}
          confirmLabel="Delete workspace"
          oncancel={cancelDelete}
          onconfirm={async () => {
            await onDelete(workspace.id);
            confirmingDeleteId = null;
          }}
        >
          {#snippet body()}
            <p class="confirm-body">
              {#if exportedBeforeDelete}
                Exported. The copy is in your downloads; deleting removes it from this device.
              {:else}
                This cannot be undone. Export it first if you need a copy.
              {/if}
            </p>
          {/snippet}
          {#snippet extra()}
            <button
              class="button"
              type="button"
              disabled={exportingBeforeDelete || exportedBeforeDelete}
              onclick={() => void exportBeforeDelete(workspace.id)}
            >
              {#if exportingBeforeDelete}
                Exporting…
              {:else if exportedBeforeDelete}
                Exported
              {:else}
                Export first
              {/if}
            </button>
          {/snippet}
        </ConfirmPanel>
      {/if}
      </li>
    {/snippet}

    {#if waitingWorkspaces.length > 0}
      <!-- The group the daily user actually came for (attn-a9f7.3.3). Its own
           heading, so neither list has to misdescribe what it holds. -->
      <h2 class="folio-label folio-label-waiting" id="waiting-workspaces">Waiting on you</h2>
      <ul class="workspace-list" aria-labelledby="waiting-workspaces">
        {#each waitingWorkspaces as workspace, index (workspace.id)}
          {@render workspaceRow(workspace, index)}
        {/each}
      </ul>
    {/if}
    {#if recentWorkspaces.length > 0}
      <h2 class="folio-label" id="recent-workspaces">
        {waitingWorkspaces.length > 0 ? 'Everything else' : 'Recently on this device'}
      </h2>
      <ul class="workspace-list" aria-labelledby="recent-workspaces">
        {#each recentWorkspaces as workspace, index (workspace.id)}
          {@render workspaceRow(workspace, waitingWorkspaces.length + index)}
        {/each}
      </ul>
    {/if}
  {:else if !storageUnavailable}
    <!-- The label states the desk's STATE, like every other folio label on this
         page ("Waiting on you", "Everything else"); the well below states the
         act. Native puts the state in the well's own title because it has no
         label above it — same two facts, one each, neither said twice. -->
    <h2 class="folio-label">Nothing on this desk yet</h2>
    <!-- attn-mkmz.5. The first-run slot used to be "What deserves your
         attention?" — a document-shaped button whose whole offer was creating a
         blank untitled.md, so the default way into the product was a file with
         nothing in it. attn is a REVIEWER; the first thing it should ask for is
         the document you already have.

         One line, not a well (user ruling, 2026-08-20). The well this replaces
         was the native "No file selected" panel ported onto the desk — brand
         mark, title, lede, two buttons, privacy line — which then said the same
         four things the workspace canvas says the moment you arrive there, one
         click later. The desk states that it is empty and names the two ways
         out; the canvas does the asking.

         Import leads, because starting blank is deliberately NOT the default:
         a reviewer's first move is the document they already have. Both routes
         mint a workspace — they differ in what the canvas does when you land,
         and `createIntent` is what carries that.

         ORDER carries that lead now, not weight (user ruling, 2026-08-20). The
         two routes used to be set at different weights, which made the second
         one read as an afterthought rather than as the other half of a choice.
         They are the same link now, capitalised alike, and the sentence still
         puts import first — which is where a reviewer's first move belongs. -->
    <p class="desk-empty-offer">
      <button
        class="link-button"
        type="button"
        data-action="import-files"
        onclick={() => onCreate('import')}
      >Import files</button>
      <span class="desk-empty-or">or</span>
      <button
        class="link-button"
        type="button"
        data-action="start-blank"
        onclick={() => onCreate('blank')}
      >Start a blank untitled.md</button>
    </p>
  {/if}
</main>
