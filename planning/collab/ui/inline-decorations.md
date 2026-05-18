# Inline Decorations: ProseMirror Review-Mark System

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.2).
Blocks: attn-nnj.4.6 (`reviewDecorationsPlugin`), 4.7 (ambiguous picker hand-off),
4.8 (stale state hand-off), 4.4 (panel ↔ editor focus sync).

References:

- `planning/collab/amendments.md` Decision #15 — anchor resolver confidence
  cutoffs (LOCKED, restated verbatim below).
- `planning/collab/data-model.md` §Anchor Resolution — the four `ResolvedAnchor`
  variants (`exact` / `remapped` / `ambiguous` / `stale`) and the
  `ResolvedAnchorCandidate` shape.
- `planning/collab/ui/review-panel-design.md` (10.1, sibling). **Recommendation
  adopted in 10.1: flat thread list with file/snapshot chips, filter-driven
  grouping.**
- `web/src/app.css` lines 58-86, 727-783 — the Phase 0c CSS variables and
  utility classes this design consumes (`--comment-highlight`,
  `--suggestion-bg`, `--suggestion-deletion`, `--confidence-{high,med,low}`,
  `--moved-badge-bg`, `--stale-anchor-fg`, plus the matching `.attn-review-*`
  classes). **Do not invent new variables.**
- `web/src/lib/prosemirror/code-highlight.ts` — decoration-plugin pattern
  reference.
- `web/src/lib/review/store.svelte.ts` — `reviewStore.anchorResolutions` is
  the read-side of the decoration source.

---

## 1. Confidence-Cutoff Rules (amendments.md Decision #15, verbatim)

Restated inline so this doc is self-contained. From `amendments.md` §Anchor
resolver disagreement policy → "UI cutoffs":

> - ≥ 0.90 → inline highlight, no "moved" badge
> - 0.70–0.89 → inline highlight + "moved" badge in panel
> - `ambiguous` → panel-only with picker
> - `stale` → panel-only, requires manual re-anchor

These cutoffs are LOCKED. No knob, no override, no per-room variant. Decision
#15 step 6 ("else if any candidate has confidence ≥ 0.35 → `remapped` with
the top one") produces single-candidate `remapped` outputs in the `0.35-0.69`
range; those are panel-only too — same inline treatment as `ambiguous`/`stale`
(no inline mark) but the panel card shows the single candidate without a
picker.

---

## 2. Decoration Vocabulary

Three candidate visual treatments, evaluated against running text and density.

### Candidate (a): Underline + Colored Stroke

A 2px colored underline (offset 2px below baseline) with the body unstyled.
Color encodes kind; thickness encodes confidence.

```text
Single comment, ≥0.90:
The quick brown fox jumps over the lazy dog.
                ~~~~~~~~~

Single suggestion, ≥0.90 (green underline):
The quick brown fox jumps over the lazy dog.
                =========

Comment + suggestion overlap on the same word (stacked underlines):
The quick brown fox jumps over the lazy dog.
                ~~~========

Confidence 0.70-0.89 (thinner, dotted):
The quick brown fox jumps over the lazy dog.
                .........

Five overlapping marks on one paragraph:
The quick brown fox jumps over the lazy dog and runs away.
    ~~~~~====~~~~~~~~~~==========~~~~     ====~~~
```

- **Density at 5 overlapping**: stacks underlines below the baseline; ceiling
  ~3 stacked before they collide into a solid bar.
- **Readability**: best of the three. Letterforms untouched.
- **Mobile/narrow**: works; doesn't reflow line-height.
- **Hover**: needs an overlay hit-region (the 2px line is too small to hit).
  Underline thickens to 3px on `:hover`.

### Candidate (b): Highlight (Full Background Tint)

Low-alpha background fill behind the marked range. Color encodes kind; alpha
encodes confidence. Matches what the Phase 0c CSS vars were designed for.

```text
Single comment, ≥0.90:
The quick brown [fox jumps] over the lazy dog.
                ^^^^^^^^^^^

Single suggestion, ≥0.90:
The quick brown {fox jumps} over the lazy dog.   green-tinted bg

Comment + suggestion overlap (color-mix of layered fills):
The quick brown [fox jumps] over the lazy dog.

Confidence 0.70-0.89 (paler fill):
The quick brown [fox jumps] over the lazy dog.
                ...........

Five overlapping marks on one paragraph:
The quick brown XXXXXXXXXXXXXXXXXXXXXX dog and runs away.
    XXXXX    XXXXXXXXXXXXX
```

- **Density at 5 overlapping**: degrades fast. Stacked alpha-fills saturate
  into a muddy band; ~2 overlaps is the realistic ceiling before kind
  becomes illegible.
- **Readability**: text stays crisp inside the tint at the var-defined
  alphas (18-22%). Tint reads as "marker color," not "selection."
- **Mobile/narrow**: works (already has `box-decoration-break: clone`).
- **Hover**: best of the three. Entire range is the hit-target.

### Candidate (c): Margin Marker (Left Gutter)

Small colored shape (dot, square, hollow ring) in the left margin at the
line containing the mark's start. Body text untouched.

```text
Single comment:                          Confidence 0.70-0.89 (hollow):
●  The quick brown fox jumps over...    ○  The quick brown fox jumps...

Five overlapping marks:
●●  The quick brown fox jumps over the lazy dog
■   and runs away.
●
```

- **Density at 5 overlapping**: markers stack in the gutter — fits — but
  the *where in the line* signal is lost.
- **Readability**: cleanest. Zero impact on running text.
- **Mobile/narrow**: gutter typically collapses on mobile; marks disappear.
- **Hover**: small (~12 px) hit target; click → opens panel entry, but
  editor can't show *which words* without an inline counterpart.

### Discarded combinations

- Highlight + underline on every mark: collides with link underlines.
- Box outline / 1px border: looks like a form input.
- Inline pill/chip next to the marked range: breaks line-wrap.
- Margin-marker only: panel↔editor focus sync (§4) needs an inline target
  to scroll to and pulse.

---

## 3. State-Specific Treatments

Under the recommendation in §6: (b) for ≥0.90, (a) for 0.70-0.89. Comment vs
suggestion encoded by hue (warm vs cool/green) + shape (deletion gets
line-through; insertion gets a caret-bar).

### Comment, `exact` or `remapped` ≥ 0.90

```text
The quick brown [fox jumps] over the lazy dog.   --comment-highlight bg
```

Class `.attn-review-comment` (already defined). No inline badge — the
`comment` chip on the panel card carries the kind label. Hover bumps alpha
by ~10% (CSS, no JS).

### Comment, `remapped` 0.70 – 0.89

```text
The quick brown fox jumps over the lazy dog.
                ~~~~~~~~~                    wavy underline, --confidence-med
```

Class `.attn-review-comment.attn-review-comment--moved` (new modifier;
composes additively with the existing background-bearing class by *replacing*
the background with `transparent` in the modifier and adding
`text-decoration: underline wavy var(--confidence-med); thickness 1.5px;
underline-offset 3px`). Wavy = the browser-native "uncertain" convention
(spell-check); paired with our warm hue, not red, so no spell-check
confusion. Panel card carries the `▲ moved` badge (`.attn-moved-badge`
already defined). Inline does not.

### Suggestion, `exact` or `remapped` ≥ 0.90

```text
Replace:   The quick brown {fox jumps} over the lazy dog.   --suggestion-bg

Delete:    The quick brown ~~fox jumps~~ over the lazy dog.
                           ^^^^^^^^^^^^^   --suggestion-deletion + line-through

Insert:    The quick brown|fox jumps over the lazy dog.
                           ^   2px caret-bar, --suggestion-bg, ~1em tall
```

Class `.attn-review-suggestion`, plus `--deletion` modifier for the
line-through variant (both already in `app.css`). Insertion caret-bar is a
single-point decoration (`Decoration.widget(pos, ...)`), not a range fill.

### Suggestion, `remapped` 0.70 – 0.89

```text
The quick brown fox jumps over the lazy dog.
                =========                    double underline, --suggestion-bg
```

Class `.attn-review-suggestion--moved`. Double underline differentiates from
the wavy comment-moved style at the same width. Panel card carries `▲ moved`.

### `remapped` 0.35 – 0.69 (per Decision #15 step 6)

No inline mark. Panel card only (single candidate, no picker).

### `ambiguous`

```text
The quick brown fox jumps over the lazy dog.    (no inline mark)
```

Per Decision #15: panel-only with picker (per 10.1's `? ambiguous · N
candidates · pick →` card). **Exception**: when the user opens the picker
and hovers a candidate row, the decoration plugin renders a *preview*
highlight at that candidate's `currentRange` using `--confidence-low` (14%
alpha — deliberately subtle to read as "preview, not commitment"). Preview
disappears on picker collapse or selection. This is preview, not state.

### `stale`

No inline mark. Panel-only with `stale · re-anchor ⚠`. Invoking re-anchor
puts the editor into a transient "pick anchor" mode (out of scope here —
attn-nnj.4.8 ships the interaction).

### Resolved

**Recommendation: vanish.** No inline mark, hidden from the panel river
under "show resolved" (matches 10.1). Ghost-marking (a permanent grey
underline at the lost-anchor location) was considered and rejected: marks
accumulate on heavily-reviewed paragraphs into a peppering of grey dashes
that signal nothing actionable. When the user *does* click "show resolved"
and then clicks a resolved card, the editor pulses a one-shot highlight at
the anchor (1.5 s, `--stale-anchor-fg`) — archaeology on demand.

---

## 4. Hover + Interaction

### Hover

- Hovering an inline mark intensifies it (background +10% alpha, or
  underline +1px). CSS-only `:hover`, no JS round-trip.
- After 350 ms sustained hover, a floating popover appears anchored to the
  mark: author + relative-time + 2-line body clamp. Uses the existing
  `web/src/lib/review/popover-anchor.ts` primitive.
- Hovering the mark *also* highlights the corresponding panel card (border
  brightens, no scroll). Two-way: hovering a panel card highlights the
  inline mark. Implemented as a `hoveredEventId` rune on the review store;
  both surfaces read it.

### Click

- Click inline mark → `reviewStore.focusEventId = eventId`. Panel scrolls
  the card into view (smooth, ~200 ms) with a one-shot pulse-ring (1.5 s,
  `--ring`). Editor does not scroll (cursor is already there).
- Click panel card → `reviewStore.focusEventId = eventId`. Editor scrolls
  the anchor into view (`view.dispatch(view.state.tr.scrollIntoView())`
  after setting selection); inline mark pulses for 1.5 s.
- Invariant: one focused event at a time. Setting `focusEventId` clears
  the previous pulse class.

### Keyboard

Per `/Users/jameslal/.claude/CLAUDE.md` no `window.confirm` / `alert`. The
editor and panel each own a cursor and sync via `focusEventId`.

Inline-decoration bindings (editor-focused):

- `Cmd+.` → next inline mark after the editor cursor; sets focus, scrolls
  both surfaces.
- `Cmd+Shift+.` → previous inline mark before the cursor.
- `Cmd+Option+.` → cycle through overlapping marks at the current cursor
  position when more than one is stacked.
- `Esc` while a mark is focused → clear `focusEventId`, return cursor to
  editor; no pulse.

Panel-cursor bindings (per 10.1: `j`/`k`, `Enter`, `Esc`, `a`/`r`, `Cmd+J`
toggle) are unchanged. Focus cycling *between* editor and panel: see open
question 3.

Screen-reader path: each inline decoration renders as `<mark>` with
`role="mark"`, `aria-label="Comment by Alex, posted 3 minutes ago"`, and
`aria-describedby` pointing to the panel-card id. Sighted-keyboard users
get the focus-ring on the `<mark>`; SR users hear the label on traversal.

---

## 5. Decoration Plugin Architecture

Reference: `web/src/lib/prosemirror/code-highlight.ts` wraps
`createHighlightPlugin` — same shape (Plugin + `DecorationSet` state field
rebuilt per transaction), but we build our own `DecorationSet` because the
source-of-truth lives in `reviewStore`, not in the doc.

```ts
// web/src/lib/prosemirror/review-decorations.ts
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { reviewStore } from "../review/store.svelte";

export const reviewDecorationsKey = new PluginKey("review-decorations");

export const reviewDecorationsPlugin = () =>
  new Plugin({
    key: reviewDecorationsKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, oldSet, _oldState, newState) => {
        // 1. Map existing decorations through the tr's steps so they
        //    survive doc edits without a full rebuild.
        let next = oldSet.map(tr.mapping, tr.doc);
        // 2. If reviewStore.{anchorResolutions,events} changed, drop and
        //    rebuild. Detection via a meta flag set by the $effect below.
        const meta = tr.getMeta(reviewDecorationsKey);
        if (meta?.rebuild) next = buildDecorations(newState.doc);
        return next;
      },
    },
    props: {
      decorations: (state) => reviewDecorationsKey.getState(state),
    },
  });
```

### Rebuild trigger

`reviewStore` is a Svelte 5 rune store. The component that mounts the
editor sets up an `$effect` watching `reviewStore.anchorResolutions` and
`reviewStore.events`; when either changes it dispatches an empty
transaction with `meta: {rebuild: true}` on the plugin's key:

```ts
$effect(() => {
  void reviewStore.anchorResolutions;
  void reviewStore.events;
  view.dispatch(view.state.tr.setMeta(reviewDecorationsKey, { rebuild: true }));
});
```

Keeps the plugin pure: no rune subscription inside `apply` (that would
couple PM internals to Svelte reactivity). The plugin only ever reads
`reviewStore` synchronously inside `buildDecorations`.

### Position mapping (resolution-time vs render-time)

`ResolvedAnchor.currentRange` is a `PositionAnchor` (`byteRange`,
`lineRange`, optional `pmRange`). The Rust resolver omits `pmRange`; the
browser fallback (Phase 2) includes it. `buildDecorations` resolves in
this order:

1. If `pmRange` is present and `tr.doc`'s `baseHash` matches the
   resolution's, use `pmRange` directly.
2. Else map `byteRange` to a PM range via the byte-offset index produced
   by the comrak round-trip (same index the anchor engine uses), cached
   and invalidated on every doc-changing transaction.
3. If the doc has advanced since the resolution was computed, map the
   result through `tr.mapping` — same primitive PM uses for cursor
   mapping. This is the "decoration positions are doc-version-relative,
   resolution is byte-range-relative" mapping called out in the brief.
4. If mapping yields an invalid range (collapsed, out-of-bounds), drop
   the decoration silently. The next resolution round from the daemon
   produces a fresh `ResolvedAnchor` with a valid range.

Identical lifecycle to PM's selection mapping: map forward, drop if
invalid.

### Overlap handling

1. Each mark is `Decoration.inline(from, to, attrs, {spec: {eventId}})` —
   PM stacks attrs on adjacent text nodes correctly when ranges overlap.
2. Sort by `(from, -length, eventId)` so re-builds produce a deterministic
   render order (prevents z-order flicker when two marks share a range).
3. Classes are additive. Comment + suggestion on the same range composes
   via CSS color-mix at the existing alphas — both tints visible.
4. **Cap at 3 stacked inline marks per range.** Beyond that, render only
   the 3 most recent inline + emit a single widget decoration `+N more`
   chip at the range end (uses `.attn-moved-badge` styling but with a
   different label). The hidden marks remain fully visible in the panel.
   See open question 4 on the threshold.

### Lifecycle

Init: empty `DecorationSet`. First `$effect` tick after the store
populates dispatches a rebuild.

Per transaction: map then optionally rebuild. Mapping O(decoration
count); rebuild O(resolution count). Both small (~40 findings/file ceiling
for a realistic agentic review).

Teardown: standard PM plugin teardown when the editor unmounts; the
`$effect` is cleaned up automatically by Svelte.

---

## 6. Recommendation

**Adopt the split treatment:**

- **Highlight (background fill) for high-confidence** (`exact` and
  `remapped` ≥ 0.90). Uses `--comment-highlight` / `--suggestion-bg`. The
  mark occupies its target range — strongest affordance.
- **Wavy/double underline for medium-confidence** (`remapped` 0.70 – 0.89).
  Wavy for comment, double for suggestion. Different *shape* signals the
  moved/uncertain state at a glance; same hue keeps the kind legible.
- **Panel-only for everything below 0.70 plus `ambiguous` / `stale`.** Per
  Decision #15 verbatim; no inline noise.
- **Resolved threads vanish inline.** One-shot pulse via "show resolved"
  + click for on-demand archaeology.

### Justification

1. **Coheres with 10.1's flat-with-chips panel.** 10.1 puts the `▲ moved`
   badge on the panel card; we put a *different shape* (not a different
   badge) on the inline mark. The surfaces share a hue per kind but use
   independent visual channels for the moved/exact split, so they
   cross-reference without echoing. 10.1's note that "#15's four states
   map naturally to inline badges, not tabs" lands cleanly: this design
   renders those states in parallel across both surfaces, each in the
   channel that fits.

2. **Density.** A paragraph with 4 high-confidence comments composes 4
   tints via `color-mix` at the var-defined alphas; the same paragraph
   with 4 medium-confidence comments stacks 4 underlines below the
   baseline (line-height comfortably fits 3 stacked; a 4th triggers the
   `+N more` overflow chip in §5). Mixed comment + suggestion is the most
   legible case because the OKLCH hues are far apart (warm 85° vs cool
   150° per `app.css`).

3. **Confusable-with-syntax-highlight risk.** Shiki's code-block marks are
   *foreground* color changes on token spans — they never touch the
   background. Our highlight treatment is *background* fills only and
   inherits the foreground. No collision. Inline `code` spans inside
   prose: same rule — our tint composes with the inline-code background;
   the stack reads as "marked code." Wavy underline shares the
   spell-check convention, but spell-check is *red*; ours is warm/steel
   per `--confidence-med`. Context (a review session) disambiguates.

4. **Accessibility.** Color is never the sole channel. Comment vs
   suggestion differs in hue *and* shape (deletion adds line-through;
   insertion renders as a caret-bar). Confidence differs in saturation
   *and* shape (fill vs underline). Phase 0c vars use OKLCH ratios that
   meet WCAG AA contrast for foreground text over the tinted background
   in both themes. For deuteranopia, the warm-vs-cool split holds as
   distinct neutrals; for protanopia, suggestion green dims toward
   comment warm and the underline-shape distinction carries the signal.
   `aria-label` on the `<mark>` element (§4) gives full SR context.

### Why not pure highlight everywhere

Degrades fast at density (see §2 candidate b cons). The split keeps
high-confidence comments visually loud (look at them) and medium-
confidence ones quiet (verify in the panel). Shape difference between
exact and remapped is a *signal*, not decoration.

### Why not margin marker

Loses the *where in the line* signal. For a 40-finding agentic review
across 5 markdown files, per-line density is low enough that the gutter
*has* room — but the answer-on-hover ("which words?") is much worse than
an inline mark. Keep the gutter dead.

---

## 7. Open Questions for the User

1. **Insertion-point caret-bar height.** Match line-height (full vertical
   span, heavy) or x-height (top of lowercase letters, subtle)?
   Recommendation: x-height + 2px overhang top/bottom, total ~1em. Pick
   before 4.6 lands.

2. **Mobile / narrow-window inline-mark behavior.** Below ~480 px the
   editor is cramped; tints at 22% alpha may read as "selected text"
   instead of "marked text." Option A: hide inline marks below 480 px,
   panel-only. Option B: bump alpha to ~32% so they read as decoration.
   Recommendation: A; the panel river is the better mobile UX anyway.

3. **Focus key between editor and panel.** Cmd+J toggles the panel
   open/closed (already wired). When both are open, how does focus cycle?
   Options: (a) OS-native Cmd+`` `, (b) a new attn binding (e.g.
   Cmd+Shift+J), (c) Tab when editor cursor is at end of line.
   Recommendation: (b), but flag — no precedent in attn yet for
   between-pane navigation.

4. **Overlap ceiling threshold.** §5 caps stacked inline marks at 3 with
   a `+N more` overflow widget. Is 3 the right number? Two is the limit
   for highlight legibility before color-mix collapses; three is the
   underline ceiling. The cap should be per-treatment (2 for
   high-confidence stacking, 3 for medium-confidence underlines).
   Confirm before 4.6 lands.
