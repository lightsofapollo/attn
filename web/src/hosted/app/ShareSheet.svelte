<script lang="ts">
  import {
    SHARE_MODE_OPTIONS,
    SHARE_TTL_ONE_DAY,
    createShareRequest,
    durabilityState,
    entriesForScope,
    formatByteCount,
    maskInviteUrl,
    remainingTimeLabel,
    summarizeEntries,
    type ShareScopeChoice,
  } from './share-sheet-model';
  import type {
    ShareScope,
    StorageHealth,
    WorkspaceDetail,
    WorkspaceEntry,
    WorkspaceShareMode,
    WorkspaceShareRequest,
    WorkspaceShareTtlMs,
    WorkspaceShareView,
  } from './types';

  type SheetPhase = 'loading' | 'configure' | 'progress' | 'ready' | 'stopped';
  const SHARE_TIERS = ['view', 'comment', 'suggest'] as const;

  interface Props {
    workspace?: WorkspaceDetail;
    activeEntry?: WorkspaceEntry;
    health: StorageHealth;
    ownerStatus?: string;
    onInspect?: () => Promise<WorkspaceShareView | null>;
    onCreate?: (request: WorkspaceShareRequest) => Promise<WorkspaceShareView>;
    onStop?: () => Promise<void>;
    onRequestPersist?: () => Promise<boolean | null>;
    onBackup?: () => Promise<void>;
    onclose: () => void;
    /** Temporary compatibility for callers that have not moved to WorkspaceDetail yet. */
    workspaceName?: string;
    /** Temporary compatibility for callers that have not moved to WorkspaceDetail yet. */
    scope?: ShareScope;
  }

  const {
    workspace,
    activeEntry,
    health,
    ownerStatus,
    onInspect,
    onCreate,
    onStop,
    onRequestPersist,
    onBackup,
    onclose,
    workspaceName,
  }: Props = $props();

  const entries = $derived(workspace?.entries ?? []);
  const initialActivePath = $derived(
    activeEntry?.path
      ?? (workspace?.openPath && entries.some((entry) => entry.path === workspace.openPath)
        ? workspace.openPath
        : entries.find((entry) => entry.kind === 'markdown')?.path),
  );
  const initialActiveEntry = $derived(entries.find((entry) => entry.path === initialActivePath));
  const name = $derived(workspace?.name ?? workspaceName ?? 'Workspace');

  let dialogElement = $state<HTMLDialogElement | undefined>();
  let headingElement = $state<HTMLHeadingElement | undefined>();
  let phase = $state<SheetPhase>('loading');
  let share = $state<WorkspaceShareView | null>(null);
  let inspectStarted = $state(false);
  let operationBusy = $state(false);
  let operationError = $state('');
  let statusMessage = $state('');
  let progressPaused = $state(false);

  let selectionInitialized = $state(false);
  let scopeChoice = $state<ShareScopeChoice>('workspace');
  let configuredFilePath = $state<string | undefined>();
  let selectedPaths = $state<string[]>([]);
  let mode = $state<WorkspaceShareMode>('hybrid');
  let ttlMs = $state<WorkspaceShareTtlMs>(SHARE_TTL_ONE_DAY);
  let advancedOpen = $state(false);

  let persistGranted = $state(false);
  let persistBusy = $state(false);
  let persistDenied = $state(false);
  let backupBusy = $state(false);
  let backedUp = $state(false);
  let riskAcknowledged = $state(false);

  let revealLink = $state(false);
  let selectedTier = $state<'view' | 'comment' | 'suggest'>('comment');
  let inviteOptionsOpen = $state(false);
  let stopConfirm = $state(false);
  let stopBusy = $state(false);
  let stopSharingButton = $state<HTMLButtonElement | undefined>();
  let keepSharingButton = $state<HTMLButtonElement | undefined>();

  const effectivePersistenceMode = $derived(
    persistGranted || health.mode === 'persistent' ? 'persistent' : health.mode,
  );
  const durability = $derived(durabilityState(effectivePersistenceMode, riskAcknowledged));
  const selectedEntries = $derived(
    entriesForScope(entries, scopeChoice, configuredFilePath, selectedPaths),
  );
  const configuredFileEntry = $derived(
    entries.find((entry) => entry.path === configuredFilePath),
  );
  const manifest = $derived(summarizeEntries(selectedEntries));
  const scopeValid = $derived(manifest.markdownCount > 0);
  const configurationReady = $derived(
    durability.allowed && scopeValid && Boolean(workspace) && Boolean(onCreate),
  );
  const invite = $derived(share?.invite ?? null);
  const selectedInvite = $derived(invite?.[selectedTier] ?? null);
  const maskedBrowserUrl = $derived(selectedInvite ? maskInviteUrl(selectedInvite.browserUrl) : '');
  const webShareAvailable = $derived(supportsWebShare());

  const durabilityCopy = $derived.by(() => {
    switch (effectivePersistenceMode) {
      case 'persistent':
        return 'Persistent storage is active on this device. A normal backup is still a good idea before sharing.';
      case 'best-effort':
        return 'This browser may clear local data. Request persistent storage, or acknowledge the risk after making a backup.';
      case 'session-only':
        return 'Private browsing is session-only. The owner room cannot be recovered if this session closes.';
      case 'quota-pressure':
        return 'Storage is nearly full. Free space or export and reopen this workspace before sharing.';
      case 'unavailable':
        return 'Local storage is unavailable. A recoverable owner room cannot be created from this browser.';
    }
  });

  $effect(() => {
    if (!dialogElement || dialogElement.open) return;
    dialogElement.showModal();
    queueMicrotask(() => headingElement?.focus());
    return () => {
      if (dialogElement?.open) dialogElement.close();
    };
  });

  $effect(() => {
    if (selectionInitialized) return;
    selectionInitialized = true;
    if (initialActiveEntry?.kind === 'markdown') {
      scopeChoice = 'file';
      configuredFilePath = initialActiveEntry.path;
      selectedPaths = [initialActiveEntry.path];
    }
  });

  $effect(() => {
    if (inspectStarted) return;
    inspectStarted = true;
    void inspectExistingShare();
  });

  function applyShareView(view: WorkspaceShareView): void {
    share = view;
    // A sealed owner record can only have been created after the service's
    // durability preflight. Reopening it must not strand exact resume behind
    // an acknowledgement control that is only rendered in configure state.
    riskAcknowledged = true;
    mode = view.mode;
    scopeChoice = view.scopeKind;
    if (view.scopeKind === 'file') configuredFilePath = view.paths[0];
    selectedPaths = [...view.paths];
    revealLink = false;
    selectedTier = 'comment';
    inviteOptionsOpen = false;
    stopConfirm = false;

    if (view.expired || view.publication === 'stopped') {
      share = null;
      phase = 'stopped';
      statusMessage = view.expired ? 'That review link has expired.' : 'Review access has stopped.';
    } else if (view.publication === 'published' && view.invite) {
      phase = 'ready';
      progressPaused = false;
      statusMessage = 'Encrypted review link ready.';
    } else {
      phase = 'progress';
      progressPaused = true;
      statusMessage = 'Publishing paused. The encrypted room can be resumed safely.';
    }
  }

  async function inspectExistingShare(): Promise<void> {
    if (!onInspect) {
      phase = 'configure';
      return;
    }
    try {
      const existing = await onInspect();
      if (existing) applyShareView(existing);
      else phase = 'configure';
    } catch {
      phase = 'configure';
      operationError = 'The existing share status could not be checked. You can try again.';
    }
  }

  async function requestPersist(): Promise<void> {
    if (!onRequestPersist || persistBusy) return;
    persistBusy = true;
    persistDenied = false;
    try {
      const granted = await onRequestPersist();
      if (granted === true) {
        persistGranted = true;
        statusMessage = 'Persistent storage granted.';
      } else {
        persistDenied = true;
      }
    } catch {
      persistDenied = true;
    } finally {
      persistBusy = false;
    }
  }

  async function downloadBackup(): Promise<void> {
    if (!onBackup || backupBusy) return;
    backupBusy = true;
    try {
      await onBackup();
      backedUp = true;
      statusMessage = 'Backup downloaded.';
    } catch {
      statusMessage = 'The backup could not be downloaded. Try again before sharing.';
    } finally {
      backupBusy = false;
    }
  }

  function toggleSelectedPath(path: string, checked: boolean): void {
    selectedPaths = checked
      ? [...new Set([...selectedPaths, path])]
      : selectedPaths.filter((candidate) => candidate !== path);
  }

  function configuredRequest(): WorkspaceShareRequest | null {
    return createShareRequest({
      scope: scopeChoice,
      activePath: configuredFilePath,
      selectedPaths,
      mode,
      ttlMs,
      riskAcknowledged,
    });
  }

  async function publishShare(): Promise<void> {
    const request = configuredRequest();
    const resumingPreparedShare = share !== null && share.publication !== 'published';
    if (
      !request
      || !onCreate
      || operationBusy
      || (!resumingPreparedShare && !configurationReady)
    ) return;
    operationBusy = true;
    operationError = '';
    progressPaused = false;
    phase = 'progress';
    statusMessage = 'Encrypting this selection and publishing the review snapshot…';
    try {
      applyShareView(await onCreate(request));
    } catch {
      progressPaused = true;
      operationError = 'Publishing did not finish. Your source is still local, and it is safe to resume.';
      statusMessage = 'Publishing paused.';
      if (onInspect) {
        try {
          const existing = await onInspect();
          if (existing) applyShareView(existing);
        } catch {
          // The generic paused state deliberately avoids surfacing secret-bearing errors.
        }
      }
    } finally {
      operationBusy = false;
    }
  }

  async function stopSharing(): Promise<void> {
    if (!onStop || stopBusy) return;
    stopBusy = true;
    operationError = '';
    try {
      await onStop();
      share = null;
      stopConfirm = false;
      phase = 'stopped';
      statusMessage = 'Review access stopped. The old link no longer opens this room.';
    } catch {
      operationError = 'Sharing could not be stopped. The existing link still works; try again.';
    } finally {
      stopBusy = false;
    }
  }

  async function copyText(value: string, successMessage: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.className = 'share-clipboard-field';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('copy unavailable');
      }
      statusMessage = successMessage;
      return true;
    } catch {
      statusMessage = 'Copy failed. Reveal the link and copy it manually.';
      return false;
    }
  }

  async function shareBrowserInvite(): Promise<void> {
    if (!selectedInvite) return;
    if (!supportsWebShare()) {
      await copyText(selectedInvite.browserUrl, `${tierLabel(selectedTier)} link copied.`);
      return;
    }
    try {
      await navigator.share({
        title: 'Review in attn',
        text: `Review ${name} in attn.`,
        url: selectedInvite.browserUrl,
      });
      statusMessage = 'Review link shared.';
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return;
      const copied = await copyText(selectedInvite.browserUrl, 'Sharing was unavailable, so the browser link was copied.');
      if (!copied) statusMessage = 'Sharing was unavailable. Reveal the link to copy it manually.';
    }
  }

  function tierLabel(tier: 'view' | 'comment' | 'suggest'): string {
    return tier === 'view' ? 'View-only' : tier === 'comment' ? 'Comment' : 'Suggest';
  }

  function tierDescription(tier: 'view' | 'comment' | 'suggest'): string {
    return tier === 'view'
      ? 'Read the shared workspace'
      : tier === 'comment'
        ? 'Read and leave comments'
        : 'Read, comment, and propose edits';
  }

  function supportsWebShare(): boolean {
    if (typeof navigator === 'undefined') return false;
    return typeof (navigator as Navigator & { share?: unknown }).share === 'function';
  }

  function requestClose(): void {
    if (stopConfirm) {
      cancelStopConfirmation();
      return;
    }
    onclose();
  }

  function beginStopConfirmation(): void {
    stopConfirm = true;
    queueMicrotask(() => keepSharingButton?.focus());
  }

  function cancelStopConfirmation(): void {
    stopConfirm = false;
    queueMicrotask(() => stopSharingButton?.focus());
  }

  function handleCancel(event: Event): void {
    event.preventDefault();
    requestClose();
  }

  function handleVeilClick(event: MouseEvent): void {
    if (event.target === dialogElement) requestClose();
  }
</script>

<dialog
  class="overlay-stage"
  bind:this={dialogElement}
  aria-labelledby="share-sheet-title"
  aria-describedby="share-sheet-description"
  oncancel={handleCancel}
  onclick={handleVeilClick}
>
  <section class="share-sheet">
    <header class="share-head">
      <div>
        <div class="eyebrow">End-to-end encrypted</div>
        <h2 id="share-sheet-title" tabindex="-1" bind:this={headingElement}>Share for review</h2>
        <p id="share-sheet-description">Choose exactly what reviewers can open. The encryption key stays in the invite link.</p>
      </div>
      <button class="button share-close" type="button" onclick={requestClose} aria-label="Close share sheet">Close</button>
    </header>

    <div class="share-body">
      {#if phase === 'loading'}
        <div class="share-progress" aria-live="polite">
          <span class="share-spinner" aria-hidden="true"></span>
          <div>
            <h3>Checking review access…</h3>
            <p>Looking for an existing encrypted room owned by this browser.</p>
          </div>
        </div>
      {:else if phase === 'configure'}
        <section class:share-blocked={durability.hardBlocked} class="share-panel" aria-labelledby="source-safety-title">
          <div class="share-panel-heading">
            <span class="step-badge" aria-hidden="true">1</span>
            <div>
              <h3 id="source-safety-title">Keep the owner source safe</h3>
              <p>{durabilityCopy}</p>
            </div>
          </div>
          <div class="storage-actions share-storage-actions">
            {#if durability.canRequestPersistence && onRequestPersist}
              <button class="button" type="button" disabled={persistBusy} onclick={() => void requestPersist()}>
                {persistBusy ? 'Requesting…' : 'Request persistent storage'}
              </button>
            {/if}
            {#if onBackup}
              <button class="button" type="button" disabled={backupBusy} onclick={() => void downloadBackup()}>
                {backupBusy ? 'Preparing backup…' : backedUp ? 'Backup downloaded ✓' : 'Download backup'}
              </button>
            {/if}
          </div>
          {#if persistDenied}
            <p class="share-warning">Persistent storage was not granted. You can still continue after acknowledging the risk.</p>
          {/if}
          {#if durability.needsAcknowledgement && !persistGranted}
            <label class="share-check">
              <input type="checkbox" bind:checked={riskAcknowledged} />
              <span>I understand this browser may erase the owner source and I have made, or do not need, a backup.</span>
            </label>
          {/if}
          {#if durability.hardBlocked}
            <p class="share-error" role="alert">Sharing stays unavailable in this storage state, even with a risk acknowledgement.</p>
          {/if}
        </section>

        <section class="share-panel" aria-labelledby="share-scope-title">
          <div class="share-panel-heading">
            <span class="step-badge" aria-hidden="true">2</span>
            <div>
              <h3 id="share-scope-title">Choose the review scope</h3>
              <p>Relative paths are preserved. Every share must include at least one Markdown file.</p>
            </div>
          </div>
          <fieldset class="share-choice-grid">
            <legend class="sr-only">Review scope</legend>
            <label class:chosen={scopeChoice === 'file'} class:choice-disabled={!configuredFileEntry || configuredFileEntry.kind !== 'markdown'}>
              <input
                type="radio"
                name="share-scope"
                value="file"
                bind:group={scopeChoice}
                disabled={!configuredFileEntry || configuredFileEntry.kind !== 'markdown'}
              />
              <span><strong>Current file</strong><small>{configuredFileEntry?.path ?? 'No open Markdown file'}</small></span>
            </label>
            <label class:chosen={scopeChoice === 'entries'}>
              <input type="radio" name="share-scope" value="entries" bind:group={scopeChoice} />
              <span><strong>Selected entries</strong><small>Pick files and assets below</small></span>
            </label>
            <label class:chosen={scopeChoice === 'workspace'}>
              <input type="radio" name="share-scope" value="workspace" bind:group={scopeChoice} />
              <span><strong>Whole workspace</strong><small>All {entries.length} entries</small></span>
            </label>
          </fieldset>

          {#if scopeChoice === 'entries'}
            <div class="share-entry-list" aria-label="Select workspace entries">
              {#each entries as entry (entry.path)}
                <label>
                  <input
                    type="checkbox"
                    checked={selectedPaths.includes(entry.path)}
                    onchange={(event) => toggleSelectedPath(entry.path, event.currentTarget.checked)}
                  />
                  <span class="share-entry-name">{entry.path}</span>
                  <span class="share-entry-meta">{entry.kind === 'markdown' ? 'Markdown' : entry.presentation === 'preview' ? 'Preview' : 'Download'} · {entry.sizeLabel}</span>
                </label>
              {/each}
            </div>
          {/if}

          <div class="share-manifest" aria-live="polite">
            <strong>{manifest.entryCount} {manifest.entryCount === 1 ? 'entry' : 'entries'} · {formatByteCount(manifest.totalBytes)}</strong>
            <span>{manifest.markdownCount} Markdown · {manifest.previewableAssetCount} previewable · {manifest.downloadOnlyAssetCount} download-only</span>
          </div>
          {#if !scopeValid}
            <p class="share-error" role="alert">Select at least one Markdown file to create a review.</p>
          {/if}
          {#if !workspace}
            <p class="share-error" role="alert">Workspace details are unavailable. Close this sheet and reopen the workspace.</p>
          {/if}
        </section>

        <details class="share-advanced" bind:open={advancedOpen}>
          <summary>Delivery mode <span>{SHARE_MODE_OPTIONS.find((option) => option.value === mode)?.label}</span></summary>
          <div class="share-advanced-body">
            <fieldset>
              <legend>Review access</legend>
              {#each SHARE_MODE_OPTIONS as option (option.value)}
                <label>
                  <input type="radio" name="share-mode" value={option.value} bind:group={mode} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              {/each}
            </fieldset>
            <p class="share-lifetime-note">Stable links renew for 90 days when the browser owner reconnects. Stop sharing revokes View, Comment, and Suggest together.</p>
          </div>
        </details>

        {#if operationError}
          <p class="share-error" role="alert">{operationError}</p>
        {/if}
        <div class="share-config-foot">
          <p>Nothing is uploaded until you create the encrypted review room.</p>
          <button class="button primary" type="button" disabled={!configurationReady} onclick={() => void publishShare()}>
            Create review link
          </button>
        </div>
      {:else if phase === 'progress'}
        <div class="share-progress" aria-live="polite">
          {#if operationBusy}
            <span class="share-spinner" aria-hidden="true"></span>
          {:else}
            <span class="share-progress-mark" aria-hidden="true">↻</span>
          {/if}
          <div>
            <h3>{operationBusy ? 'Publishing encrypted snapshot…' : 'Publishing paused'}</h3>
            <p>{operationBusy
              ? 'Keeping paths intact while the browser encrypts and sends this selection.'
              : share?.resumable
                ? 'The exact encrypted batch is sealed to this workspace. Resume without re-encrypting it.'
                : 'The prepared room is sealed to this workspace. Resume to finish publishing safely.'}</p>
          </div>
        </div>
        <ol class="share-progress-steps" aria-label="Publishing steps">
          <li class="complete">Owner keys sealed to this workspace</li>
          <li
            class:complete={share?.resumable === true || (!operationBusy && !progressPaused)}
            class:active={operationBusy}
          >Snapshot encrypted in this browser</li>
          <li class:active={operationBusy}>Encrypted room made available</li>
        </ol>
        {#if operationError}
          <p class="share-error" role="alert">{operationError}</p>
        {/if}
        {#if progressPaused}
          <div class="share-foot">
            <button class="button" type="button" disabled={!onStop || stopBusy} onclick={() => void stopSharing()}>
              {stopBusy ? 'Discarding…' : 'Discard and start over'}
            </button>
            <button class="button primary" type="button" disabled={!onCreate || operationBusy} onclick={() => void publishShare()}>Resume publishing</button>
          </div>
        {/if}
      {:else if phase === 'ready' && invite && share}
        <div class="share-ready-head">
          <span class="share-ready-mark" aria-hidden="true">✓</span>
          <div>
            <h3>Review link ready</h3>
            <p>{ownerStatus ?? 'Browser owner active'} · {remainingTimeLabel(share.expiresAt)}</p>
          </div>
        </div>
        <fieldset class="share-tier-picker">
          <legend>Choose what this link allows</legend>
          {#each SHARE_TIERS as tier}
            <label class:active={selectedTier === tier}>
              <input type="radio" name="share-tier" value={tier} bind:group={selectedTier} />
              <span><strong>{tierLabel(tier)}</strong><small>{tierDescription(tier)}</small></span>
              {#if tier === 'comment'}<em>Default</em>{/if}
            </label>
          {/each}
        </fieldset>

        {#if selectedInvite}
          <div class="share-link-row">
            <code aria-label={revealLink ? `Full ${tierLabel(selectedTier)} browser invite link` : `${tierLabel(selectedTier)} browser invite link with capability hidden`}>{revealLink ? selectedInvite.browserUrl : maskedBrowserUrl}</code>
            <button class="button" type="button" aria-pressed={revealLink} onclick={() => revealLink = !revealLink}>{revealLink ? 'Hide' : 'Show'}</button>
          </div>
          <p class="share-secret-note">Anyone with the complete link gets {tierDescription(selectedTier).toLowerCase()}. Capability keys stay in the fragment; attn services cannot recover them or read the workspace.</p>

          <div class="share-ready-actions">
            <button class="button primary" type="button" onclick={() => void shareBrowserInvite()}>{webShareAvailable ? `Share ${tierLabel(selectedTier)} link` : `Copy ${tierLabel(selectedTier)} link`}</button>
            {#if webShareAvailable}
              <button class="button" type="button" onclick={() => void copyText(selectedInvite.browserUrl, `${tierLabel(selectedTier)} link copied.`)}>Copy link</button>
            {/if}
          </div>
        {/if}
        {#if statusMessage !== 'Encrypted review link ready.'}
          <p class="share-feedback">{statusMessage}</p>
        {/if}

        {#if selectedInvite}<details class="share-invite-options" bind:open={inviteOptionsOpen}>
          <summary>Native app and CLI options</summary>
          <div class="share-invite-option">
            <div><strong>attn app · {tierLabel(selectedTier)}</strong><code>{selectedInvite.nativeUrl}</code></div>
            <div class="share-invite-actions">
              <a class="button" href={selectedInvite.nativeUrl}>Open in attn</a>
              <button class="button" type="button" onclick={() => void copyText(selectedInvite.nativeUrl, 'Native app link copied.')}>Copy</button>
            </div>
          </div>
          <div class="share-invite-option">
            <div><strong>Command line</strong><code>{selectedInvite.cliCommand}</code></div>
            <button class="button" type="button" onclick={() => void copyText(selectedInvite.cliCommand, 'CLI command copied.')}>Copy</button>
          </div>
        </details>{/if}

        <section class="share-stop-zone" aria-labelledby="stop-sharing-title">
          {#if !stopConfirm}
            <div>
              <h3 id="stop-sharing-title">Stop this review</h3>
              <p>Owner-signed teardown revokes all three stable links and the current review room.</p>
            </div>
            <button
              class="button danger"
              type="button"
              bind:this={stopSharingButton}
              disabled={!onStop}
              onclick={beginStopConfirmation}
            >Stop sharing</button>
          {:else}
            <div>
              <h3 id="stop-sharing-title">Stop sharing now?</h3>
              <p>Reviewers will lose access. This cannot be undone, but you can create a new room.</p>
            </div>
            <div class="share-stop-actions">
              <button
                class="button"
                type="button"
                bind:this={keepSharingButton}
                disabled={stopBusy}
                onclick={cancelStopConfirmation}
              >Keep sharing</button>
              <button class="button danger" type="button" disabled={stopBusy} onclick={() => void stopSharing()}>{stopBusy ? 'Stopping…' : 'Stop now'}</button>
            </div>
          {/if}
        </section>
        {#if operationError}
          <p class="share-error" role="alert">{operationError}</p>
        {/if}
      {:else if phase === 'stopped'}
        <div class="share-stopped">
          <span aria-hidden="true">✓</span>
          <h3>Review access is off</h3>
          <p>The old room is no longer available. Create a new encrypted room whenever you are ready.</p>
          <button class="button primary" type="button" onclick={() => { phase = 'configure'; operationError = ''; statusMessage = ''; }}>Create a new review link</button>
        </div>
      {/if}

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{statusMessage}</p>
    </div>
  </section>
</dialog>
