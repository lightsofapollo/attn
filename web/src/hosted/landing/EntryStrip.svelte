<script lang="ts">
  // Markup-only component; script block keeps svelte-check module typing.
</script>

<!--
  Three card labels, not three sections (attn-n01r.19). As <h2> they put six
  top-level sections in a screen reader's outline before the first real section
  heading, three of them buttons. They are the names of links; <strong> carries
  the emphasis without claiming document structure.

  Each link is also named by its label alone via aria-labelledby, so the link
  list stays scannable — the computed names were ~100 characters of body copy
  ("One click · no naming step New workspace Creates untitled.md locally and
  opens the editor. START HERE"). The <p> is still read in document order.
-->
<section class="secondary-start" aria-labelledby="secondary-start-heading">
  <!--
    The hero owns the "begin" decision (attn-n01r.14). Offering /app#new here
    as well repeats it three times before the first section break — nav, hero,
    strip — rendering one decision in two vocabularies 500px apart. This strip
    carries the OTHER two routes, so each affordance points somewhere different.
  -->
  <p class="secondary-start-label" id="secondary-start-heading">Other ways to begin</p>
  <div class="entry-strip">
    <a class="entry" href="/open" aria-labelledby="entry-import-label">
      <span class="entry-head"><small>Files, folders, or zip</small></span>
      <strong class="entry-title" id="entry-import-label">Import workspace</strong>
      <p>Markdown plus referenced images and project assets.</p>
    </a>
    <a class="entry" href="/app#join" aria-labelledby="entry-join-label">
      <span class="entry-head"><small>Have a link?</small></span>
      <strong class="entry-title" id="entry-join-label">Join a review</strong>
      <!-- Was "Open the same encrypted review as native attn, across every file
           in it." — the sentence does not parse, and it is the paragraph a
           first-time reviewer is most likely to read before clicking a link
           somebody sent them (attn-08fa.8). -->
      <p>Open the encrypted review right in your browser — every file in it, nothing to install.</p>
    </a>
  </div>
</section>
