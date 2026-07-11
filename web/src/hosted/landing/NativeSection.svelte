<script lang="ts">
  import { getTheme } from './theme.svelte';
  import CopyCode from './CopyCode.svelte';
  import editorLight from './assets/editor-light.png';
  import editorDark from './assets/editor-dark.png';

  const editorShot = $derived(getTheme() === 'dark' ? editorDark : editorLight);
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
      <img
        src={editorShot}
        alt="The native attn editor showing a Markdown document"
        loading="lazy"
      />
    </div>
  </div>
</section>
