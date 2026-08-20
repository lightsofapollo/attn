<script lang="ts">
  /**
   * One line of "we are still working": a spinner, then the sentence, then a
   * plain ellipsis.
   *
   * It is a COMPONENT rather than loose markup at each call site, and the
   * wrapping span is the reason: every surface that mounts this centres its
   * child with `place-items: center` on a grid, so a spinner and a sentence
   * passed in separately are two grid items — the second lands on its own row,
   * centred by itself, half a viewport from the first. One element in, one item
   * out.
   */
  interface Props {
    /** The sentence, without its ellipsis — this supplies that. */
    text: string;
  }

  const { text }: Props = $props();
</script>

<span class="loading-line">
  <!-- Sized in `em`, so the one spinner serves both the full-viewport waits
       (1.5rem) and the in-column one (1.15rem) without a second rule.

       Two circles rather than a bordered box: at this size a border-drawn ring
       renders lumpy at the quadrant joins, and a stroked arc with a round cap
       is the shape the design actually asks for. -->
  <svg class="loading-spinner" viewBox="0 0 24 24" aria-hidden="true">
    <circle class="loading-spinner-track" cx="12" cy="12" r="9" />
    <circle class="loading-spinner-arc" cx="12" cy="12" r="9" />
  </svg>
  <!-- The ellipsis is part of the sentence, not a separate animated element:
       this sits inside a `role="status"` region, and anything that ticks inside
       one re-fires the whole announcement on every step. -->
  <span class="loading-line-text">{text}…</span>
</span>
