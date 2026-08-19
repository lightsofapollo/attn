<script lang="ts">
  import { onMount } from 'svelte';
  import { getTheme } from '../theme.svelte';
  import { LOCAL_FIRST_CLAIM } from '../../lib/save-state-copy';
  import { onDeskCountRestore, readDeskCount } from '../desk-count';

  // Returning users lead with their desk (attn-cjn); first-timers keep the
  // zero-friction create. The count only changes in /app, so it refreshes on
  // exactly one signal: a back/forward-cache restore of this page.
  let deskCount = $state(readDeskCount());
  onMount(() => onDeskCountRestore((count) => (deskCount = count)));
  import ResponsiveScreenshot from './ResponsiveScreenshot.svelte';
  import collabLight from './assets/collab-light-fallback.webp';
  import collabDark from './assets/collab-dark-fallback.webp';
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
  const collabShot = $derived(collabShots[getTheme() === 'dark' ? 'dark' : 'light']);
</script>

<section class="hero">
  <div class="hero-copy">
    <!-- No eyebrow (attn-n01r.9): a tracked-caps kicker above an oversized
         headline is the default AI-SaaS hero shape, and PRODUCT.md lists
         cloud-SaaS as an anti-reference. The lede already carries its claim
         ("no account, local by default").

         The headline argues the product's stated positioning rather than a
         category anyone occupies (attn-n01r.10). PRODUCT.md: "The reviewer for
         agent-authored docs: the one place where you and your agents review the
         same document together, human comments and AI suggestions in a single
         end-to-end-encrypted thread, over files that never leave your machine
         in the clear."
         A page that never says "agent" or "AI" sells a private Markdown editor
         — a category with a dozen occupants — and leaves the one thing that
         makes attn a new product unmentioned. Wording is drawn from PRODUCT.md,
         not invented here; the voice it asks for is "it states, it doesn't
         sell". -->
    <h1><span>Review it together.</span> <span>Even when they aren’t human.</span></h1>
    <!-- The first sentence names the category (critique 2026-08-18: nothing
         above the fold said what attn IS — the <title> tag was clearer than
         the page). It carries the noun; the headline keeps the argument. -->
    <p class="hero-lede">
      <!-- "in the clear" is load-bearing, not hedging (attn-08fa.3). Sharing
           publishes an ENCRYPTED copy, which the model section below states
           plainly — so the unqualified claim was the one sentence on the page a
           skeptical security reader could falsify, and falsifying it would put
           every other claim in doubt. Three words make it exactly true, and the
           promise is not weakened: nobody but the people in the review can read
           it, which is what the reader actually cares about. -->
      attn is a Markdown reviewer for the documents on your disk. Your comments and your agents’
      suggestions land in the same margin, under the same rules — distinguished by who wrote them,
      not by hierarchy. No account. The file never leaves your machine in the clear.
    </p>
    <p class="hero-security">
      <strong>End-to-end encrypted when you share.</strong> The relay routes ciphertext and never holds a key.
    </p>
    <div class="hero-actions">
      {#if deskCount > 0}
        <a class="button primary" href="/app" data-action="open-desk">
          Your desk ({deskCount}) <span aria-hidden="true">→</span>
        </a>
        <a class="button" href="/app#new" data-action="new-workspace">New workspace</a>
      {:else}
        <a class="button primary" href="/app#new" data-action="new-workspace">
          New workspace <span aria-hidden="true">→</span>
        </a>
        <!-- Same name as the nav link for the same destination (critique
             2026-08-18: one place, two labels). -->
        <a class="button" href="/app" data-action="open-desk">Your desk</a>
      {/if}
    </div>
  </div>

  <!-- No aria-label here (attn-n01r.25): `aria-label` is only honoured on
       elements whose role supports naming, and a bare div maps to `generic`, so
       the string was discarded — verified absent from the AX tree. Worse than
       no label, because it read as coverage. The inner <img> alt and the two
       <aside> labels already carry the meaning. -->
  <div class="product-stage">
    <div class="window">
      <!-- Responsive AVIF with PNG fallback + intrinsic dimensions — the
           hero is the largest paint on the page, and the landing perf gate
           asserts both the CLS box and the AVIF payload. -->
      <ResponsiveScreenshot
        fallback={collabShot.fallback}
        avifSrcset={collabShot.avifSrcset}
        sizes="(max-width: 680px) calc(100vw - 2rem), (max-width: 1180px) calc(100vw - 5rem), 620px"
        alt="A real attn document with a reviewer's comment and an agent's suggestion in the same margin"
        loading="eager"
        fetchpriority="high"
      />
    </div>
    <!-- "Saved on this device" is the local-first claim, and this is one of the
         two places that still own it (the other is the desk header's
         persistence badge). It used to double as the save-state literal in the
         SaveState union; attn-yzsa.2 split the two jobs and moved the save
         state to "Changes autosaved", so this line is now the claim only. Do
         not "unify" it with the chip copy — the product would quietly stop
         saying the thing it is built on. -->
    <aside class="stage-label local">
      <strong>Source · local</strong><small>{LOCAL_FIRST_CLAIM}</small>
    </aside>
    <aside class="stage-label share">
      <strong>Review room · live</strong><small>E2EE · direct connection</small>
      <!-- The join-mechanism claim sits on the proof: this label annotates the
           window where the agent's suggestion is visible. The verbatim CLI
           lives in the native section beside the install commands. -->
      <small>Agents join by invite, as peers</small>
    </aside>
    <a class="stage-demo-link" href="/app?surface=landing-review-demo">
      Watch a live review <span aria-hidden="true">→</span>
    </a>
  </div>
</section>
