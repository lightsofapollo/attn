<script lang="ts">
  import { onMount } from 'svelte';
  import BrandMark from '../../lib/BrandMark.svelte';

  /* THE ONE RECOVERY SURFACE (attn-08fa.10). attn had three lost states in
     three unrelated designs: this page, the workspace-not-found branch in
     AppShell (which rendered with no header at all and a muted underlined link
     matching neither link rule), and the review lifecycle's error states. They
     disagreed on header, type scale, link treatment and even on whether the
     headline took a full stop. This component is now the shared one, so the
     grammar is settled in a single file and a caller may only change the words.

     It is mounted by BOTH the landing and app entries and therefore carries its
     own styles rather than reaching for app-shell.css. */
  interface Props {
    /** Small label above the headline. */
    status?: string;
    /** The headline. Ends in a full stop — the family speaks in sentences. */
    heading?: string;
    /** One paragraph: what happened, and what is still safe. */
    copy?: string;
    primary?: { href: string; label: string };
    secondary?: { href: string; label: string };
    /** Document title; also the `noindex` surface's name. */
    documentTitle?: string;
  }

  const {
    status = '404 · Page not found',
    heading = 'That page isn’t here.',
    copy = 'The address may be incomplete or out of date. Your local work and review links have not changed.',
    primary = { href: '/app', label: 'Go to your desk' },
    secondary = { href: '/', label: 'Go home' },
    documentTitle = 'Page not found · attn',
  }: Props = $props();

  let headingElement = $state<HTMLHeadingElement>();

  // A failed navigation should put the recovery choices in the keyboard and
  // screen-reader reading order immediately, not leave focus in stale chrome.
  onMount(() => headingElement?.focus());
</script>

<svelte:head>
  <title>{documentTitle}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="not-found-shell">
  <header class="not-found-header" data-slot="app-shell-header">
    <a class="not-found-brand" href="/" aria-label="attn home">
      <BrandMark size={32} />
      <span>attn</span>
    </a>
    <a class="not-found-desk" href="/app">Your desk</a>
  </header>

  <main class="not-found-main">
    <p class="not-found-status">{status}</p>
    <h1 bind:this={headingElement} tabindex="-1">{heading}</h1>
    <p class="not-found-copy">{copy}</p>
    <nav class="not-found-actions" aria-label="Recovery actions">
      <a class="button primary" href={primary.href}>{primary.label}</a>
      <a class="button" href={secondary.href}>{secondary.label}</a>
    </nav>
  </main>
</div>

<style>
  .not-found-shell {
    min-height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr;
  }

  /* The accent plane, like every other header in the app (attn-08fa.13). The
     data-slot in the markup is what re-points the tokens; tokens.css owns that
     block, and this file only has to name the ground. */
  .not-found-header {
    display: flex;
    min-height: 70px;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem clamp(1rem, 4vw, 4.5rem);
    background: var(--header-surface);
    border-bottom: 1px solid var(--panel-border);
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
    /* Title step. Was 1.28rem, which is on no step of the ramp. */
    font: 750 1.25rem var(--serif);
  }

  /* A chrome anchor: no rest underline, affordance carried by position and
     hover — the treatment DESIGN.md specifies for nav rows and breadcrumbs, and
     now the one every recovery surface uses. */
  .not-found-desk {
    color: var(--muted-foreground);
    font: 650 0.85rem var(--sans);
  }

  .not-found-desk:hover {
    color: var(--foreground);
  }

  .not-found-main {
    width: min(100% - 2rem, 44rem);
    align-self: center;
    margin: 0 auto;
    padding: clamp(4rem, 12vh, 9rem) 0;
  }

  /* The label step, uppercase — the same eyebrow the desk, open and storage
     pages wear above their titles. */
  .not-found-status {
    margin: 0 0 1rem;
    color: var(--hosted-muted);
    font: 600 0.7rem/1.2 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* Display step, fixed. The Fixed-Scale Rule's marketing carve-out covers the
     landing hero and section heads and nothing else — "everything else,
     including the desk and the app shell, stays on the fixed ramp". This ran
     clamp(3rem, 8vw, 5.5rem), which at 1440px set a lost-state headline nearly
     three times the size of the desk's own h1. Matching the desk is the point:
     the same voice at the same size, saying something went wrong. */
  h1 {
    max-width: 16ch;
    margin: 0;
    font: 700 2rem/1.18 var(--serif);
    letter-spacing: -0.02em;
    overflow-wrap: break-word;
  }

  .not-found-copy {
    max-width: 52ch;
    margin: 1.25rem 0 0;
    color: var(--hosted-muted);
    font: 1rem/1.6 var(--sans);
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
