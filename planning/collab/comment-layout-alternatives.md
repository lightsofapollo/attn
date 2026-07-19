# Comment layout alternatives

Status: exploration for discussion (2026-07-18)

The current review surfaces reserve a right-hand band (320px, compressing
to 240px) for anchored comment cards. James's observation: with zero or
one thread, that band is a sea of empty paper that the markdown —
mermaid, tables, code — could be using. This doc weighs alternatives from
a usability standpoint.

## What the band actually buys

Any alternative must answer for all three:

1. **Layout stability.** The ruling from this week's iteration: the
   document must never shift when a comment appears, the rail toggles, or
   a share starts. Permanent reservation is the mechanism — the band is
   paid for whether or not it's used, precisely so nothing ever moves.
2. **Ambient awareness.** Cards are readable with zero interaction, and
   vertical position carries meaning: the card sits beside the text it
   annotates. This is the Docs quality we deliberately copied.
3. **Spatial compose.** Select text → the composer opens at the anchor,
   in the space where your eyes already are.

## Alternatives

### A. Slim marker gutter, cards on demand (Linear/iA grammar)

The permanent band shrinks to a ~48px gutter showing avatar dots at
anchor height (we already built exactly this as the owner's "collapsed"
mode). Clicking a marker or highlighted text opens that ONE card as a
popover beside the gutter; ⌘J / the 💬 button still opens the full band
for deep-review sessions.

- Keeps: stability (gutter always reserved), position-meaning (markers at
  anchor y), compose-in-place (popover).
- Costs: reading a comment takes one click; skimming a threaded
  discussion means opening cards one at a time.
- Reclaims: ~270px for the document in the default state.

### B. Reading/Review as an explicit layout mode (Word markup toggle)

Two named states the user flips (💬 / ⌘J, remembered per document):
**Reading** = full-width document + marker gutter only; **Review** =
today's full band. The toggle is user-initiated, so the reflow it causes
is chosen, not inflicted — consistent with the stability ruling, which
was always about the DOCUMENT moving on its own.

- Keeps: everything, in the mode where you want it.
- Costs: a mode. Someone confused about "where are my comments" is one
  badge-glance away from the answer.

### C. Overlay cards over the paper (Docs-at-narrow-widths)

No reserved band; cards float over the document's right edge.

- Keeps: full-width text, adjacency.
- Costs: occlusion — worst exactly when the document is wide (tables,
  mermaid), which is the case that motivated the question. Weak on touch.
  **Rejected.**

### D. Inline threads between paragraphs (GitHub PR)

Comments expand in the document flow at their anchor.

- Keeps: full width, deep context, great for suggestions/diffs.
- Costs: expanding shifts the document vertically — the same instability
  we spent the week killing, now on the other axis. Unusable at high
  comment density. **Rejected as the primary surface** (worth keeping in
  mind for a future suggestion-diff view).

### E. Thread list drawer (Notion/Figma)

No margin at all; a toggleable right drawer lists threads sorted by
position; clicking one scrolls to its anchor.

- Keeps: full width by default, good filtering/overview at high density.
- Costs: loses adjacency entirely — comments become a place you GO
  rather than a thing you SEE. This was the original complaint that
  started the Docs-margin work ("I had to refresh to see someone's
  comment / not clear where their comment went"). **Rejected.**

## Recommendation: A as the default, B as the frame

Make the marker gutter the default state and promote the existing 💬
toggle to a real Reading/Review mode switch:

- Default (Reading): document takes the width; a 48px gutter shows
  avatar markers at anchor height; unread badge on 💬; clicking a marker
  or highlight pops that card open in place. First remote comment adds a
  marker — nothing shifts.
- Review mode (💬/⌘J): today's full band, cards always visible — for
  working through a review end-to-end. Composing a comment auto-enters
  Review mode (you just asked to see cards); leaving is one keypress.
- Per-document memory of the mode; a share opened from a review
  notification could open in Review mode.

This keeps every property the band paid for — stability (gutter is
permanent), position-meaning (markers), compose-in-place — while giving
the document back ~270px in the state James is in most of the time.
Native app should adopt the same grammar (it has the hug-rail; the
marker-gutter default ports cleanly).

## Open questions

- Marker glyph at density: N avatars stack vs. count chip when several
  threads share a screenful?
- Does composing from Reading mode open just the composer card (popover)
  or the full band? (Popover keeps the mode; band is more oriented.)
- Should resolved threads show markers in Reading mode at all, or only
  under a filter?
