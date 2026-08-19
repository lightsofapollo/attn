<script lang="ts">
  import type { Snippet } from 'svelte';
  import BrandMark from '../../lib/BrandMark.svelte';
  import type { PersistenceMode } from './types';
  import { SAVE_STATE_STORAGE_ATTENTION } from '../../lib/save-state-copy';

  interface Props {
    mode: PersistenceMode;
    actions?: Snippet;
  }

  const { mode, actions }: Props = $props();

  /* Literal desk-header states from planning/web-authoring/ios-ux.md §8.
     Three tones, not two (attn-n01r.31). `best-effort` must not read as
     success: green says "you're fine" over a message meaning the user's work
     is one storage eviction from gone. It is a caution, and not the
     destructive red the genuine failures use. DESIGN.md also quarantines green
     to the collaboration layer, so a storage state cannot claim it. */
  const badge = $derived.by((): { label: string; tone: 'ok' | 'caution' | 'warn' } => {
    switch (mode) {
      case 'persistent':
        return { label: 'On this device', tone: 'ok' };
      case 'best-effort':
        return { label: 'Backup recommended', tone: 'caution' };
      case 'session-only':
        return { label: 'This session only', tone: 'warn' };
      case 'unavailable':
        return { label: 'View-only', tone: 'warn' };
      case 'quota-pressure':
        return { label: SAVE_STATE_STORAGE_ATTENTION, tone: 'warn' };
    }
  });

  /* Anything but "all good" links to the remedy. Stating the problem and
     leaving the fix behind an unrelated "Storage" button never connects the
     two for the user. */
  const needsAttention = $derived(badge.tone !== 'ok');
</script>

<header class="app-header">
  <a class="brand" href="/"><BrandMark class="mark" />attn</a>
  <div class="right">
    {#if needsAttention}
      <a class="local-badge" data-tone={badge.tone} data-storage-mode={mode} href="/app/storage">
        <span class="dot" aria-hidden="true"></span>
        {badge.label}
      </a>
    {:else}
      <span class="local-badge" data-tone={badge.tone} data-storage-mode={mode}>
        <span class="dot" aria-hidden="true"></span>
        {badge.label}
      </span>
    {/if}
    {@render actions?.()}
  </div>
</header>
