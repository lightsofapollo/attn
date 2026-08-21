<script lang="ts">
  /**
   * One line of "we are still working": the sentence, then a plain ellipsis.
   *
   * There was a spinner in front of it, and it cost the sentence its centre
   * (attn-ze60.5). Every surface that mounts this centres its child, so what
   * was centred was the GROUP — spinner, gap, sentence — leaving the words
   * themselves ~15px right of the middle of the page. The offset then changed
   * with the sentence: the desk's wait and the workspace's wait are different
   * lengths, so crossing from one to the next slid the line sideways under a
   * reader who had been given no reason to expect movement.
   *
   * It is still a COMPONENT rather than loose markup at each call site, and the
   * wrapping span is still the reason: the surfaces centre with
   * `place-items: center` on a grid, so a sentence and anything beside it
   * passed in separately would be two grid items — the second landing on its
   * own row, centred by itself, half a viewport from the first. One element in,
   * one item out.
   */
  interface Props {
    /** The sentence, without its ellipsis — this supplies that. */
    text: string;
  }

  const { text }: Props = $props();
</script>

<!-- The ellipsis is part of the sentence, not a separate animated element:
     this sits inside a `role="status"` region, and anything that ticks inside
     one re-fires the whole announcement on every step. -->
<span class="loading-line">{text}…</span>
