<!--
  Onboarding display-name prompt (attn). Shown once the first time the user
  shares or has joined a shared doc with no name set yet — and reusable as the
  "edit your name" affordance. Pre-filled with the resolved git/OS default.

  Also owns the identity-color picker (attn-3gdd): a curated swatch row that
  previews the live monogram chip. "Auto" (null) means the deterministic
  hash of the participant id — the default, and what everyone gets before
  picking.

  In-app dialog (per project convention: never window.prompt/confirm/alert).
  `onConfirm(name, color)` fires with the entered name + picked color (caller
  persists + proceeds); `onSkip` accepts the defaults and proceeds without
  setting an override.
-->
<script lang="ts">
  import * as Dialog from './components/ui/dialog';
  import { Button } from './components/ui/button';
  import { Input } from './components/ui/input';
  import { monogramFor } from './peer-strip-format';
  import { PARTICIPANT_PALETTE } from './participant-color';

  interface Props {
    open: boolean;
    /** Initial value (the chosen name or resolved default). */
    suggestion: string;
    /** Initially picked identity color, or null for Auto. */
    initialColor?: string | null;
    /** Title/CTA differ slightly for first-run vs. editing later. */
    mode?: 'onboard' | 'edit';
    onConfirm: (name: string, color: string | null) => void;
    onSkip?: () => void;
  }

  let {
    open = $bindable(),
    suggestion,
    initialColor = null,
    mode = 'onboard',
    onConfirm,
    onSkip,
  }: Props = $props();

  // Local editable copies seeded from the props when the dialog opens.
  let value = $state('');
  let pickedColor = $state<string | null>(null);
  let lastOpen = $state(false);
  $effect(() => {
    if (open && !lastOpen) {
      value = suggestion;
      pickedColor = initialColor;
    }
    lastOpen = open;
  });

  const trimmed = $derived(value.trim());
  // Live monogram preview inside each swatch — shows exactly what the peer
  // chip will look like, including white-text contrast.
  const previewMonogram = $derived(monogramFor(trimmed || suggestion));

  function confirm(): void {
    onConfirm(trimmed, pickedColor);
    open = false;
  }

  function skip(): void {
    onSkip?.();
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && trimmed.length > 0) {
      event.preventDefault();
      confirm();
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="w-[min(28rem,calc(100%-2rem))] max-w-[28rem]"
    data-slot="name-prompt"
  >
    <Dialog.Header>
      <Dialog.Title>
        {mode === 'edit' ? 'Edit your name' : 'How should others see you?'}
      </Dialog.Title>
      <Dialog.Description>
        This name and color appear on your comments, your caret, and in the
        people list when you collaborate. You can change them anytime.
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-2">
      <!-- svelte-ignore a11y_autofocus -->
      <Input
        type="text"
        bind:value
        placeholder="Your name"
        aria-label="Your display name"
        data-slot="name-prompt-input"
        autofocus
        onkeydown={onKeydown}
      />
    </div>

    <fieldset class="border-0 p-0" data-slot="name-prompt-colors">
      <legend class="pb-1.5 text-xs font-medium text-muted-foreground">
        Your color
      </legend>
      <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Identity color">
        <!-- Auto: the deterministic per-identity color. Dashed ring, no fill —
             we can't preview the hash here (the participant id lives on the
             identity, not in this dialog), so it reads as "decided for you". -->
        <button
          type="button"
          role="radio"
          aria-checked={pickedColor === null}
          class="name-prompt-swatch name-prompt-swatch-auto inline-flex size-7 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-badge font-semibold text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          class:name-prompt-swatch-selected={pickedColor === null}
          data-slot="name-prompt-swatch"
          data-color="auto"
          title="Automatic — a color derived from your identity"
          onclick={() => (pickedColor = null)}
        >
          <span aria-hidden="true">A</span>
          <span class="sr-only">Automatic color</span>
        </button>
        {#each PARTICIPANT_PALETTE as swatch (swatch.id)}
          <button
            type="button"
            role="radio"
            aria-checked={pickedColor === swatch.color}
            class="name-prompt-swatch inline-flex size-7 items-center justify-center rounded-full text-badge font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            class:name-prompt-swatch-selected={pickedColor === swatch.color}
            data-slot="name-prompt-swatch"
            data-color={swatch.id}
            style="background-color: {swatch.color};"
            title={swatch.id}
            onclick={() => (pickedColor = swatch.color)}
          >
            <span aria-hidden="true">{previewMonogram}</span>
            <span class="sr-only">{swatch.id}</span>
          </button>
        {/each}
      </div>
    </fieldset>

    <Dialog.Footer>
      {#if mode === 'onboard'}
        <Button variant="ghost" data-slot="name-prompt-skip" onclick={skip}>
          Skip
        </Button>
      {/if}
      <Button
        data-slot="name-prompt-confirm"
        disabled={trimmed.length === 0}
        onclick={confirm}
      >
        {mode === 'edit' ? 'Save' : 'Continue'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Selected swatch: the ring treatment the self peer-chip already uses —
     background gap + ring so it survives on every swatch hue. */
  .name-prompt-swatch-selected {
    box-shadow:
      0 0 0 2px var(--background),
      0 0 0 4px var(--ring);
  }
</style>
