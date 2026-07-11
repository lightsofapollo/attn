<script lang="ts">
  import type { ShareScope, StorageHealth } from './types';

  interface Props {
    workspaceName: string;
    scope: ShareScope;
    health: StorageHealth;
    onclose: () => void;
    /** Ask the browser for persistent storage (must run in a user gesture). */
    onRequestPersist?: () => Promise<boolean | null>;
    /** Download a Markdown/zip backup of the share scope. */
    onBackup?: () => Promise<void>;
  }

  const { workspaceName, scope, health, onclose, onRequestPersist, onBackup }: Props = $props();

  let closeButton = $state<HTMLButtonElement | undefined>();

  // ————— first-share durability gate (attn-7xl.5.4) —————
  // svelte-ignore state_referenced_locally — seeds from the prop.
  let persistent = $state(health.mode === 'persistent');
  let persistDenied = $state(false);
  let backedUp = $state(false);
  let riskAcknowledged = $state(false);
  /** Sharing may proceed once storage is persistent, or after an explicit
   * risk acknowledgement (product decision #7). */
  const shareUnlocked = $derived(persistent || riskAcknowledged);

  async function requestPersist(): Promise<void> {
    if (!onRequestPersist) return;
    const granted = await onRequestPersist();
    if (granted === true) {
      persistent = true;
      persistDenied = false;
    } else {
      persistDenied = true;
    }
  }

  async function downloadBackup(): Promise<void> {
    if (!onBackup) return;
    await onBackup();
    backedUp = true;
  }

  $effect(() => {
    closeButton?.focus();
  });

  // First-share flow from planning/web-authoring/00-web-presence.md: source
  // safety, access lifetime, scope, link. Durability copy is honest per mode —
  // if persistence is not granted, sharing requires an explicit risk
  // acknowledgement (product decision #7).
  const durability = $derived.by(() => {
    switch (health.mode) {
      case 'persistent':
        return 'Persistent storage is active. Download a normal Markdown backup before sharing from another device.';
      case 'best-effort':
        return 'This browser has not granted persistent storage. Download a Markdown backup now — sharing continues only after you acknowledge the risk.';
      case 'session-only':
        return 'This private session is not durable. Export a Markdown backup first; sharing continues only after you acknowledge the risk.';
      case 'quota-pressure':
        return 'Storage is nearly full. Export a backup before sharing so the source cannot be lost under pressure.';
      case 'unavailable':
        return 'Local storage is unavailable, so this share cannot be recovered from this browser later.';
    }
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }

  function onVeilClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onclose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="overlay-stage" onclick={onVeilClick} onkeydown={onkeydown}>
  <div class="share-sheet" role="dialog" aria-modal="true" aria-label={`Share ${workspaceName} for review`}>
    <header class="share-head">
      <div>
        <div class="eyebrow">End-to-end encrypted</div>
        <h2>Share for review</h2>
      </div>
      <button class="button" type="button" bind:this={closeButton} onclick={onclose}>Close</button>
    </header>
    <div class="share-body">
      <div class="share-step">
        <span class="step-badge" aria-hidden="true">1</span>
        <div>
          <strong>Keep your source safe</strong>
          <p>{durability}</p>
          <div class="storage-actions" style="margin-top: 0.6rem;">
            {#if !persistent && onRequestPersist}
              <button class="button" type="button" onclick={() => void requestPersist()}>
                Request persistent storage
              </button>
            {/if}
            {#if onBackup}
              <button class="button" type="button" data-action="share-backup" onclick={() => void downloadBackup()}>
                {backedUp ? 'Backup downloaded ✓' : 'Download backup'}
              </button>
            {/if}
          </div>
          {#if persistDenied}
            <p style="margin-top: 0.4rem; color: var(--rust-deep);">
              The browser declined persistent storage. Sharing stays available after you
              acknowledge the risk below.
            </p>
          {/if}
          {#if !persistent}
            <label style="display: flex; gap: 0.5rem; align-items: flex-start; margin-top: 0.6rem;">
              <input type="checkbox" bind:checked={riskAcknowledged} style="margin-top: 0.2rem;" />
              <span>
                I understand this browser may erase the local source; I have (or don’t need) a
                backup.
              </span>
            </label>
          {/if}
        </div>
      </div>
      <div class="share-step">
        <span class="step-badge" aria-hidden="true">2</span>
        <div>
          <strong>Available for 24 hours · Hybrid</strong>
          <p>
            Direct when peers can connect; encrypted relay otherwise. Advanced limits are
            available but stay out of the primary flow.
          </p>
        </div>
      </div>
      <div class="share-step">
        <span class="step-badge" aria-hidden="true">3</span>
        <div>
          <strong>{scope.label}</strong>
          <p>
            {scope.markdownCount} Markdown {scope.markdownCount === 1 ? 'file' : 'files'} and
            {scope.assetCount} referenced {scope.assetCount === 1 ? 'asset' : 'assets'} keep their
            relative paths. Choose current file or selected entries instead.
          </p>
        </div>
      </div>
      <div class="share-step">
        <span class="step-badge" aria-hidden="true">4</span>
        <div>
          <strong>Link ready</strong>
          <p>
            The room key stays in the fragment. Attn services cannot recover this link or read
            the workspace.
          </p>
        </div>
      </div>
      <div class="link-box" aria-label="Browser invite link preview">
        https://attn.sh/review/7pmH1MwiTfQt9gecnT4HIA#key=••••••••••••••••••••
      </div>
      <div class="share-foot">
        <button class="button" type="button" disabled={!shareUnlocked}>
          Native &amp; CLI options
        </button>
        <button class="button primary" type="button" disabled={!shareUnlocked} data-action="copy-link">
          Copy browser link
        </button>
      </div>
      {#if !shareUnlocked}
        <p style="margin-top: 0.6rem; font: 0.8rem/1.4 var(--sans); color: var(--muted);">
          Sharing unlocks once storage is persistent or you acknowledge the risk.
        </p>
      {/if}
    </div>
  </div>
</div>
