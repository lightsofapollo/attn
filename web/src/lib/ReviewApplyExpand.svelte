<!--
  Inline-expand three-way apply card. Surfaces `ApplyVerdict::RequiresThreeWay`
  (Rust: `src/review/apply.rs:174`) to the owner when a suggestion's
  `expected_text` has drifted from what's currently on disk.

  Per `planning/collab/ui/three-way-apply.md` §5 the chosen layout is
  Candidate (b) — "inline-expand card":

    - The card grows out of its 320 px margin slot to ~880 px, overlaying
      the editor. Sibling margin cards dim to 30 %. Not a modal (no
      `role="dialog"`, no focus trap).
    - Three columns: Snapshot | Current (mine) | Proposed.
    - Diff coloring uses ONLY existing CSS vars from `web/src/app.css`:
        `--suggestion-deletion` (red strike), `--suggestion-bg` (green add),
        `--comment-highlight` (owner edits delta vs snapshot).
    - Keybindings: `a` accept theirs, `k` keep mine, `e` edit, `Esc` cancel.
    - Click-outside cancels (no IPC sent).

  State: subscribes to `reviewStore.activeThreeWayApply`. When that becomes
  non-null the card mounts. Cancel/keep clear it immediately; apply awaits the
  selected native or hosted authority and only clears after durable success,
  leaving failures visible and retryable.

  Tests: `web/src/lib/ReviewApplyExpand.test.ts` (tsx harness, mirrors
  `resolver.test.ts` conventions — no vitest yet).
-->

<script lang="ts">
  import { reviewAcceptSuggestion } from './ipc';
  import { reviewStore } from './review/store.svelte';
  import {
    selectReviewedApplyCallback,
    type ReviewedApplyCallback,
  } from './review/reviewed-apply-port';
  import { diffLines, diffWordsInLine } from './review/text-diff';
  import type {
    LineDiffSegment,
    WordDiffSegment,
  } from './review/text-diff';
  import type { RequiresThreeWayVerdict } from './types';

  interface Props {
    /** Hosted reviewed-apply authority. Omit to preserve native IPC. */
    onApplySuggestion?: ReviewedApplyCallback;
  }

  let { onApplySuggestion }: Props = $props();

  const nativeApplySuggestion: ReviewedApplyCallback = (pending, replacement) =>
    replacement === pending.proposedReplacement
      ? reviewAcceptSuggestion(pending.roomId, pending.suggestionId)
      : reviewAcceptSuggestion(pending.roomId, pending.suggestionId, replacement);

  const applySuggestion: ReviewedApplyCallback = $derived(
    selectReviewedApplyCallback(onApplySuggestion, nativeApplySuggestion),
  );

  // ---------------------------------------------------------------------------
  // Reactive verdict
  // ---------------------------------------------------------------------------

  // The store rune is the source of truth. We mirror it into a `$derived` to
  // narrow the type for the markup below: the component only renders when
  // `verdict !== null`, so once we're inside `{#if verdict}` TypeScript treats
  // it as `RequiresThreeWayVerdict`.
  const verdict: RequiresThreeWayVerdict | null = $derived(
    reviewStore.activeThreeWayApply,
  );

  // ---------------------------------------------------------------------------
  // Edit-mode state
  // ---------------------------------------------------------------------------

  let editing = $state(false);
  let editBuffer = $state('');
  let applying = $state(false);
  let applyError = $state('');

  // Reset edit-mode whenever the verdict changes (e.g. a new three-way opens
  // while one was already in `editing`).
  $effect(() => {
    if (!verdict) {
      editing = false;
      editBuffer = '';
      applying = false;
      applyError = '';
      return;
    }
    // When a fresh verdict arrives, prefill the buffer with the proposed text.
    // Subsequent re-renders of the same verdict don't clobber user edits
    // because we key off `verdict.suggestionId`.
    editBuffer = verdict.proposedReplacement;
    applyError = '';
  });

  // ---------------------------------------------------------------------------
  // Diffs
  // ---------------------------------------------------------------------------

  // Owner edits vs snapshot (rendered inside the Current pane).
  const currentVsSnapshot: LineDiffSegment[] = $derived(
    verdict ? diffLines(verdict.snapshotExpected, verdict.currentText) : [],
  );

  // Reviewer edits vs snapshot (rendered inside the Proposed pane).
  const proposedVsSnapshot: LineDiffSegment[] = $derived(
    verdict
      ? diffLines(verdict.snapshotExpected, verdict.proposedReplacement)
      : [],
  );

  // Word-level diff used in the footer "Δ vs snapshot" row (left half).
  const currentVsSnapshotWords: WordDiffSegment[] = $derived(
    verdict
      ? diffWordsInLine(verdict.snapshotExpected, verdict.currentText)
      : [],
  );
  const proposedVsSnapshotWords: WordDiffSegment[] = $derived(
    verdict
      ? diffWordsInLine(verdict.snapshotExpected, verdict.proposedReplacement)
      : [],
  );

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function acceptTheirs(): void {
    if (!verdict || applying) return;
    void applyReplacement(verdict.proposedReplacement);
  }

  function keepMine(): void {
    if (applying) return;
    // No IPC — the suggestion stays in `RequiresThreeWay` state on the Rust
    // side until the owner explicitly rejects it via the margin card's
    // reject path. Per 10.4 §3 candidate (b) "leave suggestion in
    // RequiresThreeWay state for the user to come back to". This handler
    // simply closes the expand.
    reviewStore.clearThreeWayApply();
  }

  function enterEdit(): void {
    if (!verdict) return;
    editing = true;
    editBuffer = verdict.proposedReplacement;
  }

  function confirmEdit(): void {
    if (!verdict || applying) return;
    void applyReplacement(editBuffer);
  }

  async function applyReplacement(replacement: string): Promise<void> {
    const pendingVerdict = verdict;
    if (!pendingVerdict || applying) return;
    applying = true;
    applyError = '';
    try {
      await applySuggestion(pendingVerdict, replacement);
      if (
        reviewStore.activeThreeWayApply?.suggestionId
        === pendingVerdict.suggestionId
      ) {
        reviewStore.clearThreeWayApply();
      }
    } catch (error) {
      applyError = error instanceof Error ? error.message : 'Could not apply this suggestion';
    } finally {
      applying = false;
    }
  }

  function cancelEdit(): void {
    if (applying) return;
    editing = false;
    if (verdict) editBuffer = verdict.proposedReplacement;
  }

  function cancel(): void {
    if (applying) return;
    reviewStore.clearThreeWayApply();
  }

  // ---------------------------------------------------------------------------
  // Click-outside cancellation
  // ---------------------------------------------------------------------------

  let rootEl: HTMLDivElement | undefined = $state();

  function handleBackdropClick(e: MouseEvent): void {
    // The backdrop is a sibling pseudo-element; this click handler lives on
    // the wrapper `<div>` that hosts both the backdrop and the expand card.
    // Any click whose target lies outside `rootEl` (the card itself) cancels.
    if (!rootEl) return;
    if (e.target instanceof Node && !rootEl.contains(e.target)) {
      cancel();
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard handler (scoped to the card; relies on root focus + onkeydown)
  // ---------------------------------------------------------------------------

  function handleKeydown(e: KeyboardEvent): void {
    if (e.repeat || e.defaultPrevented || e.isComposing) return;
    if (!verdict) return;
    if (applying) {
      e.preventDefault();
      return;
    }
    // In edit mode, the textarea owns most key events; only intercept
    // `Esc` (cancel edit) and `Cmd/Ctrl+Enter` (confirm edit).
    if (editing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey)
        && (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')
      ) {
        e.preventDefault();
        confirmEdit();
        return;
      }
      return;
    }
    // View-mode shortcuts.
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      acceptTheirs();
      return;
    }
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      keepMine();
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      enterEdit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Header metadata helpers
  // ---------------------------------------------------------------------------

  function formatAge(ms: number | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const delta = Math.max(0, Date.now() - ms);
    const s = Math.floor(delta / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function formatConfidence(c: number): string {
    return `${Math.round(c * 100)}%`;
  }
</script>

{#if verdict}
  <div
    class="three-way-backdrop"
    data-testid="three-way-apply-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="three-way-expand"
      data-testid="three-way-apply-expand"
      data-suggestion-id={verdict.suggestionId}
      bind:this={rootEl}
      onkeydown={handleKeydown}
      role="group"
      aria-label="Three-way apply: snapshot, current, and proposed text"
      aria-busy={applying}
      tabindex="0"
    >
      <!-- Header: reviewer, age, confidence, drift summary -->
      <header class="three-way-header">
        <div class="three-way-header-meta">
          <span class="three-way-reviewer">
            {verdict.reviewerDisplayName ?? 'reviewer'}
          </span>
          {#if verdict.createdAt !== undefined}
            <span class="three-way-age">· {formatAge(verdict.createdAt)}</span>
          {/if}
          <span class="three-way-drift">· drifted</span>
          <span
            class="three-way-confidence"
            data-confidence-band={verdict.confidence >= 0.9
              ? 'high'
              : verdict.confidence >= 0.7
                ? 'med'
                : 'low'}
          >
            · confidence {formatConfidence(verdict.confidence)}
          </span>
        </div>
        <button
          type="button"
          class="three-way-close"
          aria-label="Cancel three-way apply"
          onclick={cancel}
          disabled={applying}
        >
          ×
        </button>
      </header>

      <!-- Three diff columns -->
      <div class="three-way-columns">
        <!-- Snapshot (read-only baseline) -->
        <section class="three-way-pane three-way-pane-snapshot">
          <h3 class="three-way-pane-title">Snapshot</h3>
          <p class="three-way-pane-sub">what reviewer saw</p>
          <pre class="three-way-pane-body"><code
              >{verdict.snapshotExpected}</code></pre>
        </section>

        <!-- Current (owner edits highlighted against snapshot) -->
        <section class="three-way-pane three-way-pane-current">
          <h3 class="three-way-pane-title">Current (mine)</h3>
          <p class="three-way-pane-sub">what's on disk now</p>
          <pre class="three-way-pane-body"><code>{#each currentVsSnapshot as seg, i (i)}{#if seg.kind === 'add'}<span class="three-way-add three-way-owner-edit">{seg.text}</span>{:else if seg.kind === 'del'}<span class="three-way-del">{seg.text}</span>{:else}<span class="three-way-same">{seg.text}</span>{/if}{/each}</code></pre>
        </section>

        <!-- Proposed (reviewer edits highlighted; editable on [e]) -->
        <section class="three-way-pane three-way-pane-proposed">
          <h3 class="three-way-pane-title">Proposed</h3>
          <p class="three-way-pane-sub">replacement</p>
          {#if editing}
            <textarea
              class="three-way-edit-textarea"
              data-testid="three-way-edit-textarea"
              bind:value={editBuffer}
              aria-label="Edit proposed replacement"
              spellcheck="false"
              disabled={applying}
            ></textarea>
            <div class="three-way-edit-actions">
              <button
                type="button"
                class="three-way-btn three-way-btn-primary"
                onclick={confirmEdit}
                disabled={applying}
              >
                {applying ? 'Applying…' : 'Confirm edit'}
              </button>
              <button
                type="button"
                class="three-way-btn"
                onclick={cancelEdit}
                disabled={applying}
              >
                Cancel edit
              </button>
            </div>
          {:else}
            <pre class="three-way-pane-body"><code>{#each proposedVsSnapshot as seg, i (i)}{#if seg.kind === 'add'}<span class="three-way-add">{seg.text}</span>{:else if seg.kind === 'del'}<span class="three-way-del">{seg.text}</span>{:else}<span class="three-way-same">{seg.text}</span>{/if}{/each}</code></pre>
          {/if}
        </section>
      </div>

      <!-- Footer Δ row: side-by-side word-diff summary -->
      <div class="three-way-delta-row" data-testid="three-way-delta-row">
        <div class="three-way-delta">
          <span class="three-way-delta-label">Δ owner vs snapshot:</span>
          {#each currentVsSnapshotWords as seg, i (i)}
            {#if seg.kind === 'add'}<span
                class="three-way-add three-way-owner-edit"
                >{seg.text}</span
              >{:else if seg.kind === 'del'}<span class="three-way-del"
                >{seg.text}</span
              >{:else}<span class="three-way-same">{seg.text}</span>{/if}
          {/each}
        </div>
        <div class="three-way-delta">
          <span class="three-way-delta-label">Δ reviewer vs snapshot:</span>
          {#each proposedVsSnapshotWords as seg, i (i)}
            {#if seg.kind === 'add'}<span class="three-way-add"
                >{seg.text}</span
              >{:else if seg.kind === 'del'}<span class="three-way-del"
                >{seg.text}</span
              >{:else}<span class="three-way-same">{seg.text}</span>{/if}
          {/each}
        </div>
      </div>

      <!-- Action row -->
      {#if !editing}
        <footer
          class="three-way-actions"
          data-testid="three-way-apply-actions"
        >
          <button
            type="button"
            class="three-way-btn three-way-btn-primary"
            data-action="accept"
            onclick={acceptTheirs}
            aria-keyshortcuts="a"
            disabled={applying}
          >
            <kbd class="three-way-kbd">a</kbd> {applying ? 'applying…' : 'accept theirs'}
          </button>
          <button
            type="button"
            class="three-way-btn"
            data-action="keep"
            onclick={keepMine}
            aria-keyshortcuts="k"
            disabled={applying}
          >
            <kbd class="three-way-kbd">k</kbd> keep mine
          </button>
          <button
            type="button"
            class="three-way-btn"
            data-action="edit"
            onclick={enterEdit}
            aria-keyshortcuts="e"
            disabled={applying}
          >
            <kbd class="three-way-kbd">e</kbd> edit
          </button>
          <button
            type="button"
            class="three-way-btn three-way-btn-ghost"
            data-action="cancel"
            onclick={cancel}
            aria-keyshortcuts="Escape"
            disabled={applying}
          >
            <kbd class="three-way-kbd">Esc</kbd> cancel
          </button>
        </footer>
      {/if}
      {#if applyError}
        <p class="three-way-apply-error" role="alert">{applyError}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Backdrop: dims the editor 8 % per 10.4 §2. `pointer-events: auto` so the
     click-outside handler fires; the card itself stops propagation by virtue
     of mounting inside this same wrapper but not extending behind it. */
  .three-way-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.08);
    z-index: 20;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8vh;
    cursor: default;
  }

  /* The expand card — grows from 320 px (margin) to ~880 px (per 10.4 §2). */
  .three-way-expand {
    width: min(880px, calc(100vw - 32px));
    max-height: min(60vh, 600px);
    background: var(--popover);
    color: var(--popover-foreground, inherit);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }

  .three-way-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .three-way-header-meta {
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
  }

  .three-way-reviewer {
    font-weight: 600;
  }

  .three-way-age,
  .three-way-drift,
  .three-way-confidence {
    color: var(--muted-foreground);
  }

  .three-way-confidence[data-confidence-band='med'] {
    background: var(--confidence-med);
    padding: 0 4px;
    border-radius: 2px;
  }

  .three-way-confidence[data-confidence-band='low'] {
    background: var(--confidence-low);
    padding: 0 4px;
    border-radius: 2px;
  }

  .three-way-close {
    background: transparent;
    border: 0;
    font-size: 1.15rem; /* control-lg */
    line-height: 1;
    cursor: pointer;
    color: var(--muted-foreground);
    padding: 2px 6px;
    border-radius: 6px;
  }

  .three-way-close:hover {
    background: var(--muted);
  }

  .three-way-close:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .three-way-columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1px;
    background: var(--border);
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .three-way-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--popover);
    padding: 10px 12px;
    overflow: hidden;
  }

  .three-way-pane-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 2px;
    color: var(--muted-foreground);
  }

  .three-way-pane-sub {
    font-size: 0.7rem;
    color: var(--muted-foreground);
    margin: 0 0 8px;
  }

  .three-way-pane-body {
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    font-family: var(
      --font-mono,
      ui-monospace,
      'Source Code Pro Variable',
      'Source Code Pro',
      monospace
    );
    font-size: 0.85rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .three-way-pane-body code {
    font-family: inherit;
    font-size: inherit;
    background: transparent;
  }

  /* Diff coloring — uses ONLY CSS vars defined in web/src/app.css per 10.4 §6. */
  .three-way-add {
    background: var(--suggestion-bg);
  }

  .three-way-del {
    background: var(--suggestion-deletion);
    text-decoration: line-through;
    color: inherit;
  }

  .three-way-owner-edit {
    /* Owner-side additions also get the warm tint so they read as "your
       change" against the cool/green reviewer-additions on the proposed side. */
    background: var(--comment-highlight);
  }

  /* `.three-way-same` left unstyled intentionally — inherits the body
     color/background. Documented here so future updates know the selector
     is reserved for that role. */

  .three-way-edit-textarea {
    flex: 1 1 auto;
    min-height: 120px;
    width: 100%;
    box-sizing: border-box;
    font-family: var(
      --font-mono,
      ui-monospace,
      'Source Code Pro Variable',
      'Source Code Pro',
      monospace
    );
    font-size: 0.85rem;
    line-height: 1.45;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    /* No manual resize handle (attn-2aj). This pane edits multi-line
       replacement text, so plain Enter stays a newline here — submit is
       Cmd/Ctrl+Enter or the Confirm button. */
    resize: none;
    background: var(--background);
    color: inherit;
  }

  .three-way-edit-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .three-way-delta-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    background: var(--muted);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.7rem;
    line-height: 1.4;
    max-height: 5lh;
    overflow: auto;
  }

  .three-way-delta-label {
    font-weight: 600;
    margin-right: 6px;
    color: var(--muted-foreground);
  }

  .three-way-actions {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    position: sticky;
    bottom: 0;
    background: var(--popover);
  }

  .three-way-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--border);
    color: inherit;
    padding: 6px 10px;
    font-size: 0.85rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .three-way-btn:hover {
    background: var(--muted);
  }

  .three-way-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .three-way-apply-error {
    margin: 0;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    color: var(--color-danger, var(--destructive));
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .three-way-btn-primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: var(--primary);
  }

  .three-way-btn-primary:hover {
    filter: brightness(0.95);
    background: var(--primary);
  }

  .three-way-btn-ghost {
    border-color: transparent;
  }

  .three-way-kbd {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.7rem;
    background: var(--muted);
    color: var(--muted-foreground, inherit);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0 4px;
    line-height: 1.4;
  }

  /* Narrow breakpoint per 10.4 §6: below 480 px the expand fills the whole
     SidebarInset width. Still not a modal — same component, different sizing. */
  @media (max-width: 480px) {
    .three-way-expand {
      width: calc(100vw - 16px);
    }
    .three-way-columns {
      grid-template-columns: 1fr;
    }
    .three-way-delta-row {
      grid-template-columns: 1fr;
    }
  }
</style>
