<script lang="ts">
  import * as Dialog from './components/ui/dialog';
  import { Button } from './components/ui/button';

  interface Props {
    open: boolean;
    documentName: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { open, documentName, onConfirm, onCancel }: Props = $props();

  // Two different things close this dialog and they mean opposite things.
  // Confirming closes it from the PARENT (the parent flips `open`), while
  // Esc / overlay / close-button close it from inside bits-ui, which reports
  // that through `onOpenChange`. Only the second is a cancel.
  //
  // bits-ui invokes `onOpenChange` from its own setter alone, so a
  // parent-driven close does not double-fire today — but the confirm path
  // hands off a parked navigation closure, and a stray cancel on that path
  // silently drops it. Latch the intent instead of depending on that detail.
  let confirming = $state(false);

  // Reopening always starts unconfirmed.
  $effect(() => {
    if (open) confirming = false;
  });

  function handleConfirm(): void {
    confirming = true;
    onConfirm();
  }

  function handleOpenChange(next: boolean): void {
    if (next) return;
    if (confirming) {
      confirming = false;
      return;
    }
    onCancel();
  }
</script>

<!-- Confirmation before a file switch tears down an engaged review session.
     Esc / overlay click cancels (stay on the reviewed document); Enter lands
     on the focused confirm button. -->
<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content
    class="w-[min(24rem,calc(100%-2rem))] max-w-[24rem]"
    data-slot="review-exit-confirm"
    showCloseButton={false}
  >
    <Dialog.Header>
      <Dialog.Title>Exit review?</Dialog.Title>
      <Dialog.Description>
        You're reviewing
        <span class="font-medium text-foreground">{documentName}</span>.
        Switching files closes the review panel for this document — the share
        and its comments stay intact.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={onCancel} data-slot="review-exit-cancel">
        Keep reviewing
      </Button>
      <!-- svelte-ignore a11y_autofocus -->
      <Button autofocus onclick={handleConfirm} data-slot="review-exit-proceed">
        Exit review
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
