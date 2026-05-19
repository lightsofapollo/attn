# Three-Way Apply UI for Drifted Suggestions

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.4).
Blocks: attn-nnj.8.3 (`ReviewApplyExpand.svelte`, the Phase 2 implementation).

References:

- `src/review/apply.rs` — `ApplyVerdict::RequiresThreeWay` produced by 8.1+8.2.
  Carries `snapshot_expected`, `current_text`, `proposed_replacement`,
  `target_byte_range`, `confidence`, `suggestion_id`. This doc is its UI.
- `planning/collab/ui/review-panel-design.md` (10.1) — margin sticky cards
  model. Cards are 280-320 px wide; the design lives inside the right-rail
  overlay. §1.2 *already* names this state ("Suggestion + stale source —
  three-way opens an inline editor overlay; no modal per project rule"). This
  doc fleshes out what "inline editor overlay" means.
- `planning/collab/ui/inline-decorations.md` (10.2) — CSS-var vocabulary
  (`--suggestion-bg`, `--suggestion-deletion`, `--confidence-{med,low}`,
  `--comment-highlight`). **Do not invent new vars** — the diff colors below
  consume existing ones.
- `planning/collab/data-model.md` §Suggestion Events + §Apply Flow
  (lines 600-650). Step 3: "If text differs, show a three-way apply UI."
  Step 4: "Owner confirms." This doc owns step 3+4.
- `planning/collab/amendments.md` Decisions #1 (agentic primary), #15
  (resolver confidence cutoffs). Three-way is the escape hatch when an
  otherwise-applicable suggestion has been overtaken by owner edits.
- Project rule (`CLAUDE.md`): no `window.confirm` / `alert` / `<dialog>`
  modals. Use in-app UI.
- `web/src/lib/ipc.ts:119` — `review_accept_suggestion` IPC already wired
  by 12.5. This UI is its trigger surface, nothing more.

---

## 1. Problem

When the owner clicks `[accept]` on a suggestion card, the Rust apply
resolver (`src/review/apply.rs`) returns one of four verdicts. Three of them
are no-friction or out-of-scope here:

- `Ready` → write file, emit `SuggestionAccepted`, card collapses to ✓ strip.
- `Ambiguous` → routed to the orphan-tray candidate picker (10.1 §2).
- `Stale` → "re-anchor manually" path (8.6).

The fourth, **`RequiresThreeWay`**, fires when the anchor resolved cleanly
(exact or remapped ≥ 0.70 confidence) BUT the `expected_text` the reviewer
captured at suggestion-authoring time no longer matches the bytes currently
at the target range. The owner has edited the paragraph since the reviewer
looked at it. Silent apply would overwrite that edit; silent skip would
lose the reviewer's intent.

The owner needs to see, side by side:

- **(a) Snapshot** — what the text was when the reviewer wrote the suggestion
  (`snapshot_expected`).
- **(b) Current** — what the text is right now in the owner's working copy
  (`current_text`).
- **(c) Proposed** — what the suggestion would write if applied
  (`proposed_replacement`).

…and pick one of: **keep mine** (reject the suggestion, current text wins),
**accept theirs** (overwrite current with proposed), or **edit** (open the
proposed in an inline editor, hand-merge, then write).

Drift volume matters: a `target_byte_range` is usually a paragraph (~5
lines, 80-120 chars/line) but can be a multi-paragraph block (`Replace`
operating on a `block` anchor) — up to ~200 lines in the worst realistic
case (a reviewer suggesting a whole subsection rewrite, while the owner
made parallel edits in the middle). The UI must stay legible at that size.

This is **not merge-conflict resolution**. There is no second branch, no
`HEAD`, no `>>>>>>>` markers. There is a single owner working copy and a
single proposed replacement, with the snapshot as the *common ancestor* of
both. The owner picks one or hand-merges. No third-party tool, no shell
escape, no separate window.

---

## 2. Constraint: 320 px Margin Cards Can't Show a Three-Way Diff

10.1 fixed margin cards at **280-320 px** (clamp; below 280 px the margin
collapses to the orphan tray). A serious three-way diff needs at minimum
~60-80 monospace cols per pane to keep one line of markdown un-wrapped:

```text
60 cols × ~7.5 px/col × 3 panes  ≈  1350 px content
   + 3 × 16 px pane padding       ≈    48 px
   + 2 × 1 px borders + gutters   ≈    16 px
                                  ≈  1414 px total
```

That is **5× wider than a margin card** and won't fit even on a 1440 px
laptop once the sidebar + editor are present. Three options exist:

- **(a) Modal dialog** — biggest canvas, but **forbidden by project rule**
  ("do not use window.confirm, alert, etc. use proper in app ui"). We do
  not put consequential per-paragraph decisions behind focus-capturing
  dismissable surfaces in attn. Rejected at the constraint level.

- **(b) Inline-expand card** — the card grows from its 320 px margin slot
  to fill the editor + margin width (~800-1100 px depending on viewport).
  The margin slot stays attached at the right; the card pushes left over
  the editor, overlaying the paragraphs it is about. Other margin cards
  dim; the editor underneath dims (8% black tint, no pointer events).
  Visually it reads as "this card got big," not "a dialog opened."

- **(c) Editor-side overlay** — the diff renders as a horizontally-spanning
  band *above the affected paragraph in the editor*, pushing the rest of
  the document down. Looks like a git merge-conflict block but rendered.
  The margin column is untouched; other cards stay visible.

Both (b) and (c) keep the user inside the document's spatial model. (a) is
out. The three candidates explored below are (b), (c), and a split-pane
variant that splits the editor area itself.

---

## 3. Three Candidate Layouts

### Candidate (b): Inline-expand card

The card that owns the three-way verdict grows out of its margin slot to
cover the editor. The margin slot stays anchored to the right edge so the
spatial connection to the paragraph is preserved.

```text
Idle (margin card, before owner clicks [accept]):
│ ┌── editor ───────────────────────────────────────┐┌── margin ─────┐  │
│ │                                                 ││               │  │
│ │ The anchor resolver runs 8 steps.               ││ ┌───────────┐ │  │
│ │ ~~~~~~~~~~~~~~~~~~                              ││ │ rufus  6m │ │  │
│ │                                                 ││ │ suggest ▲ │ │  │
│ │                                                 ││ │ stale src⚠│ │  │
│ │                                                 ││ │[open 3-way]│ │
│ │                                                 ││ └───────────┘ │  │
│ └─────────────────────────────────────────────────┘└───────────────┘  │

After click — card expands leftward over editor (editor dims 8% behind):
│ ┌── editor (dimmed, no pointer events) ─────────┐┌── margin ─────┐  │
│ │··············································││ ┌───────────┐ │  │
│ │·┌── ReviewApplyExpand ─────────────────────────────────────┐·││ │ alex 3m   │ │  │ ← other
│ │·│ rufus · 6m  ·  drift on "anchor resolver" paragraph     │·││ │ "Do we…?" │ │  │   cards
│ │·│ confidence 0.92  ·  expected_text mismatch              │·││ │           │ │  │   stay
│ │·│ ───────────────────────────────────────────────────────  │·││ │           │ │  │   in
│ │·│ Snapshot              Current (mine)      Proposed       │·││ │           │ │  │   place
│ │·│ ─────────────         ─────────────        ─────────────  │·││ │           │ │  │   (dim
│ │·│ runs 8 steps.         runs 8 steps,        runs 10 steps │·││ │           │ │  │    60%)
│ │·│                       carefully, in        (+math,        │·││ │           │ │  │
│ │·│                       order.               +mermaid).     │·││ │           │ │  │
│ │·│                                                            │·││ │           │ │  │
│ │·│ ─────────────────────────────────────────────────────────  │·││ │           │ │  │
│ │·│ Δ vs snapshot:   +carefully, in order.    +math, +mermaid  │·││ │           │ │  │
│ │·│                                                            │·││ │           │ │  │
│ │·│ [k] keep mine   [a] accept theirs   [e] edit   [Esc] back │·││ │           │ │  │
│ │·└──────────────────────────────────────────────────────────┘·││ └───────────┘ │  │
│ │··············································││               │  │
│ └─────────────────────────────────────────────────┘└───────────────┘  │
                          ↑ expanded width ≈ editor width + margin gutter
                            (e.g. 880 px on a 1280-wide window)
                          ↑ height grows with content; max 60vh, scrolls internally
```

- **Input affordances**: keybindings `a` / `k` / `e` / `Esc` shown in the
  action row; equivalent buttons clickable. `Tab` cycles `[keep] [accept]
  [edit] [cancel]`; `Enter` activates the focused button. No mouse
  required.
- **Diff coloring**: deletions = `--suggestion-deletion` background +
  line-through (already defined in 10.2); additions = `--suggestion-bg`
  background. The "Δ vs snapshot" footer row computes the line-diff between
  *current* and *snapshot* (showing what the owner did) on the left, and
  between *proposed* and *snapshot* (showing what the reviewer did) on the
  right. Both deltas render in the same red/green vocabulary 10.2 already
  uses for inline suggestion marks — colors **come from existing CSS
  vars**; no new tokens.
- **Other margin cards while open**: dim to 30% opacity, lose hover,
  retain their positions. `j`/`k` editor cycling is disabled while expand
  is active. `Cmd+J` (panel toggle) becomes "close expand and toggle
  panel" — a single keystroke gets you out.

### Candidate (c): Editor-side overlay (rendered conflict block)

When the three-way fires, a horizontally-spanning band replaces (visually,
not in document storage) the affected paragraph inline. The rest of the
document below it shifts down by the band's height; the margin column is
untouched.

```text
│ ┌── editor ────────────────────────────────────────┐┌── margin ───┐│
│ │ # Phase 0c                                       ││             ││
│ │                                                  ││             ││
│ │ ╔══════════════════════════════════════════════╗ ││ ┌─────────┐ ││ ← margin card
│ │ ║ ↯ Three-way apply · rufus · 6m              ║ ││ │rufus 6m │ ││   stays, but
│ │ ║ ──────────────────────────────────────────── ║ ││ │three-way│ ││   "expanded
│ │ ║ Snapshot:    The anchor resolver runs 8     ║ ││ │  open ▾ │ ││    open" badge
│ │ ║              steps.                          ║ ││ └─────────┘ ││   replaces
│ │ ║ Current:     The anchor resolver runs 8     ║ ││             ││   actions
│ │ ║              steps, carefully, in order.    ║ ││ ┌─────────┐ ││
│ │ ║ Proposed:    The anchor resolver runs 10    ║ ││ │alex 3m  │ ││ ← unaffected
│ │ ║              steps (+math, +mermaid).       ║ ││ │"Do we…?"│ ││
│ │ ║ ──────────────────────────────────────────── ║ ││ └─────────┘ ││
│ │ ║ [k] keep mine  [a] accept  [e] edit  [Esc]  ║ ││             ││
│ │ ╚══════════════════════════════════════════════╝ ││             ││
│ │                                                  ││             ││
│ │ Each step emits a candidate.                     ││             ││
│ │                                                  ││             ││
│ └──────────────────────────────────────────────────┘└─────────────┘│
                                                       ↑ usable width
                                                         ≈ 700-900 px
                                                         (editor only)
```

- **Input affordances**: same keybindings as (b). The band scrolls into
  view automatically on open and pulses once.
- **Diff coloring**: same vocabulary as (b); however because the panes
  here are stacked vertically (Snapshot / Current / Proposed as three
  rows), the per-line additions/deletions render inline within each row
  (red strike for deletions, green underline-bar for additions). This
  trades horizontal pane comparison for vertical line-by-line legibility.
  For long diffs (>20 lines) each row scrolls internally with synchronized
  vertical scroll across the three rows.
- **Other margin cards while open**: untouched. The associated margin
  card grows a small "▾ open" disclosure badge in place of its action
  row and stays at 100% opacity. Sibling cards do not dim.

### Candidate (d): Split-pane temporarily showing snapshot | current | proposed

The editor *itself* splits into three vertical columns for the lifetime
of the three-way decision. Each column shows the full document; the
disputed paragraph is highlighted in each. The owner reads them
side-by-side and picks.

```text
│ ┌── ScrollArea (split into 3 columns) ───────────────────┐┌─margin─┐│
│ │ Snapshot @14:02     │ Current (mine)    │ Proposed     ││        ││
│ │ ─────────────────   │ ─────────────     │ ───────────  ││ (other ││
│ │ # Phase 0c          │ # Phase 0c        │ # Phase 0c   ││  cards ││
│ │                     │                   │              ││  dim)  ││
│ │ The anchor resolver │ The anchor reso-  │ The anchor   ││        ││
│ │ runs 8 steps.       │ lver runs 8 step- │ resolver     ││        ││
│ │ ════════════════    │ s, carefully, in  │ runs 10      ││        ││
│ │                     │ order.            │ steps (+math,││        ││
│ │                     │ ════════════════  │ +mermaid).   ││        ││
│ │                     │                   │ ═══════════  ││        ││
│ │ Each step emits…    │ Each step emits…  │ Each step…   ││        ││
│ └────────────────────────────────────────────────────────┘└────────┘│
│ [k] keep mine    [a] accept theirs    [e] edit    [Esc] back        │
                  ↑ each column ≈ 250-300 px; cramped on narrow
```

- **Input affordances**: same keybindings, footer-anchored.
- **Diff coloring**: each pane shows the disputed paragraph highlighted
  with its content; inter-pane diff is implicit (the eye does the
  scan). No inline strikethrough — the surrounding context is the
  point.
- **Other margin cards while open**: dim to 30% opacity. The split-pane
  consumes the editor; cards remain on the right but their anchors are
  ambiguous (which of the three columns?).

---

## 4. Per-Candidate Analysis

### Coherence with margin model

- **(b)** — Best. The card *is* the expand surface. There is exactly one
  visual home for the suggestion at all times; growing/shrinking the same
  element preserves identity. The user's mental model ("this card got
  big") matches the implementation.
- **(c)** — Good. The margin card stays put; the editor sprouts a band.
  Slight cost: two surfaces for one suggestion (margin badge + editor
  band) during the decision. Manageable.
- **(d)** — Worst. The split severs the margin↔anchor correspondence —
  cards in the margin can no longer point at "the" paragraph because the
  paragraph exists thrice. The user has to reason about which column
  cards refer to.

### No-modals rule

- **(b)** — Passes. The card never disconnects from the document; it is
  not focus-capturing in the WAI-ARIA sense (no `role="dialog"`, no
  `aria-modal`); `Esc` cancels and returns focus to the card's collapsed
  state.
- **(c)** — Passes most cleanly. The band is a render in the document
  flow; pressing `Esc` closes it without any backdrop or restore-focus
  dance.
- **(d)** — Passes but feels modal-adjacent. The whole editor area is
  taken over; everything outside the split is unreachable. Technically
  not a modal, perceptually close.

### Keyboard-only flow

- **(b)** — Same 4-key vocabulary as the margin card it grew from. `j`/`k`
  cycling is suspended; `Tab` cycles within the expanded card. Predictable.
- **(c)** — Same 4 keys, but `j`/`k` cycling continues to work *around*
  the band (the band itself is a focusable region; `j`/`k` from outside
  it skips over). Slightly more state.
- **(d)** — The 4 keys still work, but the user loses spatial sense:
  pressing `j` while in split-pane is ambiguous (move down in which
  column? Or close the split?). Footnote: needs a fifth key (`Tab` to
  cycle columns) which doubles the cognitive load.

### Long-diff legibility (the 200-line stress test)

- **(b)** — Three side-by-side panes at ~280-330 px each accommodate a
  60-70 char wrap; markdown averaging 80 chars/line wraps once per line,
  so a 200-line diff renders as ~400 wrapped lines in the visible pane.
  Max-height clamp to 60vh + internal scroll within the panes (vertically
  synced) keeps the card from becoming a wall. Acceptable.
- **(c)** — Stacked-row layout lets each row use the full ~800 px editor
  width, so 200 lines render at natural width with no extra wrapping. But
  reading three stacked 200-line panes vertically requires constant
  scrolling between them; sync-scroll across rows partly fixes it.
  Acceptable but tedious.
- **(d)** — Each pane is ~280 px, the same as (b)'s panes, but the
  surrounding document context means the user has to find the disputed
  paragraph in each column (highlighted, but still a visual scan). Worst
  for long diffs.

---

## 5. Recommendation

**Adopt Candidate (b): inline-expand card.** Best on three of four
criteria, only loses to (c) on long-diff legibility — and (b)'s 60vh
max-height + synced internal scroll covers the worst-case 200-line
diff acceptably.

### Justification

1. **No-modals rule** — (b) passes cleanly without any of the dialog
   semantics that make modals modals. It is a card that grew. `Esc`
   collapses it. No backdrop ARIA, no focus trap, no shadow-DOM
   contortion.

2. **Margin model coherence** — (b) is the unique candidate that
   preserves the single-surface invariant from 10.1: every suggestion
   has exactly one card; the card is always the interaction surface
   for that suggestion. (c) splits the surface into card + band; (d)
   abandons spatial anchoring altogether.

3. **Keyboard-only flow** — `a` / `k` / `e` / `Esc` form a 4-key
   vocabulary the user already learned for the collapsed card's
   accept/reject/edit/dismiss; (b) reuses it 1:1 in the expanded
   state. Zero new bindings.

4. **Implementation simplicity** — (b) is a CSS width-and-z-index
   transition on the existing margin-card element. (c) requires a
   ProseMirror widget decoration that participates in document layout
   (shifts paragraphs below it). (d) requires duplicating the editor
   scroll area thrice with synced position state. (b) is the smallest
   diff to ship.

### Filename: `ReviewApplyExpand.svelte`

8.3's stub title says "Three-way apply UI dialog (Svelte)" — the word
"Dialog" is wrong per the no-modals rule. **Rename to
`ReviewApplyExpand.svelte`** in the implementation; the component is an
expand state of a margin card, not a dialog. Update 8.3's title before
the work starts.

---

## 6. Implementation Outline for attn-nnj.8.3 (Phase 2)

- **Mount**: `web/src/lib/ReviewApplyExpand.svelte`, conditionally
  rendered inside `ReviewMarginCard.svelte` when
  `reviewStore.activeThreeWayApply?.suggestionId === card.suggestionId`.
  The card's `<div>` toggles a `data-expand="true"` attribute that drives
  the CSS width/z-index transition (`width: 320px → calc(100% - 16px)`,
  `z-index: 0 → 20`, ease 200 ms).

- **Store state**: add `reviewStore.activeThreeWayApply: ApplyVerdict |
  null` ($state rune) to `web/src/lib/review/store.svelte.ts`. Set by the
  apply-click handler when the IPC response is `RequiresThreeWay`;
  cleared on accept / reject / Esc. Only one three-way can be open at a
  time (simplifying focus + dim rules).

- **Diff library**: recommend **`diff-match-patch`** (Neil Fraser, ~80 KB
  minified, Apache 2.0). Three-pane char-level diff is its core use case;
  the alternative `jsdiff` is also fine but ~120 KB. **If 80 KB is too
  large** (check release-build delta against the binary-size baseline in
  `planning/collab/binary-size-baseline.md`), hand-roll a Myers
  line-diff: ~150 lines of TypeScript, no dependency. The diffing is the
  one piece worth importing for; everything else is layout.

  Decision deferral: pick at implementation time after a one-shot size
  experiment. Default to hand-rolled if either path adds >50 KB gzipped
  to the editor bundle.

- **Diff coloring (from existing CSS vars only)**:
  - Deletion runs in any pane: `background: var(--suggestion-deletion);
    text-decoration: line-through; color: inherit;`
  - Addition runs in the *proposed* pane: `background:
    var(--suggestion-bg);`
  - Owner edit runs in the *current* pane (the "this is what you did"
    delta vs snapshot): `background: var(--comment-highlight);` —
    repurposes the warm comment tint to signal "your own change," which
    contrasts naturally with the cool/green suggestion tint on the
    proposed side.
  - Confidence label uses `--confidence-med` / `--confidence-low`
    inline-decoration colors from 10.2 directly.

- **Layout**:
  - Three flex columns with `flex: 1 1 0` and `min-width: 0` so each
    pane wraps gracefully.
  - Max-height: `min(60vh, 600px)`; columns scroll internally with a
    synchronized scroll handler (scrolling one scrolls the other two
    by the same `scrollTop`).
  - Footer action row pinned to card bottom (`position: sticky;
    bottom: 0`).
  - Header shows reviewer name, age, confidence, and the
    `target_byte_range` location (e.g. `lines 142-148`) computed from
    `ApplyVerdict.target_byte_range` against the current doc.

- **IPC**: on `[a] accept theirs`, emit `ipc.send({type:
  "review_accept_suggestion", roomId, suggestionId})`. The Rust side
  (8.4 + 8.5) already knows how to write the file via
  `WorkingCopyService` and emit `SuggestionAccepted`. On `[k] keep mine`,
  emit `ipc.send({type: "review_reject_suggestion", roomId,
  suggestionId, reason: "kept owner text"})` (re-uses existing reject
  IPC — see `web/src/lib/ipc.ts`). On `[e] edit`, see Open Question #3.

- **Keybindings**: bound on the expand card's root `<div>` with
  `onkeydown` capturing. `a` → accept; `k` → keep mine (reject); `e` →
  edit; `Esc` → collapse expand, leave suggestion in
  `RequiresThreeWay` state for the user to come back to. Suspends
  `j`/`k` editor cycling while open (via a `reviewStore.expandOpen`
  guard that the existing cycler reads).

- **Dim sibling cards**: a CSS class on the margin overlay root
  (`.margin-expand-open`) drops sibling card opacity to 0.30 via a CSS
  selector; the editor scroll container gets an 8% black overlay
  pseudo-element with `pointer-events: none`. No JS state shuffling for
  the dim — pure CSS off a single root attribute.

- **Resize behavior**: below the 480 px narrow breakpoint already used
  by 10.2, the inline-expand falls back to **filling the entire
  SidebarInset width** (still not a modal — same component, just sized
  to 100% of the available content area). The margin overlay is already
  collapsed at that width per 10.1 §1.4.

---

## 7. Open Questions for the User

1. **Keybindings** — proposed `a` / `k` / `e` / `Esc`. `a` collides
   with 10.1's `a` for accept on a collapsed margin card (intentional
   — same affordance, escalated semantics). Is `k` the right mnemonic
   for "keep mine"? Alternatives: `r` (reject, but reject means
   "discard the suggestion entirely" elsewhere; ambiguous), `m`
   ("mine", clean but no precedent). Lean: `k`.

2. **Diff library** — `diff-match-patch` (~80 KB, battle-tested, more
   features than needed) vs hand-rolled Myers line-diff (~150 LoC, no
   dep, exactly what we need). The size delta matters for the binary
   target (amendments §1: 25 MiB release). Decide after a one-shot
   experiment; default hand-rolled if `diff-match-patch` adds > 50 KB
   gzipped to the editor bundle.

3. **What does `[e] edit` open?** Three options: (a) inline-editable
   textarea pre-filled with `proposed_replacement` — owner edits, then
   `[Cmd+Enter]` writes the edited text; (b) drops the
   `proposed_replacement` into the editor at the target range and lets
   the owner edit in place (with a "confirm this manual merge" pill);
   (c) opens a 4th pane (Snapshot / Current / Proposed / **Working**)
   inside the same expanded card. Lean: (a) — simplest, doesn't pollute
   the editor's undo stack with intermediate states. Confirm.

4. **What happens when the source paragraph was deleted entirely** —
   i.e. `current_text` is empty because the owner deleted the
   `target_byte_range`'s worth of content? Three sub-cases:
   - For a `Replace` suggestion, the current pane shows `(empty —
     paragraph deleted)` in muted text; `[a] accept` re-inserts the
     proposed text at the deletion point.
   - For a `Delete` suggestion, the suggestion is already a no-op (the
     thing it wanted to delete is gone); auto-resolve to a synthetic
     `SuggestionAccepted` without prompting? Or still show the
     three-way for confirmation? Lean: synthetic accept with a passive
     toast "suggestion was already applied (deletion target gone)."
   - For an `InsertBefore` / `InsertAfter` suggestion, the insertion
     cursor is in deleted-text limbo; demote to `Stale`. Confirm this
     three-case split is right or call out a different split.
