<script lang="ts">
  import { getTheme } from '../theme.svelte';
  import ResponsiveScreenshot from './ResponsiveScreenshot.svelte';
  import shareLight from './assets/share-light-fallback.webp';
  import shareDark from './assets/share-dark-fallback.webp';
  import shareLight768 from './assets/share-light-768.avif';
  import shareLight1280 from './assets/share-light-1280.avif';
  import shareLight1920 from './assets/share-light-1920.avif';
  import shareDark768 from './assets/share-dark-768.avif';
  import shareDark1280 from './assets/share-dark-1280.avif';
  import shareDark1920 from './assets/share-dark-1920.avif';

  const shareShots = {
    light: {
      fallback: shareLight,
      avifSrcset: `${shareLight768} 768w, ${shareLight1280} 1280w, ${shareLight1920} 1920w`,
    },
    dark: {
      fallback: shareDark,
      avifSrcset: `${shareDark768} 768w, ${shareDark1280} 1280w, ${shareDark1920} 1920w`,
    },
  } as const;

  const shareShot = $derived(shareShots[getTheme()]);
</script>

<section class="chapter" id="how">
  <div class="chapter-head">
    <div><span class="chapter-index">01 / THE MODEL</span></div>
    <div>
      <h2>A document first. A review only when you share.</h2>
      <p class="chapter-intro">
        Everything starts as a private document on your device. Sharing does not turn it into a
        cloud file — it publishes an encrypted copy of that version for others to review.
      </p>
    </div>
  </div>
  <div class="steps">
    <article class="step">
      <span class="step-num">01</span>
      <h3>Create locally</h3>
      <p>
        Stored on this device. One click creates a workspace with untitled.md; add more Markdown,
        images, or project assets as it grows.
      </p>
    </article>
    <article class="step">
      <span class="step-num">02</span>
      <h3>Share deliberately</h3>
      <p>
        A review exists only after Share. The link you send carries the decryption key in its
        <code>#</code> fragment — the part browsers never send to a server — so attn stores
        ciphertext and cannot read a word of it.
      </p>
    </article>
    <article class="step">
      <span class="step-num">03</span>
      <h3>Work anywhere</h3>
      <p>
        Browser or native, the same comments, suggestions, and live edits — sent directly between
        you when your networks allow, and held encrypted until the other side reconnects when they
        don’t.
      </p>
    </article>
  </div>

  <!--
    Show the guarantee instead of asserting it a fourth time (attn-n01r.16).
    The page stated "no server can read the words" in four places and
    demonstrated it nowhere, which is exactly the claim a local-first tool's
    audience checks first — and they found nothing to check.

    Every line below is taken from the project's own documented threat model in
    planning/collab/relay-spec.md §Threat Model ("The server is honest-but-
    curious. It may: … The server must not: …"), not written for marketing. If
    that spec changes, this changes with it.
  -->
  <div class="relay-ledger">
    <h3 id="relay-ledger-heading">What the relay can see</h3>
    <p class="relay-ledger-intro">
      attn's server is <strong>honest-but-curious</strong>: it routes ciphertext and never holds a
      key. This is the whole of what it observes.
    </p>
    <div class="relay-ledger-cols">
      <div class="relay-col" data-tone="sees">
        <h4>It sees</h4>
        <ul>
          <li>Room, peer, device and envelope ids</li>
          <li>Envelope sizes, counts and timing</li>
          <li>Your IP address</li>
          <li>That a connection was negotiated — never the negotiation's contents</li>
        </ul>
      </div>
      <div class="relay-col" data-tone="blind">
        <h4>It cannot see</h4>
        <ul>
          <li>The document, at any version</li>
          <li>Comment and suggestion text</li>
          <li>File and folder names</li>
          <li>Who you are, beyond an id you generate</li>
          <li>The room key — it lives after the <code>#</code> in your invite link, and browsers
            never send that part to a server</li>
        </ul>
      </div>
    </div>
    <p class="relay-ledger-note">
      Identities are derived on your machine from the room secret; the relay issues none. The
      threat model is written down in
      <a href="https://github.com/lightsofapollo/attn/blob/main/planning/collab/relay-spec.md">
        relay-spec.md</a>, and the review that tested it against the implementation is in
      <a href="https://github.com/lightsofapollo/attn/blob/main/planning/collab/security-review.md">
        security-review.md</a>.
    </p>
  </div>

  <div class="share-proof">
    <div class="capture">
      <ResponsiveScreenshot
        fallback={shareShot.fallback}
        avifSrcset={shareShot.avifSrcset}
        sizes="(max-width: 680px) calc(100vw - 2rem), (max-width: 1180px) 60vw, 710px"
        alt="The attn Share for review dialog"
      />
    </div>
    <div class="proof-copy">
      <p class="eyebrow">The moment local becomes shared</p>
      <blockquote>“A review exists only after you press Share.”</blockquote>
      <p>
        The secret lives in the link’s fragment, so it never reaches attn’s servers. Anyone you
        share with can review from the browser or native attn.
      </p>
    </div>
  </div>
</section>
