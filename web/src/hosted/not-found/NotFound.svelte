<script lang="ts">
  import { onMount } from 'svelte';
  import BrandMark from '../../lib/BrandMark.svelte';

  let headingElement = $state<HTMLHeadingElement>();

  // A failed navigation should put the recovery choices in the keyboard and
  // screen-reader reading order immediately, not leave focus in stale chrome.
  onMount(() => headingElement?.focus());
</script>

<svelte:head>
  <title>Page not found · attn</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="not-found-shell">
  <header class="not-found-header">
    <a class="not-found-brand" href="/" aria-label="attn home">
      <BrandMark size={32} />
      <span>attn</span>
    </a>
    <a class="not-found-desk" href="/app">Your desk</a>
  </header>

  <main class="not-found-main">
    <p class="not-found-status">404 · Page not found</p>
    <h1 bind:this={headingElement} tabindex="-1">That page isn’t here.</h1>
    <p class="not-found-copy">
      The address may be incomplete or out of date. Your local work and review links have not
      changed.
    </p>
    <nav class="not-found-actions" aria-label="Recovery actions">
      <a class="button primary" href="/app">Go to your desk</a>
      <a class="button" href="/">Go home</a>
    </nav>
  </main>
</div>

<style>
  .not-found-shell {
    min-height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  .not-found-header {
    display: flex;
    min-height: 70px;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem clamp(1rem, 4vw, 4.5rem);
    border-bottom: 1px solid var(--rule);
    font-family: var(--sans);
  }

  .not-found-brand,
  .not-found-desk {
    display: inline-flex;
    min-height: 44px;
    align-items: center;
  }

  .not-found-brand {
    gap: 0.65rem;
    font: 750 1.28rem var(--serif);
  }

  .not-found-desk {
    color: var(--hosted-muted);
    font: 650 0.9rem var(--sans);
  }

  .not-found-desk:hover {
    color: var(--ink);
  }

  .not-found-main {
    width: min(100% - 2rem, 44rem);
    align-self: center;
    margin: 0 auto;
    padding: clamp(4rem, 12vh, 9rem) 0;
  }

  .not-found-status {
    margin: 0 0 1rem;
    color: var(--hosted-muted);
    font: 650 0.82rem/1.3 var(--sans);
    letter-spacing: 0.035em;
  }

  h1 {
    max-width: 11ch;
    margin: 0;
    font: 650 clamp(3rem, 8vw, 5.5rem) / 0.94 var(--serif);
    letter-spacing: -0.045em;
    overflow-wrap: break-word;
  }

  .not-found-copy {
    max-width: 52ch;
    margin: 1.5rem 0 0;
    color: var(--hosted-muted);
    font: 1.05rem/1.65 var(--sans);
    overflow-wrap: break-word;
  }

  .not-found-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-top: 2rem;
  }

  @media (max-width: 420px) {
    .not-found-header {
      padding-inline: 1rem;
    }

    .not-found-main {
      width: min(100% - 2rem, 44rem);
      padding-block: 3.5rem;
    }

    .not-found-actions > a {
      flex: 1 1 100%;
    }
  }
</style>
