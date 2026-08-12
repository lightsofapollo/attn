<script lang="ts">
  import BrandMark from '../../lib/BrandMark.svelte';
  import { getTheme, toggleTheme } from '../theme.svelte';

  /* Mobile navigation (attn-n01r.17). Below 680px `.nav-link { display: none }`
     removed "How it works", "Your desk", "Native app" and GitHub with no
     replacement — the two in-page anchors and the only off-site route in the
     header — leaving a mobile visitor 6,100px of scroll and no way to move
     through it. Desktop offered 7 header stops; mobile offered 2.
     A disclosure rather than a bottom bar: it restores the links without
     changing the page's interaction model, and it carries the aria-expanded /
     aria-controls the finding also asked for. */
  let menuOpen = $state(false);
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && menuOpen) menuOpen = false;
  }}
/>

<nav class="site-nav" aria-label="Main navigation">
  <a class="brand" href="/"><BrandMark class="mark" />attn</a>
  <button
    class="nav-toggle"
    type="button"
    aria-expanded={menuOpen}
    aria-controls="site-nav-links"
    aria-label={menuOpen ? 'Close menu' : 'Open menu'}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      {#if menuOpen}
        <path d="M18 6 6 18M6 6l12 12" />
      {:else}
        <path d="M4 7h16M4 12h16M4 17h16" />
      {/if}
    </svg>
  </button>
  <div class="nav-right" id="site-nav-links" data-open={menuOpen}>
    <a class="nav-link" href="#how">How it works</a>
    <a class="nav-link" href="/app">Your desk</a>
    <a class="nav-link" href="#native">Native app</a>
    <a class="nav-link" href="https://github.com/lightsofapollo/attn">GitHub</a>
    <!-- aria-pressed + an action label (attn-n01r.25). The label was static
         across both states and both icons are aria-hidden, so nothing conveyed
         the current theme (WCAG 4.1.2 — value/state not exposed). -->
    <button
      class="icon-button"
      type="button"
      onclick={toggleTheme}
      aria-pressed={getTheme() === 'dark'}
      aria-label={getTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {#if getTheme() === 'dark'}
        <svg
          class="theme-icon"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      {:else}
        <svg
          class="theme-icon"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      {/if}
    </button>
  </div>
</nav>
