<script lang="ts">
  import { getTheme } from '../theme.svelte';
  import ResponsiveScreenshot from './ResponsiveScreenshot.svelte';
  import collabLight from './assets/collab-light.png';
  import collabDark from './assets/collab-dark.png';
  import collabLight768 from './assets/collab-light-768.avif';
  import collabLight1280 from './assets/collab-light-1280.avif';
  import collabLight1920 from './assets/collab-light-1920.avif';
  import collabDark768 from './assets/collab-dark-768.avif';
  import collabDark1280 from './assets/collab-dark-1280.avif';
  import collabDark1920 from './assets/collab-dark-1920.avif';

  const collabShots = {
    light: {
      fallback: collabLight,
      avifSrcset: `${collabLight768} 768w, ${collabLight1280} 1280w, ${collabLight1920} 1920w`,
    },
    dark: {
      fallback: collabDark,
      avifSrcset: `${collabDark768} 768w, ${collabDark1280} 1280w, ${collabDark1920} 1920w`,
    },
  } as const;

  const collabShot = $derived(collabShots[getTheme()]);
</script>

<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow">No account · local by default</p>
    <h1><span>A private desk</span> <span>for working documents.</span></h1>
    <p class="hero-lede">
      Write in the browser or open local Markdown in native attn — one file or many, with images
      and project assets. It stays on this device until you deliberately share an
      end-to-end-encrypted review room. No account, and no server can read the words.
    </p>
    <div class="hero-actions">
      <a class="button primary" href="/app#new" data-action="new-workspace">
        New workspace <span aria-hidden="true">→</span>
      </a>
      <a class="button" href="/app" data-action="open-desk">Open your desk</a>
    </div>
    <div class="local-note">
      <span>Creates untitled.md immediately</span>
      <span>Encrypted when shared</span>
      <span>Peer-to-peer when reachable</span>
    </div>
  </div>

  <div class="product-stage" aria-label="A real attn review with local and shared state labels">
    <div class="window">
      <ResponsiveScreenshot
        fallback={collabShot.fallback}
        avifSrcset={collabShot.avifSrcset}
        sizes="(max-width: 680px) calc(100vw - 2rem), (max-width: 1180px) calc(100vw - 2.8rem), 48vw"
        alt="A real attn document with an inline review comment and suggestion"
        loading="eager"
        fetchpriority="high"
      />
    </div>
    <aside class="stage-label local">
      <strong>Source · local</strong><small>Saved on this device</small>
    </aside>
    <aside class="stage-label share">
      <strong>Review room · live</strong><small>E2EE · direct connection</small>
    </aside>
  </div>
</section>
