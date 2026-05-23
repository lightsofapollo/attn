<!--
  Onboarding display-name prompt (attn). Shown once the first time the user
  shares or has joined a shared doc with no name set yet — and reusable as the
  "edit your name" affordance. Pre-filled with the resolved git/OS default.

  In-app dialog (per project convention: never window.prompt/confirm/alert).
  `onConfirm(name)` fires with the entered name (caller persists + proceeds);
  `onSkip` accepts the default and proceeds without setting an override.
-->
<script lang="ts">
  import * as Dialog from './components/ui/dialog';
  import { Button } from './components/ui/button';
  import { Input } from './components/ui/input';

  interface Props {
    open: boolean;
    /** Initial value (the chosen name or resolved default). */
    suggestion: string;
    /** Title/CTA differ slightly for first-run vs. editing later. */
    mode?: 'onboard' | 'edit';
    onConfirm: (name: string) => void;
    onSkip?: () => void;
  }

  let {
    open = $bindable(),
    suggestion,
    mode = 'onboard',
    onConfirm,
    onSkip,
  }: Props = $props();

  // Local editable copy seeded from the suggestion when the dialog opens.
  let value = $state('');
  let lastOpen = $state(false);
  $effect(() => {
    if (open && !lastOpen) {
      value = suggestion;
    }
    lastOpen = open;
  });

  const trimmed = $derived(value.trim());

  function confirm(): void {
    onConfirm(trimmed);
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
        This name appears on your comments and in the people list when you
        collaborate. You can change it anytime.
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
