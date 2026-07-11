<script lang="ts">
  import type { ShareScope, StorageHealth } from './types';

  interface Props {
    workspaceName: string;
    scope: ShareScope;
    health: StorageHealth;
    onclose: () => void;
  }

  const { workspaceName, scope, health, onclose }: Props = $props();

  let closeButton = $state<HTMLButtonElement | undefined>();

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
        <button class="button" type="button">Native &amp; CLI options</button>
        <button class="button primary" type="button">Copy browser link</button>
      </div>
    </div>
  </div>
</div>
