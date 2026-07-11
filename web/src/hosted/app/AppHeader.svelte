<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PersistenceMode } from './types';

  interface Props {
    mode: PersistenceMode;
    actions?: Snippet;
  }

  const { mode, actions }: Props = $props();

  // Literal desk-header states from planning/web-authoring/ios-ux.md §8.
  const badge = $derived.by(() => {
    switch (mode) {
      case 'persistent':
        return { label: 'On this device', warn: false };
      case 'best-effort':
        return { label: 'Backup recommended', warn: false };
      case 'session-only':
        return { label: 'This session only', warn: true };
      case 'unavailable':
        return { label: 'View-only', warn: true };
      case 'quota-pressure':
        return { label: 'Storage needs attention', warn: true };
    }
  });
</script>

<header class="app-header">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">a.</span>attn</a>
  <div class="right">
    <span class="local-badge" class:warn={badge.warn} data-storage-mode={mode}>
      <span class="dot" aria-hidden="true"></span>
      {badge.label}
    </span>
    {@render actions?.()}
  </div>
</header>
