<script lang="ts">
  // Markup-only component; script block keeps svelte-check module typing.
</script>

<!--
  Three card labels, not three sections (attn-n01r.19). These used to be <h2>,
  so a screen reader's outline reported six top-level sections before the first
  real section heading, three of which were buttons. They are the names of
  links; <strong> carries the emphasis without claiming document structure.

  Each link is also named by its label alone via aria-labelledby, so the link
  list stays scannable — the computed names were ~100 characters of body copy
  ("One click · no naming step New workspace Creates untitled.md locally and
  opens the editor. START HERE"). The <p> is still read in document order.
-->
<section class="entry-strip" aria-label="Ways to begin">
  <a
    class="entry primary-entry"
    href="/app#new"
    data-action="new-workspace"
    aria-labelledby="entry-new-label"
  >
    <span class="entry-head">
      <small>One click · no naming step</small>
      <!-- In flow, not ::after (attn-n01r.19/.24): as generated content it was
           skipped by machine translation and in-page search, landed last in a
           100-character accessible name, and — being absolutely positioned —
           reserved no space, so it sat on top of the eyebrow between 681 and
           730px. -->
      <span class="entry-flag">Start here</span>
    </span>
    <strong class="entry-title" id="entry-new-label">New workspace</strong>
    <p>Creates untitled.md locally and opens the editor.</p>
  </a>
  <a class="entry" href="/open" aria-labelledby="entry-import-label">
    <span class="entry-head"><small>Files, folders, or zip</small></span>
    <strong class="entry-title" id="entry-import-label">Import workspace</strong>
    <p>Markdown plus referenced images and project assets.</p>
  </a>
  <a class="entry" href="/app#join" aria-labelledby="entry-join-label">
    <span class="entry-head"><small>Have a link?</small></span>
    <strong class="entry-title" id="entry-join-label">Join a review</strong>
    <p>Open the same encrypted multi-file room as native attn.</p>
  </a>
</section>
