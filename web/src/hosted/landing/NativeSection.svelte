<script lang="ts">
  import { getTheme } from '../theme.svelte';
  import CopyCode from './CopyCode.svelte';
  import ResponsiveScreenshot from './ResponsiveScreenshot.svelte';
  import editorLight from './assets/editor-light-fallback.webp';
  import editorDark from './assets/editor-dark-fallback.webp';
  import editorLight768 from './assets/editor-light-768.avif';
  import editorLight1280 from './assets/editor-light-1280.avif';
  import editorLight1920 from './assets/editor-light-1920.avif';
  import editorDark768 from './assets/editor-dark-768.avif';
  import editorDark1280 from './assets/editor-dark-1280.avif';
  import editorDark1920 from './assets/editor-dark-1920.avif';

  const editorShots = {
    light: {
      fallback: editorLight,
      avifSrcset: `${editorLight768} 768w, ${editorLight1280} 1280w, ${editorLight1920} 1920w`,
    },
    dark: {
      fallback: editorDark,
      avifSrcset: `${editorDark768} 768w, ${editorDark1280} 1280w, ${editorDark1920} 1920w`,
    },
  } as const;

  const editorShot = $derived(editorShots[getTheme()]);
</script>

<section class="native-section" id="native">
  <div class="native-grid">
    <div>
      <p class="eyebrow">Native attn is still first-class</p>
      <h2>Your files. A real window.</h2>
      <p>
        Install native attn when you want whole folders, terminal launch, live reload, and a
        dedicated review workspace beside your editor.
      </p>
      <CopyCode code="brew install lightsofapollo/attn/attn" />
      <CopyCode code="npx attnmd" />
    </div>
    <div class="native-shot">
      <ResponsiveScreenshot
        fallback={editorShot.fallback}
        avifSrcset={editorShot.avifSrcset}
        sizes="(max-width: 680px) calc(100vw - 2rem), (max-width: 1180px) calc(100vw - 2.8rem), 650px"
        alt="The native attn editor showing a Markdown document"
      />
    </div>
  </div>
</section>
