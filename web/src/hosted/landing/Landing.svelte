<script lang="ts">
  import Nav from './Nav.svelte';
  import Hero from './Hero.svelte';
  import EntryStrip from './EntryStrip.svelte';
  import HowItWorks from './HowItWorks.svelte';
  import Surfaces from './Surfaces.svelte';
  import NativeSection from './NativeSection.svelte';
  import Footer from './Footer.svelte';
</script>

<!-- Skip link (attn-n01r.19, WCAG 2.4.1 Bypass Blocks). Tab stops 0-6 were all
     navigation before the first content control, with no way past them, while
     `main` carried an id nothing linked to. Targets the existing #top so no
     other anchor changes. Visible only when focused. -->
<a class="skip-link" href="#top">Skip to content</a>
<!-- <header> so the brand, theme toggle and navigation sit inside a banner landmark.
     Measured landmarks were navigation -> main -> contentinfo, with no banner,
     so the header region was not addressable at all (attn-n01r.19). -->
<header>
  <Nav />
</header>
<main id="top" tabindex="-1">
  <Hero />
  <EntryStrip />
  <HowItWorks />
  <Surfaces />
  <NativeSection />
</main>
<Footer />
