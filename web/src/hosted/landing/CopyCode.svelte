<script lang="ts">
  interface Props {
    code: string;
  }

  const { code }: Props = $props();
  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copied = false;
      }, 1600);
    } catch {
      // Clipboard may be unavailable; leave the command selectable.
    }
  }
</script>

<div class="code">
  <span>{code}</span>
  <button class="code-copy" onclick={copy} aria-label={`Copy ${code}`}>
    {copied ? 'Copied' : 'Copy'}
  </button>
</div>
