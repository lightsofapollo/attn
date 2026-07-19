<script lang="ts">
  let loaded = $state(false);
</script>

<div class="proof-window real-demo-frame" data-loaded={loaded ? 'true' : 'false'}>
  {#if !loaded}
    <div class="demo-loading" role="status">
      <span aria-hidden="true"></span>
      Opening the live review…
    </div>
  {/if}
  <iframe
    src="/app?surface=landing-review-demo"
    title="Interactive attn Markdown review: select text and add a comment"
    loading="lazy"
    allow="clipboard-write"
    onload={() => (loaded = true)}
  ></iframe>
</div>
