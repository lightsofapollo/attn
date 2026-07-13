<script lang="ts">
  import Cog from '@lucide/svelte/icons/cog';
  import { reviewNotificationMute, setResidentLaunchAtLogin } from './ipc';
  import type { RoomId } from './types';

  interface Props {
    active?: boolean;
    installed?: boolean;
    loaded?: boolean;
    degraded?: boolean;
    statusError?: string | null;
    supported?: boolean;
    roomId?: RoomId | null;
    notificationMuted?: boolean;
  }

  let {
    active = false,
    installed = false,
    loaded = false,
    degraded = false,
    statusError = null,
    supported = false,
    roomId = null,
    notificationMuted = false,
  }: Props = $props();
  let open = $state(false);
  let enabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let rootEl = $state<HTMLDivElement | undefined>();

  // Dismissal (Topmost-Escape rule, attn gate-35): the panel was
  // undismissable — Escape and outside-click now close it (the gear toggle
  // already does). Listeners live only while it is open.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        open = false;
      }
    };
    const onDown = (e: MouseEvent): void => {
      if (rootEl && e.target instanceof Node && !rootEl.contains(e.target)) open = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  });

  $effect(() => {
    enabled = installed;
    error = statusError ?? '';
  });

  $effect(() => {
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<{
        installed: boolean;
        loaded: boolean;
        degraded: boolean;
        error?: string | null;
      }>).detail;
      enabled = detail.installed;
      loaded = detail.loaded;
      degraded = detail.degraded;
      busy = false;
      error = detail.error ?? '';
    };
    window.addEventListener('attn-resident-status', receive);
    return () => window.removeEventListener('attn-resident-status', receive);
  });

  function toggleLaunchAtLogin(): void {
    if (busy) return;
    busy = true;
    error = '';
    setResidentLaunchAtLogin(!enabled);
  }
</script>

{#if supported}
  <div class="fixed bottom-3 right-3 z-50" data-slot="resident-settings" bind:this={rootEl}>
    {#if open}
      <section
        class="mb-2 w-72 rounded-lg border border-border bg-background/95 p-3 shadow-xl backdrop-blur"
        aria-label="Background settings"
      >
        <div class="mb-3">
          <h2 class="text-sm font-semibold text-foreground">Background service</h2>
          <p class="mt-1 text-xs leading-4 text-muted-foreground">
            {active
              ? 'attn stays available after its window closes.'
              : 'Start attn automatically, ready for shared links and documents.'}
          </p>
        </div>
        <label class="flex cursor-pointer items-center justify-between gap-4">
          <span class="text-sm text-foreground">Launch at login</span>
          <input
            type="checkbox"
            class="size-4 accent-primary"
            checked={enabled}
            disabled={busy}
            onchange={toggleLaunchAtLogin}
          />
        </label>
        <p class="mt-2 text-xs text-muted-foreground">
          {#if degraded}
            Needs attention · {loaded ? 'loaded' : 'not loaded'}
          {:else if enabled && loaded}
            Installed and running
          {:else}
            Not installed
          {/if}
        </p>
        {#if roomId !== null}
          <label class="mt-3 flex cursor-pointer items-center justify-between gap-4 border-t border-border pt-3">
            <span>
              <span class="block text-sm text-foreground">Mute this review</span>
              <span class="block text-xs text-muted-foreground">Unread badges stay available.</span>
            </span>
            <input
              type="checkbox"
              class="size-4 accent-primary"
              checked={notificationMuted}
              onchange={(event) => reviewNotificationMute(roomId, event.currentTarget.checked)}
            />
          </label>
        {/if}
        {#if error}
          <p class="mt-2 text-xs text-destructive" role="alert">{error}</p>
        {/if}
      </section>
    {/if}
    <button
      type="button"
      class="ml-auto flex size-8 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Background settings"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <Cog class="size-4" aria-hidden="true" />
    </button>
  </div>
{/if}
