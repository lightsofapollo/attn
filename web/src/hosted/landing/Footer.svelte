<script lang="ts">
  import { onMount } from 'svelte';
  import { onDeskCountRestore, readDeskCount } from '../desk-count';

  // Same branch the nav and hero use, so a returning visitor is offered their
  // desk rather than a create they do not need. Refreshed on bfcache restore,
  // the one path where the mounted value can go stale.
  let deskCount = $state(readDeskCount());
  onMount(() => onDeskCountRestore((count) => (deskCount = count)));
</script>

<!--
  The page used to end on "MIT License · Rust + Svelte · ProseMirror editor" and
  three GitHub links (attn-n01r.20). Peak-end theory puts half the remembered
  experience in the ending, and that ending was a colophon: the reader who had
  just been persuaded got a licence note and a link to Issues.

  Ask who that line is for. The developer who will star the repo has already
  scrolled seven screens to reach it; the person who should create a workspace
  was being shown it instead of an invitation. So: close with the offer, and
  keep the colophon underneath it where it belongs.
-->
<section class="closer" aria-labelledby="closer-heading">
  <h2 id="closer-heading">Start with one file.</h2>
  <p>
    No account, no upload, no naming step. It stays on this device until you decide otherwise.
  </p>
  <div class="closer-actions">
    {#if deskCount > 0}
      <a class="button primary" href="/app" data-action="open-desk">
        Your desk ({deskCount}) <span aria-hidden="true">→</span>
      </a>
      <a class="button" href="/app#new" data-action="new-workspace">New workspace</a>
    {:else}
      <a class="button primary" href="/app#new" data-action="new-workspace">
        New workspace <span aria-hidden="true">→</span>
      </a>
      <a class="button" href="/app#join" data-action="join-review">Join a review</a>
    {/if}
  </div>
</section>

<footer>
  <div class="footer-inner">
    <span>MIT License · Rust + Svelte · ProseMirror editor</span>
    <div class="footer-links">
      <a href="https://github.com/lightsofapollo/attn">GitHub</a>
      <a href="https://github.com/lightsofapollo/attn/issues">Issues</a>
      <a href="https://github.com/lightsofapollo/attn/blob/main/CONTRIBUTING.md">Contributing</a>
    </div>
  </div>
</footer>
