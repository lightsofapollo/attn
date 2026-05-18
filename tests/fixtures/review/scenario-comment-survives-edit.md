# Comment Survives Edit Scenario

A small markdown canvas used by the review E2E suite. The accompanying
`scenario-comment-survives-edit.json` mock-IPC script will drive comments,
suggestions, and owner edits against this content to verify that anchors
re-resolve correctly after edits land.

## Background

The owner of this document will receive a comment anchored to a paragraph
below. After the comment lands, the owner edits the surrounding text. The
review pipeline must re-anchor the comment without losing it.

## Anchor Target

The paragraph immediately following this heading is the primary anchor
target for the scripted comment. Its text should remain stable enough that
the fuzzy re-anchor pass succeeds even after the owner inserts new lines.

## Code Example

```rust
fn greet(name: &str) -> String {
    format!("hello, {name}")
}
```

## Checklist

- [x] Comment lands on the anchor paragraph
- [ ] Owner inserts a new paragraph above
- [ ] Comment re-anchors without manual intervention
- [ ] Suggestion arrives and renders in the right rail
