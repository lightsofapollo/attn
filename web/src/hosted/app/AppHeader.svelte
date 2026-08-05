<script lang="ts">
  import type { Snippet } from 'svelte';
  import BrandMark from '../../lib/BrandMark.svelte';
  import type { PersistenceMode } from './types';

  interface Props {
    mode: PersistenceMode;
    actions?: Snippet;
  }

  const { mode, actions }: Props = $props();

  /* Literal desk-header states from planning/web-authoring/ios-ux.md §8.
     Three tones, not two (attn-n01r.31). `best-effort` used to return
     warn: false, so "Backup recommended" rendered in the same green as
     "On this device" — green-on-green is the universal "you're fine" signal,
     attached to a message meaning the user's work is one storage eviction from
     gone. It is a caution, not a success, and it is also not the destructive
     red the genuine failures use.

     Green is additionally quarantined to the collaboration layer by DESIGN.md,
     so a storage state was never entitled to it in the first place. */
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
        return { label: 'Storage needs attention', tone: 'warn' };
    }
  });

  /* Anything but "all good" links to the remedy. The desk previously stated the
     problem and left the fix behind an unrelated "Storage" button that the copy
     never connected to. */
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
