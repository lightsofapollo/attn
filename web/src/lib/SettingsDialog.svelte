<script lang="ts">
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Check from '@lucide/svelte/icons/check';
  import * as Dialog from './components/ui/dialog';
  import { getEffectiveTheme, getThemePreference, setThemePreference } from './theme';
  import { TYPESETS, getTypeset, setTypeset } from './typeset';
  import type { ThemePreference, TypesetName } from './types';

  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  // The DOM attributes are the source of truth (Rust seeds them, the theme
  // module owns them), so this local mirror is refreshed whenever the sheet
  // opens rather than duplicating the stored state.
  let themePreference = $state<ThemePreference>('system');
  let typeset = $state<TypesetName>('editorial');
  let effective = $state<'light' | 'dark'>('light');

  $effect(() => {
    if (!open) return;
    themePreference = getThemePreference();
    typeset = getTypeset();
    effective = getEffectiveTheme();
  });

  const APPEARANCES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Paper', icon: Sun },
    { id: 'dark', label: 'Ink', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  function chooseAppearance(preference: ThemePreference): void {
    themePreference = preference;
    setThemePreference(preference);
    effective = getEffectiveTheme();
  }

  function chooseTypeset(next: TypesetName): void {
    typeset = next;
    setTypeset(next);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(32rem,calc(100%-2rem))] max-w-[32rem]" data-slot="settings-dialog">
    <Dialog.Header>
      <Dialog.Title>Settings</Dialog.Title>
      <Dialog.Description>Appearance and typography for this device.</Dialog.Description>
    </Dialog.Header>

    <section class="flex flex-col gap-2" aria-labelledby="settings-appearance-heading">
      <div>
        <h3 id="settings-appearance-heading" class="text-sm font-semibold text-foreground">Appearance</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {#if themePreference === 'system'}
            Following your system appearance — currently {effective === 'dark' ? 'Ink' : 'Paper'}.
          {:else}
            Always {themePreference === 'dark' ? 'Ink' : 'Paper'}, whatever the system is set to.
          {/if}
        </p>
      </div>
      <div
        class="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/30 p-1"
        role="radiogroup"
        aria-label="Appearance"
        data-slot="settings-appearance"
      >
        {#each APPEARANCES as option (option.id)}
          {@const Icon = option.icon}
          <button
            type="button"
            role="radio"
            aria-checked={themePreference === option.id}
            data-slot={`settings-appearance-${option.id}`}
            class="flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {themePreference === option.id
              ? 'bg-primary/15 text-foreground ring-1 ring-primary/50'
              : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'}"
            onclick={() => chooseAppearance(option.id)}
          >
            <Icon class="size-3.5" aria-hidden="true" />
            {option.label}
          </button>
        {/each}
      </div>
    </section>

    <section class="flex flex-col gap-2" aria-labelledby="settings-typeset-heading">
      <div>
        <h3 id="settings-typeset-heading" class="text-sm font-semibold text-foreground">Typeset</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          The reading system for documents. Zoom (⌘ +/−) still applies on top.
        </p>
      </div>
      <div class="grid gap-1.5" role="radiogroup" aria-label="Typeset" data-slot="settings-typeset">
        {#each TYPESETS as preset (preset.id)}
          <button
            type="button"
            role="radio"
            aria-checked={typeset === preset.id}
            data-slot={`settings-typeset-${preset.id}`}
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {typeset === preset.id
              ? 'border-primary/60 bg-primary/[0.04]'
              : 'border-border hover:border-primary/40 hover:bg-muted/40'}"
            onclick={() => chooseTypeset(preset.id)}
          >
            <span class="min-w-0">
              <span class="block text-sm font-medium text-foreground">{preset.label}</span>
              <span class="block text-[11px] leading-4 text-muted-foreground">{preset.description}</span>
              <!-- Live specimen: rendered under the preset's own tokens so the
                   choice is legible before committing to it. -->
              <span
                class="mt-1 block truncate text-sm text-foreground/80"
                data-typeset={preset.id}
                style="font-family: var(--serif)"
              >{preset.specimen}</span>
            </span>
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full border {typeset === preset.id
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-transparent'}"
              aria-hidden="true"
            >
              <Check class="size-3" />
            </span>
          </button>
        {/each}
      </div>
    </section>
  </Dialog.Content>
</Dialog.Root>
