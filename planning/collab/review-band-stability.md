# Review band open/close: killing the width reshuffle

Status: option A approved by James and shipped (2026-07-20, attn-wac5) —
the aside keeps a permanent 48px gutter and Review mode renders as an
elevated overlay panel (`.review-rail-panel`, styles/base.css) on both
the owner frame and the /s/ page. Originally: options for discussion.
Follow-up to
`comment-layout-alternatives.md` — the Reading/Review mode shipped, but
James's verdict on the remaining seam: *"when open it reshuffles the
layout width and again when closed which makes it look awkward."*

## The problem, measured (staging, 1300px window)

Toggling Reading → Review takes the owner's document column from 965px
to 693px — a 272px squeeze that re-wraps every paragraph — and gives it
back on close. Two full-document reflows per glance at a comment. The
document is left-anchored with the band on the right, so there is no
free slack to absorb the band: the width has to come from somewhere,
and today it comes out of the text.

The earlier stability ruling ("the document must never shift") was about
*unchosen* shifts — a comment arriving, a share starting. The mode
toggle is chosen, but the punishment for choosing it is still a full
re-wrap, which is why it reads as awkward rather than intentional.

## Options

### A. Overlay expansion (recommended)

The 48px marker gutter stays permanently reserved (unchanged). Review
mode renders the card column as an **elevated layer** anchored to the
right edge, sliding over the paper — the document underneath keeps its
exact width and wrap in every state. Structurally this generalizes the
grammar we already have: clicking a marker pops ONE card over the paper;
Review mode is simply *all* cards, in the same elevated plane.

- Document geometry becomes state-independent: zero reflow, ever.
- Costs: the column occludes the right portion of wide content (tables,
  mermaid) while open. Acceptable because the mode is chosen, obviously
  elevated (shadow), and one keypress (Esc/⌘J) from gone — same deal as
  every inspector panel in Figma/Linear.
- Motion: slide-in with ease-out, crossfade under reduced motion.

### B. Slack-first hybrid

Same as A, but when the viewport is wide enough that free space exists
to the right of the document, the band expands into that slack first and
only overlays what slack can't cover. Strictly better occlusion behavior;
slightly more layout logic. With the doc left-anchored and the measured
slack ≈ the gutter width, A and B behave identically at today's widths —
B only pays off on very wide monitors.

### C. Permanent reservation (no width mode at all)

The document column is always sized as if Review were open; Reading mode
just shows markers in the reserved space. Zero reflow and zero occlusion,
but it permanently returns the ~270px the marker-gutter redesign
reclaimed for the document. This is the pre-redesign geometry with
extra steps — listed for completeness.

## Recommendation

**A**, with B as a progressive enhancement if very-wide-monitor
occlusion ever annoys. It keeps every ruling intact — document
left-anchored, gutter permanently reserved, markers at anchor height —
and makes document geometry a pure function of the viewport, never of
review state. Composer, focus-follow, toasts, and the mobile sheet are
unaffected (the sheet already overlays).
