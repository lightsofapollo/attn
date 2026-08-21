<script lang="ts">
  interface Props {
    code: string;
  }

  const { code }: Props = $props();
  let copied = $state(false);
  let failed = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      failed = false;
    } catch {
      // Say so: an empty catch makes a denied clipboard permission
      // indistinguishable from success-minus-feedback (attn-n01r.19). The
      // command stays selectable either way.
      failed = true;
      copied = false;
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      failed = false;
    }, 2400);
  }

  /* The accessible name has to change with the state (attn-n01r.19): it was
     pinned to `Copy ${code}` forever, and with no live region on the page a
     screen-reader user got no confirmation the copy happened. Naming the
     command rather than just "Copy" also keeps two adjacent copy buttons
     distinguishable in a button list. */
  const label = $derived(
    copied ? `Copied ${code}` : failed ? `Copy failed — select ${code} manually` : `Copy ${code}`,
  );
  const commandHintId = $derived(`install-command-hint-${code.replace(/[^a-z0-9]+/giu, '-')}`);

  function scrollCommand(event: KeyboardEvent): void {
    const command = event.currentTarget as HTMLInputElement;
    const distance = Math.max(48, Math.round(command.clientWidth * 0.8));

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        command.scrollBy({ left: -distance, behavior: 'auto' });
        break;
      case 'ArrowRight':
        event.preventDefault();
        command.scrollBy({ left: distance, behavior: 'auto' });
        break;
      case 'Home':
        event.preventDefault();
        command.scrollTo({ left: 0, behavior: 'auto' });
        break;
      case 'End':
        event.preventDefault();
        command.scrollTo({ left: command.scrollWidth, behavior: 'auto' });
        break;
    }
  }
</script>

<div class="code">
  <input
    class="code-command"
    type="text"
    value={code}
    readonly
    aria-label={`Install command: ${code}`}
    aria-describedby={commandHintId}
    data-scrollable-command
    onkeydown={scrollCommand}
  />
  <!-- Keep the command in the source text as well as in the readonly control.
       The visual text lives in the input; this makes older text-based checks
       and non-form fallback readers retain the same discoverable command. -->
  <span class="visually-hidden">{code}</span>
  <button
    class="code-copy"
    type="button"
    onclick={copy}
    aria-label={label}
    title={copied ? 'Copied' : 'Copy'}
    data-state={copied ? 'copied' : failed ? 'failed' : 'idle'}
  >
    <!-- Icon, not the word (attn-n01r.2). Two stacked install commands each
         carried a full-width-competing "Copy" at mobile size. Clipboard is
         conventional enough to read without the word, and the check on success
         is the confirmation the text used to carry. -->
    {#if copied}
      <svg
        viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    {:else}
      <svg
        viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      >
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </svg>
    {/if}
  </button>
  <!-- Announced politely: a button's own name change is not reliably re-read by
       every screen reader after activation, and this page had no live region at
       all. -->
  <span class="visually-hidden" id={commandHintId}>
    Use the left and right arrow keys to read the full command.
  </span>
  <span class="visually-hidden" role="status" aria-live="polite">
    {copied ? `Copied ${code}` : failed ? 'Copy failed. Select the command to copy it manually.' : ''}
  </span>
</div>
