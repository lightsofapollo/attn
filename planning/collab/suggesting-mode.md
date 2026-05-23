# Inline Suggesting Mode (track changes)

Status: building (epic attn-07i.2). Replaces direct reviewer co-typing with
Google-Docs-style inline suggestions.

## Problem

Today a reviewer's edits are applied straight into the owner's live document
(owner is the OT authority) and the owner auto-saves on every change — so a
reviewer's keystrokes rewrite the owner's on-disk file (and re-serialize the
markdown, mangling it). Reviewers should only **suggest**; the owner accepts or
rejects each change. The owner's file must only ever contain **accepted**
content.

## Library

[`@handlewithcare/prosemirror-suggest-changes`](https://github.com/handlewithcarecollective/prosemirror-suggest-changes)
(MIT). Marks-based: `insertion` / `deletion` / `modification` marks, each
carrying an `id` attr. Key facts that make it fit:

- **Composes with `prosemirror-collab`.** `withSuggestChanges` only transforms a
  local user transaction into a suggestion when suggesting is enabled AND the tr
  is not `collab$`/`history$`/yjs-origin. Remote collab-applied steps pass
  through untouched, so a reviewer's already-suggested marks sync to the owner
  as ordinary content — no new transport.
- Commands: `enable/disable/toggleSuggestChanges`, `applySuggestion(id)` /
  `revertSuggestion(id)` (+ range/all variants), `selectSuggestion(id)`,
  `applySuggestionsToNode(node)` (pure, returns accepted doc).
- `generateId?: (schema, doc) => string|number` — custom id generator.

## Design decisions

1. **Reviewer = suggesting on, owner = off.** Add `suggestChanges()` to the
   editor plugins; wrap `dispatchTransaction` with `withSuggestChanges`. On the
   reviewer, `enableSuggestChanges`; the owner edits directly and accepts/rejects.
2. **Attribution via the id.** The marks only carry `id`, so we encode the
   author: `generateId = () => `${participantId}~${rand}``. Parsing the prefix
   gives "suggested by <name>" via `reviewStore.displayNameFor`. Avoids forking
   the marks and is collision-safe across peers (fixes the lib's default
   auto-increment ids).
3. **Two serializations.**
   - **File (owner's working copy):** CLEAN — accepted content only. Save first
     reverts all *pending* suggestions on a throwaway doc, then serializes. The
     on-disk markdown never contains suggestion marks.
   - **Snapshot (the shared doc reviewers load):** MARKED — round-trips
     `insertion`/`deletion` as inline HTML `<ins data-id>`/`<del data-id>` so
     pending suggestions survive owner restart and are visible to a reviewer who
     joins later. Snapshot ≠ file: snapshot carries marks, file is clean.
4. **Accept/reject is owner-only** and routes through the lib commands, which
   produce ordinary steps that sync over collab. Accepting also lands in the
   durable working-copy/apply path so the file updates.

## Phases

1. **Foundation** — schema marks; `suggestChanges()` plugin; `withSuggestChanges`
   dispatch + author-encoded `generateId`; reviewer suggesting-on; mark CSS;
   safe (non-crashing) serialization. Reviewer edits become inline marks.
2. **Owner UX** — attributed inline rendering + accept/deny/comment per
   suggestion (reuse the comment thread for "comment"); `applySuggestion` /
   `revertSuggestion` wired to UI.
3. **Persistence + file integrity** — snapshot serializes marks (HTML
   ins/del), file save reverts-pending → clean; suggestions survive reconnect.

## Open risks

- Markdown round-trip of block-level suggestions (`<ins style="display:block">`)
  through markdown-it; inline is straightforward, block needs care.
- `applySuggestion`/`revertSuggestion` producing steps under a live OT authority
  — confirm map/rebase correctness with concurrent edits.
