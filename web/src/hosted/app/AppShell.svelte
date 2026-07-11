<script lang="ts">
  import type { AppRoute } from '../../lib/hosted/routes';
  import DeskHome from './DeskHome.svelte';
  import EditorShell from './EditorShell.svelte';
  import OpenPage from './OpenPage.svelte';
  import StoragePage from './StoragePage.svelte';
  import type { WorkspaceService } from './types';

  interface Props {
    service: WorkspaceService;
    route: AppRoute | undefined;
    /** The landing's one-click intent (`/app#new`): open a fresh untitled
     * workspace draft directly in the editor with no dialog. */
    newIntent: boolean;
  }

  const { service, route, newIntent }: Props = $props();

  const workspace = $derived(
    route?.view === 'workspace' ? service.getWorkspace(route.workspaceId) : undefined,
  );
</script>

{#if newIntent}
  <EditorShell {service} workspace={service.newWorkspaceDraft()} activePath="untitled.md" isNewDraft />
{:else if route?.view === 'workspace'}
  {#if workspace}
    <EditorShell {service} {workspace} activePath={route.filePath} />
  {:else}
    <div class="app-shell" data-app-view="missing">
      <main class="desk">
        <div class="desk-title">
          <div>
            <div class="eyebrow">Not on this device</div>
            <h1>That workspace isn’t here</h1>
          </div>
        </div>
        <p style="margin-top: 2rem; font: 1rem/1.6 var(--sans); color: var(--muted);">
          Local workspaces live in the browser profile that created them. Import a backup, or go
          back to <a href="/app" style="text-decoration: underline;">your desk</a>.
        </p>
      </main>
    </div>
  {/if}
{:else if route?.view === 'storage'}
  <StoragePage {service} />
{:else if route?.view === 'open'}
  <OpenPage {service} />
{:else}
  <DeskHome {service} />
{/if}
