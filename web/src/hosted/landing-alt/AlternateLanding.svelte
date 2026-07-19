<script lang="ts">
  import { getTheme, toggleTheme } from '../theme.svelte';
  import ReviewDemo from './ReviewDemo.svelte';
  import './alternate-landing.css';
</script>

<svelte:head>
  <title>attn — Review Markdown with people and AI agents</title>
  <meta
    name="description"
    content="Open Markdown from your browser or terminal. Comment, suggest, and accept changes with people and AI agents in one end-to-end-encrypted review."
  />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="alt-home">
  <div class="concept-bar">
    <span>Homepage concept · interactive review</span>
    <a href="/">View current homepage <span aria-hidden="true">↗</span></a>
  </div>

  <nav class="alt-nav" aria-label="Main navigation">
    <a class="alt-brand" href="/homepage-alt" aria-label="attn alternate homepage">
      <span aria-hidden="true">a.</span>attn
    </a>
    <div class="alt-nav-links">
      <a href="#how">How it works</a>
      <a href="#private">Privacy</a>
      <a href="https://github.com/lightsofapollo/attn">GitHub</a>
      <button class="alt-theme" type="button" onclick={toggleTheme} aria-label="Toggle theme">
        {#if getTheme() === 'dark'}
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.2A9 9 0 0 1 8.8 3.5 9 9 0 1 0 20.5 15.2Z" /></svg>
        {/if}
      </button>
      <a class="alt-nav-cta" href="/app#new">Open attn <span aria-hidden="true">→</span></a>
    </div>
  </nav>

  <main id="top">
    <section class="alt-hero">
      <div class="hero-statement">
        <p class="hero-kicker">Private Markdown review</p>
        <h1>Review Markdown with people <em>and</em> AI agents.</h1>
        <p class="hero-summary">
          Open files from your browser or terminal. Comment, suggest, and accept changes in one
          encrypted review—without moving the source of truth to someone else’s cloud.
        </p>
        <div class="hero-ctas">
          <a class="alt-button primary" href="#try-review">Try the review <span aria-hidden="true">↓</span></a>
          <a class="alt-button quiet" href="/open">Open your Markdown</a>
        </div>
        <ul class="hero-assurances" aria-label="Product assurances">
          <li>No account</li>
          <li>Local by default</li>
          <li>End-to-end encrypted when shared</li>
        </ul>
      </div>

      <div class="hero-aside" aria-hidden="true">
        <span class="hero-filename">direction.md</span>
        <span class="hero-thread">3 peers · 2 open</span>
        <p>One source file.<br />Many careful readers.</p>
      </div>
    </section>

    <section class="try-section" id="try-review">
      <div class="try-heading">
        <div>
          <p class="try-instruction"><span>Try it</span> Select a sentence. Leave a real comment.</p>
          <h2>The agents started the review. Add your voice.</h2>
        </div>
        <p>
          Claude and Codex are already in the margin. Their feedback uses the same review loop
          you do—and you still decide what reaches the file.
        </p>
      </div>
      <ReviewDemo />
      <div class="try-after">
        <p>That was the product. No tour required.</p>
        <a href="/app#new">Start with a real document <span aria-hidden="true">→</span></a>
      </div>
    </section>

    <section class="review-loop" id="how">
      <div class="loop-intro">
        <p>From file to finished decision</p>
        <h2>Your document stays a document.</h2>
        <p class="loop-summary">
          attn adds a private review layer around ordinary Markdown. It does not replace your files,
          your editor, or your repository.
        </p>
      </div>

      <ol class="loop-steps">
        <li>
          <span>01</span>
          <div><h3>Open what already exists.</h3><p>A single <code>.md</code> file, a folder, or a working project—from the browser or <code>attn plan.md</code>.</p></div>
          <strong aria-hidden="true">↘</strong>
        </li>
        <li>
          <span>02</span>
          <div><h3>Invite another mind.</h3><p>Send one encrypted link to a person or an agent. The relay can move the bytes, but it cannot read them.</p></div>
          <strong aria-hidden="true">↘</strong>
        </li>
        <li>
          <span>03</span>
          <div><h3>Decide in the document.</h3><p>Accept changes, reject noise, resolve comments. Only your decisions reach the local source file.</p></div>
          <strong aria-hidden="true">✓</strong>
        </li>
      </ol>
    </section>

    <section class="peer-section">
      <div class="peer-quote">
        <blockquote>“The agent doesn’t get a special inbox. It joins the same margin.”</blockquote>
        <p>Human and agent feedback share one review vocabulary: attribution, context, and a decision from the owner.</p>
      </div>
      <div class="peer-ledger" aria-label="Example review participants">
        <div><span class="ledger-avatar owner">JL</span><p><strong>James</strong><small>Owner · final say</small></p><em>2 accepted</em></div>
        <div><span class="ledger-avatar reviewer">MK</span><p><strong>Maya</strong><small>Reviewer · by link</small></p><em>3 comments</em></div>
        <div><span class="ledger-avatar agent">C</span><p><strong>Claude</strong><small>Agent · same thread</small></p><em>1 suggestion</em></div>
      </div>
    </section>

    <section class="private-section" id="private">
      <div class="private-copy">
        <p class="private-kicker">Private by construction</p>
        <h2>The cloud carries ciphertext. You keep the words.</h2>
        <p>
          Your source stays on your device. When you share, attn creates an end-to-end-encrypted
          room for the review—not a cloud copy of the document.
        </p>
        <a href="https://github.com/lightsofapollo/attn">Inspect the source <span aria-hidden="true">↗</span></a>
      </div>
      <div class="privacy-diagram" aria-label="How an encrypted attn review moves between peers">
        <div class="privacy-node local-node">
          <span>01 · your device</span><strong>plan.md</strong><small>plaintext · local</small>
        </div>
        <div class="privacy-transit">
          <span aria-hidden="true">••••••••••••••</span><strong>E2EE</strong><small>relay sees ciphertext</small>
        </div>
        <div class="privacy-node peer-node">
          <span>02 · invited peer</span><strong>review room</strong><small>decrypts at the edge</small>
        </div>
      </div>
    </section>

    <section class="editor-callout">
      <div>
        <p>Just want to try Markdown?</p>
        <h2>Open the browser editor. No signup, no setup.</h2>
      </div>
      <div class="editor-actions">
        <a class="alt-button primary" href="/app#new">Start an untitled.md <span aria-hidden="true">→</span></a>
        <span>or drop a file at <a href="/open">attn.sh/open</a></span>
      </div>
    </section>
  </main>

  <footer class="alt-footer">
    <a class="alt-brand" href="#top"><span aria-hidden="true">a.</span>attn</a>
    <p>Markdown review for people and agents.</p>
    <div><a href="/">Current homepage</a><a href="https://github.com/lightsofapollo/attn">GitHub</a></div>
  </footer>
</div>
