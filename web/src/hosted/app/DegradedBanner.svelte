<script lang="ts">
  import type { PersistenceMode } from './types';

  interface Props {
    mode: PersistenceMode;
  }

  const { mode }: Props = $props();

  // Failure/degraded copy from planning/web-authoring/00-web-presence.md.
  const state = $derived.by(() => {
    switch (mode) {
      case 'session-only':
        return {
          title: 'This private session may erase your desk when it closes.',
          detail:
            'You can write and export here, but nothing is durable. Download a Markdown backup before you leave.',
          actions: ['Export Markdown'],
        };
      case 'unavailable':
        return {
          title: 'This browser currently blocks local document storage.',
          detail:
            'Local workspaces are unavailable. Review links you open can still work while this tab stays open.',
          actions: [],
        };
      case 'quota-pressure':
        return {
          title: 'Storage is nearly full. New edits are paused.',
          detail:
            'Your last saved version is preserved. Export or remove a workspace to continue writing — nothing is silently overwritten.',
          actions: ['Export all Markdown', 'Review storage'],
        };
      case 'persistent':
      case 'best-effort':
        return undefined;
    }
  });
</script>

{#if state}
  <div class="degraded-banner" role="status" data-degraded={mode}>
    <div>
      <strong>{state.title}</strong>
      <p>{state.detail}</p>
    </div>
    {#if state.actions.length > 0}
      <div class="actions">
        {#each state.actions as action (action)}
          <!-- Every action routes to the storage page, which owns the working
               export / backup / persistence controls. A handler-less <button>
               here is a silent no-op on the exact "back up before you lose
               data" prompt. -->
          <a class="button" href="/app/storage">{action}</a>
        {/each}
      </div>
    {/if}
  </div>
{/if}
