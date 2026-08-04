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
</script>

<!-- Confirmation before a file switch tears down an engaged review session.
     Esc / overlay click cancels (stay on the reviewed document); Enter lands
     on the focused confirm button. -->
<Dialog.Root {open} onOpenChange={(next) => { if (!next) onCancel(); }}>
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
      <Button autofocus onclick={onConfirm} data-slot="review-exit-proceed">
        Exit review
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
