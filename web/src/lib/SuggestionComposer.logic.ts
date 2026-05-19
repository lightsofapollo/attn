// Pure helpers for `SuggestionComposer.svelte` (attn-nnj.4.5).
//
// The Svelte component owns the popover chrome, runes, and bind:value
// plumbing. The construction of `SuggestionOperation` / `SuggestionDraft`
// from a form snapshot lives here so the tsx-runnable test harness in
// `SuggestionComposer.test.ts` can exercise it without mounting a runes
// component (web/ has no test runner that can compile .svelte files yet).
//
// Keep this file framework-free: pure functions, no DOM, no Svelte runes.

import type { EditorView } from 'prosemirror-view';
import { anchorFromSelection, type ConstructAnchorContext } from './review/anchors';
import type { SuggestionDraft, SuggestionOperation } from './types';

/** The four-way mode picker the composer exposes to the user. */
export type ComposerOperationKind = SuggestionOperation['kind'];

/**
 * Snapshot of the composer's form fields. The Svelte component holds
 * each field as a separate `$state` rune; this struct collects them so the
 * pure builders below can be unit-tested without runes.
 */
export interface ComposerFormState {
  /** Selected operation mode. Drives which fields the helpers consume. */
  kind: ComposerOperationKind;
  /**
   * The selection text captured at open-time. Used as `expected_text` for
   * Replace / Delete so the resolver can detect drift at accept time.
   * Stored on the form (rather than re-derived from the view) so the
   * Replace/Delete payloads stay deterministic even if the editor's
   * selection moves out from under the popover.
   */
  selectedText: string;
  /** Replacement text — used only when `kind === 'replace'`. */
  replacementText: string;
  /**
   * Insert text — used when `kind === 'insert_before' | 'insert_after'`.
   * The composer's UI swaps between this and `replacementText` based on
   * mode, but the form struct keeps them separate so mode-switching is
   * non-destructive (user can flip between Replace and Insert without
   * losing what they typed).
   */
  insertText: string;
  /** Optional note. Empty / whitespace-only is dropped from the draft. */
  note: string;
}

/**
 * Build a `SuggestionOperation` payload from a form snapshot. The shape
 * mirrors `crate::review::model::SuggestionOperation` (camelCase serde).
 */
export function buildSuggestionOperation(form: ComposerFormState): SuggestionOperation {
  switch (form.kind) {
    case 'replace':
      return {
        kind: 'replace',
        expectedText: form.selectedText,
        replacement: form.replacementText,
      };
    case 'delete':
      return {
        kind: 'delete',
        expectedText: form.selectedText,
      };
    case 'insert_before':
      return {
        kind: 'insert_before',
        text: form.insertText,
      };
    case 'insert_after':
      return {
        kind: 'insert_after',
        text: form.insertText,
      };
  }
}

/**
 * Build the full `SuggestionDraft` (Anchor + Operation + optional note).
 * Whitespace-only notes are dropped so the wire payload stays clean.
 */
export function buildSuggestionDraft(
  view: EditorView,
  from: number,
  to: number,
  ctx: ConstructAnchorContext,
  form: ComposerFormState,
): SuggestionDraft {
  const anchor = anchorFromSelection(view, from, to, ctx);
  const draft: SuggestionDraft = {
    anchor,
    operation: buildSuggestionOperation(form),
  };
  const trimmedNote = form.note.trim();
  if (trimmedNote.length > 0) {
    draft.note = trimmedNote;
  }
  return draft;
}

/**
 * Submit-button gate: whether the current form is valid for emission.
 * Mirrors the disabled-state logic in the component so tests can assert on
 * the same predicate.
 */
export function isSubmitEnabled(form: ComposerFormState): boolean {
  switch (form.kind) {
    case 'replace':
      return form.replacementText.length > 0;
    case 'delete':
      return true;
    case 'insert_before':
    case 'insert_after':
      return form.insertText.length > 0;
  }
}
