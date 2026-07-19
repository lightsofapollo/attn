<script lang="ts">
  type Decision = 'pending' | 'accepted' | 'rejected';

  let decision = $state<Decision>('pending');
  let showComment = $state(true);
  let composerOpen = $state(false);
  let draft = $state('');
  let addedComment = $state('');

  const statusMessage = $derived.by(() => {
    if (decision === 'accepted') return 'Agent suggestion accepted. The working copy is updated.';
    if (decision === 'rejected') return 'Agent suggestion rejected. The original sentence remains.';
    return 'One suggestion is ready for review.';
  });

  function resetSuggestion() {
    decision = 'pending';
  }

  function addComment(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    addedComment = trimmed;
    draft = '';
    composerOpen = false;
  }
</script>

<div class="proof-window" aria-label="Interactive attn review demo">
  <header class="proof-toolbar">
    <div class="proof-file">
      <span class="proof-file-mark" aria-hidden="true">M↓</span>
      <span><strong>direction.md</strong><small>local working copy</small></span>
    </div>
    <div class="proof-presence" aria-label="James, Maya, and Claude are in this review">
      <span class="proof-avatar owner" title="James · owner">JL</span>
      <span class="proof-avatar reviewer" title="Maya · reviewer">MK</span>
      <span class="proof-avatar agent" title="Claude · agent">C</span>
      <span class="proof-live"><i></i> encrypted room</span>
    </div>
  </header>

  <div class="proof-body">
    <article class="proof-document" aria-label="Launch direction document">
      <div class="proof-breadcrumb">PRODUCT / LAUNCH / DIRECTION.MD</div>
      <h2>Launch direction</h2>
      <p class="proof-deck">The browser should begin with a decision, not an empty canvas.</p>

      <h3>The first minute</h3>
      <p>
        A visitor should understand the review loop before they create a workspace. Let the
        document do the explaining.
      </p>

      <div class:resolved={decision !== 'pending'} class="suggested-passage">
        {#if decision === 'accepted'}
          <p class="accepted-copy">
            Open with a working document and one decision ready to make.
          </p>
        {:else if decision === 'rejected'}
          <p>Start with a blank editor and explain the review tools around it.</p>
        {:else}
          <p>
            <del>Start with a blank editor and explain the review tools around it.</del>
            <ins>Open with a working document and one decision ready to make.</ins>
          </p>
        {/if}
      </div>

      <h3>One shared margin</h3>
      <p>
        Human notes and agent suggestions arrive in the
        <button
          class:active={showComment}
          class="comment-anchor"
          type="button"
          aria-expanded={showComment}
          onclick={() => (showComment = !showComment)}
        >same encrypted margin</button>. The owner decides what reaches the source file.
      </p>

      {#if addedComment}
        <p class="added-note"><span>JL</span>{addedComment}</p>
      {/if}

      <button class="add-note" type="button" onclick={() => (composerOpen = !composerOpen)}>
        <span aria-hidden="true">＋</span> Add a note to this review
      </button>

      {#if composerOpen}
        <form class="note-composer" onsubmit={addComment}>
          <label for="demo-note">Note on “One shared margin”</label>
          <textarea
            id="demo-note"
            bind:value={draft}
            rows="3"
            placeholder="What should change?"
          ></textarea>
          <div>
            <button type="button" onclick={() => (composerOpen = false)}>Cancel</button>
            <button class="submit-note" type="submit" disabled={!draft.trim()}>Add note</button>
          </div>
        </form>
      {/if}
    </article>

    <aside class="proof-margin" aria-label="Review thread">
      <div class="margin-heading">
        <span>Review</span>
        <strong>{decision === 'pending' ? '2 open' : '1 open'}</strong>
      </div>

      <section class:resolved={decision !== 'pending'} class="review-slip suggestion-slip">
        <header>
          <span class="proof-avatar agent">C</span>
          <span><strong>Claude</strong><small>agent · just now</small></span>
          <span class="slip-kind">suggestion</span>
        </header>
        {#if decision === 'pending'}
          <p>Lead with a concrete decision. It teaches the product faster than describing the interface.</p>
          <div class="suggestion-actions">
            <button class="accept" type="button" onclick={() => (decision = 'accepted')}>Accept</button>
            <button type="button" onclick={() => (decision = 'rejected')}>Reject</button>
          </div>
        {:else}
          <p class="decision-copy">
            {decision === 'accepted' ? 'Accepted into the working copy.' : 'Rejected; original kept.'}
          </p>
          <button class="undo-decision" type="button" onclick={resetSuggestion}>Undo decision</button>
        {/if}
      </section>

      {#if showComment}
        <section class="review-slip comment-slip">
          <header>
            <span class="proof-avatar reviewer">MK</span>
            <span><strong>Maya</strong><small>reviewer · 2m</small></span>
            <span class="slip-kind">comment</span>
          </header>
          <blockquote>“same encrypted margin”</blockquote>
          <p>Keep this. It says agents participate in the review without pretending they own the file.</p>
          <button type="button" onclick={() => (showComment = false)}>Resolve</button>
        </section>
      {:else}
        <button class="show-resolved" type="button" onclick={() => (showComment = true)}>
          Show resolved comment
        </button>
      {/if}
    </aside>
  </div>

  <footer class="proof-status">
    <span class="status-copy" aria-live="polite">{statusMessage}</span>
    <span>Source file stays clean until you accept.</span>
  </footer>
</div>
