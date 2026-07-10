<!--
  SuggestionComposer — popover composer for authoring inline suggestions
  against a ProseMirror selection (attn-nnj.4.5).

  Layout / behaviour (mirrors the comment composer being built in parallel
  under attn-nnj.4.4 — we intentionally do not import from it so the two
  composers can evolve independently and stay testable in isolation):

    * Popover anchored to the current PM selection via `getPopoverAnchor`.
    * Header shows the selected quote (clipped) so the author knows what
      they're suggesting against.
    * Operation picker is a 4-way radio group:
        - Replace        — selection becomes the replacement text
        - Delete         — selection is removed (no replacement field)
        - Insert Before  — `text` is inserted immediately before the selection
        - Insert After   — `text` is inserted immediately after the selection
      Replace / Delete capture `expected_text` automatically from the
      selection so the resolver can detect drift at accept time. The
      expected_text is shown read-only so the author can verify.
    * Optional note field is always present.
    * Footer: [Cancel] [Submit]. Submit builds Anchor + SuggestionDraft via
      `anchorFromSelection`, then dispatches `reviewCreateSuggestion` over
      IPC and closes. Cancel emits nothing.
    * Esc / outside click → close (no IPC).

  The parent (App.svelte) owns the open-state and provides the
  EditorView + ConstructAnchorContext + RoomId at open-time. We do not
  reach into the review store here — composer is a pure presentational
  popover.

  No emoji, no window.confirm/alert per CLAUDE.md.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorView } from 'prosemirror-view';
  import type { ConstructAnchorContext } from './review/anchors';
  import { shouldSubmitOnEnter } from './review/composer-keys';
  import { getPopoverAnchor } from './review/popover-anchor';
  import { reviewCreateSuggestion } from './ipc';
  import { Button } from './components/ui/button';
  import {
    buildSuggestionDraft as buildDraftFromForm,
    isSubmitEnabled,
    type ComposerFormState,
    type ComposerOperationKind,
  } from './SuggestionComposer.logic';
  import type { RoomId, SuggestionDraft } from './types';

  type OperationKind = ComposerOperationKind;

  interface Props {
    /** PM view that owns the selection. */
    view: EditorView;
    /** Selection range to author the suggestion against. */
    from: number;
    /** End of selection range. */
    to: number;
    /** Snapshot-scoped context for building the layered Anchor. */
    anchorContext: ConstructAnchorContext;
    /** Active review room id (target of the IPC call). */
    roomId: RoomId;
    /** Hosted transport injection. Native callers omit this and use IPC. */
    onCreateSuggestion?: (draft: SuggestionDraft) => Promise<void> | void;
    /** Close handler — fired on submit, cancel, Esc, and outside click. */
    onClose: () => void;
    /**
     * Optional submit observer. Fired after a successful submit with the
     * built draft so test harnesses / parents can assert on it without
     * snooping the IPC bridge.
     */
    onSubmit?: (draft: SuggestionDraft) => void;
  }

  const {
    view,
    from,
    to,
    anchorContext,
    roomId,
    onCreateSuggestion,
    onClose,
    onSubmit,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Selection-derived state (the captured quote stays stable for the lifetime
  // of the popover; mode-switching reuses it for `expected_text`).
  // ---------------------------------------------------------------------------

  /** Selected text as the resolver will see it (block-join, no leaf-sep). */
  const selectedText = $derived(view.state.doc.textBetween(from, to, '\n', ''));

  /** Trimmed preview for the quote header (single line, soft-clip). */
  const quotePreview = $derived(buildQuotePreview(selectedText));

  function buildQuotePreview(raw: string): string {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 140) return collapsed;
    return collapsed.slice(0, 137) + '...';
  }

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------

  let kind = $state<OperationKind>('replace');
  let replacementText = $state('');
  let insertText = $state('');
  let note = $state('');

  /** Whether the current mode shows an expected_text (read-only) row. */
  const showsExpectedText = $derived(kind === 'replace' || kind === 'delete');

  /** Form snapshot pushed to the pure builders. */
  const formSnapshot = $derived<ComposerFormState>({
    kind,
    selectedText,
    replacementText,
    insertText,
    note,
  });

  /** Submit gate — replace requires the replacement; insert modes require text. */
  const submitDisabled = $derived(!isSubmitEnabled(formSnapshot));

  // ---------------------------------------------------------------------------
  // Popover positioning — computed once on mount + window resize. The PM
  // selection is locked at open-time, so we don't need to track view scroll
  // (the parent re-mounts the composer if the user re-selects).
  // ---------------------------------------------------------------------------

  let top = $state(0);
  let left = $state(0);

  function recomputePosition(): void {
    try {
      const anchor = getPopoverAnchor(view, from, to, {
        width: 420,
        height: Math.min(640, Math.max(320, window.innerHeight - 32)),
      });
      top = anchor.recommendedPosition.top;
      left = anchor.recommendedPosition.left;
    } catch {
      // PM throws on out-of-range positions during teardown — leave the
      // popover at its current position rather than crashing the host.
    }
  }

  onMount(() => {
    recomputePosition();
    const onResize = (): void => recomputePosition();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // ---------------------------------------------------------------------------
  // Build + submit
  // ---------------------------------------------------------------------------

  export function buildDraft(): SuggestionDraft {
    return buildDraftFromForm(view, from, to, anchorContext, formSnapshot);
  }

  // In-flight guard: IPC is fire-and-forget today, but the await spans a
  // real daemon round-trip once acks land — without this, a double-tapped
  // Enter or Submit click would send duplicate suggestions.
  let submitting = $state(false);
  let submitError = $state<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (submitting || submitDisabled) return;
    submitting = true;
    submitError = null;
    try {
      const draft = buildDraft();
      if (onCreateSuggestion) await onCreateSuggestion(draft);
      else await reviewCreateSuggestion(roomId, draft);
      onSubmit?.(draft);
      onClose();
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Could not send suggestion';
    } finally {
      submitting = false;
    }
  }

  function handleCancel(): void {
    onClose();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    // Never act on keys belonging to an in-flight IME composition — e.g.
    // Escape dismissing the candidate list must not close the composer.
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // Cmd/Ctrl+Enter submits — same affordance the comment composer uses
    // (and matches the standard popover pattern for "primary action").
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
    }
  }

  // Enter submits, Shift+Enter inserts a newline (attn-2aj). Attached to
  // the AUTHORING textareas only (the readonly expected-text field keeps
  // the dialog-level handler). While submit is disabled (e.g. replace mode
  // with an empty replacement), Enter falls through to a plain newline —
  // matching the disabled Submit button's mental model — instead of being
  // preventDefault'd into a dead key.
  function handleFieldKeydown(e: KeyboardEvent): void {
    if (!shouldSubmitOnEnter(e)) return;
    if (submitDisabled) return;
    e.preventDefault();
    e.stopPropagation();
    void handleSubmit();
  }

  // ---------------------------------------------------------------------------
  // Outside-click dismiss. We attach to document so the popover can dismiss
  // even when focus is inside the textarea.
  // ---------------------------------------------------------------------------

  let rootEl: HTMLDivElement | undefined = $state(undefined);

  onMount(() => {
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as Node | null;
      if (!rootEl || !target) return;
      if (!rootEl.contains(target)) {
        onClose();
      }
    }
    // Defer one tick so the click that opened the composer doesn't immediately
    // close it.
    const handle = setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown);
    }, 0);
    return () => {
      clearTimeout(handle);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  });

  const operationOptions: Array<{ value: OperationKind; label: string; helper: string }> = [
    { value: 'replace', label: 'Replace', helper: 'swap the selection for new text' },
    { value: 'delete', label: 'Delete', helper: 'remove the selection' },
    { value: 'insert_before', label: 'Insert Before', helper: 'insert before the selection' },
    { value: 'insert_after', label: 'Insert After', helper: 'insert after the selection' },
  ];
</script>

<div
  bind:this={rootEl}
  class="suggestion-composer fixed z-50 flex max-h-[calc(100vh-2rem)] w-[420px] flex-col gap-4 overflow-y-auto rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md"
  style="top: {top}px; left: {left}px;"
  role="dialog"
  tabindex="-1"
  aria-label="Suggest edit on selection"
  data-slot="suggestion-composer"
  onkeydown={handleKeyDown}
>
  <header class="flex flex-col gap-1" data-slot="suggestion-composer-header">
    <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      Suggest edit
    </span>
    <blockquote
      class="max-h-[3.5rem] overflow-hidden rounded-sm border-l-2 border-primary/60 bg-muted/40 px-2 py-1 text-xs italic text-foreground"
      data-slot="suggestion-composer-quote"
    >
      {quotePreview || '(empty selection)'}
    </blockquote>
  </header>

  <fieldset class="flex flex-col gap-1.5" data-slot="suggestion-composer-mode-group">
    <legend class="text-xs font-medium text-foreground">Operation</legend>
    <div class="grid grid-cols-2 gap-2">
      {#each operationOptions as opt (opt.value)}
        <label
          class="flex cursor-pointer items-start gap-2 rounded-sm border border-border/60 bg-muted/30 p-2.5 text-xs transition-colors hover:bg-muted/60 has-[:checked]:border-primary/60 has-[:checked]:bg-accent/50"
        >
          <input
            type="radio"
            name="suggestion-operation"
            value={opt.value}
            class="mt-0.5 size-3 shrink-0 accent-primary"
            data-slot="suggestion-operation-radio"
            data-value={opt.value}
            checked={kind === opt.value}
            onchange={() => (kind = opt.value)}
          />
          <div class="flex min-w-0 flex-col">
            <span class="font-medium text-foreground">{opt.label}</span>
            <span class="text-[0.72rem] leading-snug text-muted-foreground">{opt.helper}</span>
          </div>
        </label>
      {/each}
    </div>
  </fieldset>

  {#if showsExpectedText}
    <div class="flex flex-col gap-1" data-slot="suggestion-composer-expected-row">
      <label
        for="suggestion-composer-expected"
        class="text-xs font-medium text-foreground"
      >
        Expected text <span class="text-muted-foreground">(captured from selection)</span>
      </label>
      <textarea
        id="suggestion-composer-expected"
        class="min-h-[2.5rem] max-h-[5rem] resize-none rounded-sm border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground"
        readonly
        value={selectedText}
        data-slot="suggestion-composer-expected"
      ></textarea>
    </div>
  {/if}

  {#if kind === 'replace'}
    <div class="flex flex-col gap-1" data-slot="suggestion-composer-text-row">
      <label
        for="suggestion-composer-text"
        class="text-xs font-medium text-foreground"
      >
        Replacement
      </label>
      <textarea
        id="suggestion-composer-text"
        rows={4}
        class="resize-none rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50"
        placeholder="New text..."
        bind:value={replacementText}
        data-slot="suggestion-composer-text"
        onkeydown={handleFieldKeydown}
      ></textarea>
    </div>
  {:else if kind === 'insert_before' || kind === 'insert_after'}
    <div class="flex flex-col gap-1" data-slot="suggestion-composer-text-row">
      <label
        for="suggestion-composer-text"
        class="text-xs font-medium text-foreground"
      >
        Insert text
      </label>
      <textarea
        id="suggestion-composer-text"
        rows={4}
        class="resize-none rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50"
        placeholder="Text to insert..."
        bind:value={insertText}
        data-slot="suggestion-composer-text"
        onkeydown={handleFieldKeydown}
      ></textarea>
    </div>
  {/if}

  <div class="flex flex-col gap-1" data-slot="suggestion-composer-note-row">
    <label
      for="suggestion-composer-note"
      class="text-xs font-medium text-foreground"
    >
      Note <span class="text-muted-foreground">(optional)</span>
    </label>
    <textarea
      id="suggestion-composer-note"
      rows={4}
      class="resize-none rounded-sm border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50"
      placeholder="Why this change?"
      bind:value={note}
      data-slot="suggestion-composer-note"
      onkeydown={handleFieldKeydown}
    ></textarea>
  </div>

  {#if submitError}
    <p class="text-xs text-destructive" role="alert" data-slot="suggestion-composer-error">
      {submitError}
    </p>
  {/if}

  <footer class="flex justify-end gap-2" data-slot="suggestion-composer-footer">
    <Button
      type="button"
      variant="outline"
      size="sm"
      onclick={handleCancel}
      data-slot="suggestion-composer-cancel"
    >
      Cancel
    </Button>
    <Button
      type="button"
      size="sm"
      onclick={handleSubmit}
      disabled={submitting || submitDisabled}
      data-slot="suggestion-composer-submit"
    >
      Submit
    </Button>
  </footer>
</div>
