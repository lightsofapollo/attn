<script lang="ts">
  import { getTheme } from '../theme.svelte';
  import shareLight from './assets/share-light.png';
  import shareDark from './assets/share-dark.png';

  const shareShot = $derived(getTheme() === 'dark' ? shareDark : shareLight);
</script>

<section class="chapter" id="how">
  <div class="chapter-head">
    <div><span class="chapter-index">01 / THE MODEL</span></div>
    <div>
      <h2>A document first. A room only when you share.</h2>
      <p class="chapter-intro">
        Everything starts as a private document on your device. Sharing does not turn it into a
        cloud file — it publishes an encrypted revision around which review can happen.
      </p>
    </div>
  </div>
  <div class="steps">
    <article class="step">
      <span class="step-num">01</span>
      <h3>Create locally</h3>
      <p>
        Stored on this device. One click creates a workspace with untitled.md; add more Markdown,
        images, or project assets as it grows.
      </p>
    </article>
    <article class="step">
      <span class="step-num">02</span>
      <h3>Share deliberately</h3>
      <p>
        A room exists only after Share. It carries a secret-bearing link, and attn’s services
        store ciphertext — never a readable cloud copy.
      </p>
    </article>
    <article class="step">
      <span class="step-num">03</span>
      <h3>Work anywhere</h3>
      <p>
        Browser or native, the same comments, suggestions, and live edits — direct when reachable,
        encrypted mailbox otherwise.
      </p>
    </article>
  </div>

  <div class="share-proof">
    <div class="capture">
      <img src={shareShot} alt="The attn Share for review dialog" loading="lazy" />
    </div>
    <div class="proof-copy">
      <p class="eyebrow">The moment local becomes shared</p>
      <blockquote>“A room exists only after you press Share.”</blockquote>
      <p>
        The secret lives in the link’s fragment, so it never reaches attn’s servers. Anyone you
        share with can review from the browser or native attn.
      </p>
    </div>
  </div>
</section>
