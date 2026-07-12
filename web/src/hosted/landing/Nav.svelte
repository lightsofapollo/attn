<script lang="ts">
  import { readDeskCount } from '../desk-count';

  const deskCount = readDeskCount();
  import { getTheme, toggleTheme } from '../theme.svelte';
</script>

<nav class="site-nav" aria-label="Main navigation">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">a.</span>attn</a>
  <div class="nav-right">
    <a class="nav-link" href="#how">How it works</a>
    <a class="nav-link" href="/app">Your desk</a>
    <a class="nav-link" href="#native">Native app</a>
    <a class="nav-link" href="https://github.com/lightsofapollo/attn">GitHub</a>
    <button class="icon-button" onclick={toggleTheme} aria-label="Toggle theme">
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
    {#if deskCount > 0}
      <a class="button primary" href="/app" data-action="open-desk">Your desk ({deskCount})</a>
    {:else}
      <a class="button primary" href="/app#new" data-action="new-workspace">New workspace</a>
    {/if}
  </div>
</nav>
