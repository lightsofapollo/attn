<script lang="ts">
  import { getTheme } from '../theme.svelte';
  import ResponsiveScreenshot from './ResponsiveScreenshot.svelte';
  import shareLight from './assets/share-light.png';
  import shareDark from './assets/share-dark.png';
  import shareLight768 from './assets/share-light-768.avif';
  import shareLight1280 from './assets/share-light-1280.avif';
  import shareLight1920 from './assets/share-light-1920.avif';
  import shareDark768 from './assets/share-dark-768.avif';
  import shareDark1280 from './assets/share-dark-1280.avif';
  import shareDark1920 from './assets/share-dark-1920.avif';

  const shareShots = {
    light: {
      fallback: shareLight,
      avifSrcset: `${shareLight768} 768w, ${shareLight1280} 1280w, ${shareLight1920} 1920w`,
    },
    dark: {
      fallback: shareDark,
      avifSrcset: `${shareDark768} 768w, ${shareDark1280} 1280w, ${shareDark1920} 1920w`,
    },
  } as const;

  const shareShot = $derived(shareShots[getTheme()]);
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
      <ResponsiveScreenshot
        fallback={shareShot.fallback}
        avifSrcset={shareShot.avifSrcset}
        sizes="(max-width: 680px) calc(100vw - 2rem), (max-width: 1180px) 60vw, 710px"
        alt="The attn Share for review dialog"
      />
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
