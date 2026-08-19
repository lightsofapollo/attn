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
        /* Not "View-only" (attn-08fa.8). That is the name of a SHARE TIER in
           the share sheet, and both labels are reachable in one session — a
           reviewer could read "View-only" here and conclude someone had limited
           their permissions, when the truth is that this browser will not let
           attn store anything locally. Two meanings, one word, no relation. */
        return { label: 'Storage blocked', tone: 'warn' };
      case 'quota-pressure':
        return { label: SAVE_STATE_STORAGE_ATTENTION, tone: 'warn' };
    }
  });

  /* Anything but "all good" links to the remedy. Stating the problem and
     leaving the fix behind an unrelated "Storage" button never connects the
     two for the user. */
  const needsAttention = $derived(badge.tone !== 'ok');
</script>

<!-- data-slot opts this header into the ACCENT PLANE token re-pointing in
     app.css, the same block the native, owner and review headers use. The desk,
     open and storage routes wore a paper header while the editor and review
     surfaces wore the plane, so crossing into a document flipped the top of the
     window — in Ink, a steel band appearing and vanishing dozens of times a
     session. One grammar, one plane (attn-08fa.2). -->
<header class="app-header" data-slot="app-shell-header">
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
