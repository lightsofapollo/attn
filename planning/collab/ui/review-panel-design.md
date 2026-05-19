# Review Surface: Margin Sticky Cards (Google-Docs Model)

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.1).
Blocks: attn-nnj.4.3 (`ReviewMargin.svelte`), 4.6 (decorations), 4.7 (ambiguous
picker), 4.8 (stale state), 4.9 (snapshot badge), 4.10 (share button),
4.11 (connection badge).

References:

- `planning/collab/ui/inline-decorations.md` (10.2) — inline highlight system;
  unchanged. Only the click-target of a highlight pivots from "panel item" to
  "margin card."
- `planning/collab/ui/connection-share.md` (10.3) — review-bar row above the
  editor; independent of the panel-vs-margin choice and unchanged.
- `planning/collab/data-model.md` §UI/UX Changes (lines 776+) — surface inventory.
- `planning/collab/amendments.md` Decision #15 — anchor resolver confidence
  cutoffs (LOCKED).
- `planning/collab/amendments.md` Decision #11 — coarse snapshot cadence.
- `web/src/App.svelte` lines 1448-1462 — the existing right-rail aside
  (`360px` fixed, `rightRail` snippet slot, toggled by `Cmd+J`). This rewrite
  **repurposes that slot as an overlay container**, not a fixed-width sibling.
- `web/src/lib/review/popover-anchor.ts` — the existing `view.coordsAtPos(...)`
  utility used by the hover popover. Reused for per-anchor y-resolution.
- `web/src/lib/review/store.svelte.ts` — `reviewStore.events` +
  `reviewStore.anchorResolutions` drive recomputation.

---

## 0. Pivot Note

The original 10.1 design (a 360px panel "river" of flat thread cards with
file/snapshot chips) was reconsidered after the v2 use case sharpened: a
review session targets **1-5 markdown files** and **~40 findings**, runs for
roughly an hour, and is dominated by an owner walking the document
top-to-bottom alongside an agent's annotations. At that scale **spatial
anchoring beats triage filtering**: the owner's mental model is "what does
this paragraph say to me," not "show me all open suggestions sorted by
recency." A right-rail panel forces a constant gaze ping-pong between the
inline highlight and a separate sorted list; a Google-Docs-style margin places
each card *next to* the text it annotates and removes the lookup step
entirely.

The recommendation has flipped. The three-candidate exploration that produced
the original "flat list with chips" recommendation is preserved at the bottom
of this doc under "Considered alternatives" so the reasoning trail is
recoverable, but it is no longer the proposed design. The new model is
specified in §1-§6 below.

---

## 1. The New Model — Margin Sticky Cards

The right-rail aside (App.svelte:1448-1462) becomes an **overlay container
for margin cards**. It is ~320px wide, lives flush to the right edge of the
document scroll area, and **scrolls with the document** rather than
independently. Each open thread renders as a card positioned at the y-pixel
of its resolved anchor. The result reads as Google Docs comments: the card
sits beside the paragraph it talks about.

### 1.1 Layout

```text
┌── tao window ──────────────────────────────────────────────────────────────────────────┐
│ ┌── Sidebar ──┐┌── SidebarInset ────────────────────────────────────────────────────┐  │
│ │  Files      ││ [TabBar] data-model.md  amendments.md                          40px│  │
│ │  Outline    ││ ▸ planning › collab › data-model.md                            40px│  │
│ │             ││ [Share] ● Live direct  · 👤james 🤖rufus 👤alex   [snap 14:02] 36px│  │ ← 10.3 review-bar row
│ │             ││ ┌── editor scroll area ────────────────────────┐┌── margin ─────┐  │  │
│ │             ││ │                                              ││ ╔═══════════╗ │  │  │ ← orphan tray
│ │             ││ │ # Phase 0c                                   ││ ║ 2 needs   ║ │  │  │   (sticky-top)
│ │             ││ │                                              ││ ║ attention ║ │  │  │
│ │             ││ │ The anchor resolver runs 8 steps.            ││ ╚═══════════╝ │  │  │
│ │             ││ │ ~~~~~~~~~~~~~~~                              ││ ┌───────────┐ │  │  │ ← card 1
│ │             ││ │                                              ││ │ rufus 6m  │ │  │  │   aligned to
│ │             ││ │                                              ││ │ suggest ▲ │ │  │  │   "anchor"
│ │             ││ │ Each step emits a candidate.                 ││ │ → 10 steps│ │  │  │
│ │             ││ │ ====                                         ││ │ [accept]  │ │  │  │
│ │             ││ │                                              ││ └───────────┘ │  │  │
│ │             ││ │                                              ││ ┌───────────┐ │  │  │ ← card 2
│ │             ││ │ Combine into a deduplicated set.             ││ │ alex 3m   │ │  │  │   aligned to
│ │             ││ │ ~~~~~~~~                                     ││ │ "Do we    │ │  │  │   "combine"
│ │             ││ │                                              ││ │  need…?"  │ │  │  │
│ │             ││ │                                              ││ │  1 reply  │ │  │  │
│ │             ││ │                                              ││ └───────────┘ │  │  │
│ │             ││ │ Emit ambiguous when top two are within 0.10. ││               │  │  │
│ │             ││ │                                              ││ ┌───────────┐ │  │  │ ← card 3
│ │             ││ │                                              ││ │ rufus 11m │ │  │  │
│ │             ││ │                                              ││ │ ▲ moved   │ │  │  │
│ │             ││ │                                              ││ │ "weights  │ │  │  │
│ │             ││ │                                              ││ │  tunable" │ │  │  │
│ │             ││ │                                              ││ └───────────┘ │  │  │
│ │             ││ │                                              ││ ─────────────│  │  │ ← collapsed
│ │             ││ │                                              ││  ✓ resolved 12│  │  │   resolved strip
│ │             ││ └──────────────────────────────────────────────┘└───────────────┘  │  │
│ └─────────────┘└────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                                                  ↑ margin overlay
                                                                    width 320px
                                                                    Cmd+J toggles
```

The margin overlay shares the editor's vertical scroll: when the user scrolls
the document, cards move with it because their `top` is computed in document
space, not viewport space.

### 1.2 Card anatomy

```text
┌──────────────────────────────────┐
│ rufus · 6m         suggest ▲ ◧ │ ← author chip, age, kind badge, state badge, overflow menu
│ §Anchor resolver               │ ← section / line context (single line, ellipsis)
│ ─────────────────────────────── │
│ replace "8 steps" → "10 steps  │ ← body (4 line clamp, click to expand)
│ (+math, +mermaid)"             │
│ ─────────────────────────────── │
│ [accept]  [accept+edit]  [✕]   │ ← action row (kind-specific; suggestion shown)
└──────────────────────────────────┘
   width: 320px  ·  clamp body: 4 lines  ·  shadow on focus
```

Card variants share the header/footer chrome and swap the middle:

- **Comment** — body + (n replies) chevron; action row collapses to `↩ reply`.
- **Suggestion** — diff body + `[accept] [accept+edit] [reject]`.
- **Suggestion + stale source** — diff body with red "source changed" strip +
  `[open three-way] [reject]`. Three-way opens an inline editor overlay
  (see §6 implementation outline; no modal per project rule).
- **Ambiguous** — lives in the orphan tray (§2), not in line.
- **Stale (no anchor)** — lives in the orphan tray (§2).
- **Remapped, 0.70-0.89 confidence** — a `▲ moved` badge sits in the header
  next to the kind badge. The body is otherwise a normal comment/suggestion.
  This is the panel-side counterpart to 10.2's inline `moved` underline; both
  visuals draw from the same `reviewStore.anchorResolutions` entry so there
  is no double source of truth.

### 1.3 Stack / collision rules

Two or more anchors that resolve close together cannot all sit at their
ideal `top` without overlapping. Resolution mirrors Google Docs:

1. Walk cards in **document order** (smallest `anchorY` first).
2. For each card, set `top = max(anchorY, previousBottom + gutter)` where
   `gutter` is 8px.
3. If `top !== anchorY`, the card is "offset." Draw a 1px **SVG connector
   line** from the card's left edge midpoint back to the highlight in the
   editor. The line uses the same stroke color as the inline highlight kind.
4. The card never sits *above* its anchor — only below. If the natural
   position is occupied, it pushes down, never up.
5. If the entire margin column overflows the visible scroll, cards beyond the
   viewport still exist (they participate in y-layout) — they are just
   off-screen. Virtualization (§6) clips rendering to a viewport ± 800px band.

### 1.4 Width, position, scroll

- **Card width**: fixed at **320px** (clamp 280-320 in narrow viewports;
  below 280 the margin collapses and we fall back to the orphan tray for all
  cards — see §7 open question 5).
- **Vertical position**: per anchor, computed via `coordsAtPos(view,
  anchor.byteRange[0])` (reuses `web/src/lib/review/popover-anchor.ts`).
- **Horizontal position**: fixed; margin overlay does not scroll horizontally.
- **Vertical scroll**: margin overlay does **not** scroll independently. Its
  parent is the editor scroll container, so cards move with the text.

### 1.5 Focus state

- **Active card**: full opacity, shadow elevation, 1px accent border.
- **Inactive cards**: 60% opacity, no shadow.
- **Click an inline highlight** → marks the corresponding margin card active,
  scrolls it into view (smooth, 200ms), and pulses the accent border once.
- **Click a margin card** → moves the editor cursor to the anchor's start
  position and scrolls the editor to put the anchor at ~1/3 viewport height.
- **Keyboard**: `j`/`k` cycles the active card (and scrolls editor +
  margin in lockstep); `Enter` opens replies / expands body; `Esc` deactivates.

These match 10.2's `editor ↔ surface focus sync` requirement without
modification: 10.2 doesn't care whether the "surface" is a panel item or a
margin card, only that the focused review record is a single store value.

---

## 2. The Orphan Tray

Some cards have no single y-position to align to. Cluster them at the **top
of the margin** in a sticky-pinned tray so they cannot scroll away.

```text
┌──────────────────────────────────┐
│ ╔═══════════════════════════╗   │
│ ║ 2 needs attention         ║   │ ← chip header; sticky to top of margin
│ ╠═══════════════════════════╣   │
│ ║ rufus · 7m       ? amb    ║   │ ← ambiguous card
│ ║ §line ~412                ║   │
│ ║ "weights are tunable"     ║   │
│ ║ 2 candidates              ║   │
│ ║ ◯ §Anchor resolver L412   ║   │ ← inline picker
│ ║ ◯ §Calibration   L488     ║   │
│ ║ [pick] [skip]             ║   │
│ ╠═══════════════════════════╣   │
│ ║ rufus · 22m  ⚠ stale      ║   │ ← stale card
│ ║ last seen §line ~488      ║   │
│ ║ "underlying text changed" ║   │
│ ║ [re-anchor manually] [✕]  ║   │
│ ╚═══════════════════════════╝   │
└──────────────────────────────────┘
```

Tray rules:

- **Sticky-top**: tray uses `position: sticky; top: 0` within the margin
  overlay so it pins at the visible top while the user scrolls past anchored
  cards below.
- **Counter chip**: `N needs attention` where N = ambiguous + stale + remapped
  in the 0.35-0.69 range (single-candidate panel-only per amendments §15 step
  6, which produces "panel-only with no picker" — these get the simplest tray
  card: a one-line "confirm anchor at §X" affordance).
- **Ambiguous card** has the picker inline: radio list of candidates with
  section/line context and a `[pick]` button. No popup, no modal. Picking a
  candidate immediately exits the tray and the card animates down to its new
  anchor position over 250ms.
- **Stale card** has only `[re-anchor manually]` — clicking it puts the editor
  into a "drop anchor here" mode (next click in the document places the
  anchor). `[✕]` dismisses the thread as resolved.
- **Tray scroll**: if the tray itself exceeds ~40% of viewport height, it
  scrolls internally. Anchored cards below the tray keep their normal layout.

The orphan tray is the **only** place ambiguous and stale items appear. That
matches amendments §15: "`ambiguous` → panel-only with picker" / "`stale` →
panel-only, requires manual re-anchor" — the margin overlay *is* the panel
in this design, and the tray is its dedicated dock for items that cannot
spatial-align.

---

## 3. Resolved State

Resolved threads do **not** disappear. They shrink to a **single-line grey
strip** in place (same y-position as the active card would have had):

```text
│ ─── ✓ rufus · resolved 2m · §Anchor resolver ─── │
```

The strip is 24px tall, uses the `--muted-foreground` color, and is dismissed
from the document-order layout queue (it can be skipped over for collision
purposes — newer active cards collapse past it).

If there are more than 5 collapsed strips visible in the current viewport,
the design collapses them further to a "show all resolved" pill at the
**bottom of the margin** (still inside the overlay, after the last anchored
card):

```text
│ ─────────────────────────────────── │
│       ⌃ 12 resolved · show          │ ← bottom pill, click to expand all strips
│ ─────────────────────────────────── │
```

Clicking the pill expands all strips inline at their anchor positions.
Clicking a strip pops it back to a full card for one cycle (until next focus
change).

---

## 4. Coherence with 10.2 and 10.3

### 10.2 — Inline decorations (unchanged)

10.2's split-treatment decoration system stands. The inline highlight kinds,
the `▲ moved` underline at 0.70-0.89 confidence, and the hover popover are
all unchanged. Only one interaction shifts:

- **Old**: clicking an inline highlight focuses the corresponding **panel
  item** in the right-rail river.
- **New**: clicking an inline highlight focuses the corresponding **margin
  card** (and scrolls it into view if collision-offset).

The `moved` state at 0.70-0.89 confidence (amendments §15: "0.70-0.89 →
inline highlight + 'moved' badge in panel") now reads as: **inline
underline** (10.2's responsibility) **plus** a `▲ moved` badge on the margin
card header (this doc's §1.2). Both are driven by the same
`reviewStore.anchorResolutions` record — single source of truth.

10.2's editor ↔ surface focus sync hook is unchanged. The "surface" is now
the margin overlay; the hook still receives a `(threadId, anchorId)` pair
and dispatches focus to whatever surface owns that thread (margin card or
orphan tray entry).

### 10.3 — Review-bar row + share (unchanged)

10.3's recommendation stands without modification. The review-bar row
(`[Share] · ● Live · 👤peers · [snap @14:02]`) sits **between the breadcrumb
and the editor**, above both the editor scroll area and the margin overlay.
Geometry:

```text
PathBreadcrumb           ← 40px
┌─ review-bar row ──────┐ ← 36px (10.3)
│ [Share] ● Live peers… │
└───────────────────────┘
┌─ editor ───────┐┌ margin ┐ ← editor + margin overlay share vertical space
│                ││  cards │
│                ││        │
└────────────────┘└────────┘
```

The connection badge, peer strip, share button, and snapshot badge all live
in 10.3's row. They are **not** duplicated in the margin overlay. The margin
overlay's only header chrome is the orphan tray (§2).

### 12.1 — Right-rail slot becomes the margin overlay container

App.svelte:1448-1462 today defines the right-rail as a fixed-width
(`360px`) flex sibling of the editor with `border-l` and its own overflow.
The margin overlay needs a different geometry:

- It is **inside** the editor scroll container, not a sibling of it.
- It does **not** have its own scrollbar.
- Its width is **320px** (down from 360px).
- The border is dropped; cards stand on their own with shadow on focus.

This is a small CSS adjustment, not a layout rewrite. The `rightRail` snippet
prop continues to exist; `ReviewMargin.svelte` mounts into it. The 4.3
implementer wraps the snippet contents in an absolutely-positioned overlay
inside the editor's scroll parent. Document this in 4.3's task description
so the implementer doesn't try to keep the `aside` as a flex sibling.

---

## 5. Keyboard Story

Same shape as the original recommendation, retargeted to cards-in-margin:

- `Cmd+J` toggles the margin overlay (existing wiring in App.svelte).
- `j` / `k` cycles the active card top-to-bottom. The editor scrolls in
  lockstep so the anchor of the active card sits at ~1/3 viewport height.
- `Enter` expands replies / opens body / expands picker.
- `Esc` deactivates the current card.
- `a` / `r` accept / reject on a suggestion card.
- `t` jumps focus into the orphan tray; `j`/`k` then cycles tray items.
- `?` opens the shortcuts dialog (existing).

No per-tab cursor (this isn't tabbed). No multi-level navigation. Single
cursor over the document-order list (tray items first, then anchored cards,
then collapsed-resolved strips if expanded).

---

## 6. Implementation Outline for attn-nnj.4.3

- **Mount**: `web/src/lib/ReviewMargin.svelte` mounted into App.svelte's
  `rightRail` snippet slot. No layout rewrite of App.svelte; the slot is
  repurposed as an overlay (see §4 / 12.1 note).
- **Container CSS**: the snippet contents render an
  `absolute`-positioned `<div>` pinned to `right: 0; top: 0` inside the
  editor's scroll parent, width 320px, height = scroll-content height. The
  existing `<aside>` becomes a positioning ancestor only — strip its
  `border-l` and `overflow` rules.
- **Per-card render**: for each visible thread, render a `<ReviewMarginCard>`
  with `style="top: {top}px"`. `top` is the collision-resolved y-pixel from
  §1.3.
- **Anchor-y resolution**: use `view.coordsAtPos(view, anchor.byteRange[0])`
  to get the top-y of the highlight. Reuse `web/src/lib/review/
  popover-anchor.ts`; if that module currently returns only the popover-
  relevant coords, extract a small `anchorTopY(view, byteOffset): number`
  helper alongside it.
- **Collision pass**: pure function `layoutCards(anchorsInDocOrder, gutter):
  Array<{cardId, top, offset}>`. Unit-testable; no DOM access. Returns the
  per-card `top` and whether the card is offset (drives the SVG connector).
- **SVG connectors**: one `<svg>` inside the overlay container with `<line>`
  elements from each offset card's left-midpoint to its anchor's right edge.
  Recomputed on the same tick as `layoutCards`.
- **Reactivity**: subscribe to `reviewStore.events` and
  `reviewStore.anchorResolutions`. Recompute on doc change (debounced
  16ms) and on store change.
- **Orphan tray**: separate `<ReviewMarginTray>` rendered at the top of the
  overlay with `position: sticky; top: 0`. Consumes the same store; filters
  to `status === 'ambiguous' || status === 'stale' || (status === 'remapped'
  && confidence < 0.70)`.
- **Resolved strips**: filtered list of resolved threads, rendered at their
  anchor's `top`. The "show all" bottom pill mounts after the last anchored
  card.
- **Performance**: cap rendered cards at ~50 in viewport (a 800px band above
  and below visible viewport). Below 50 visible, no virtualization. Above
  100 in document, virtualize using the same band logic. Off-band cards
  still participate in collision-y calculation (so on-band layout is
  correct) but skip DOM render.
- **Focus sync**: `ReviewMargin` exposes `focusCard(threadId)` on the
  `window.__attn__` bridge; 10.2's `editor ↔ surface focus sync` hook calls
  it on highlight click. Conversely, clicking a margin card calls
  `view.dispatch(state.tr.setSelection(...))` to move the editor cursor.

---

## 7. Open Questions for the User

These affect 4.3's implementation; decide before the issue starts.

1. **Comment thread replies (expand pattern)** — when a comment has N
   replies, do we (a) expand them in place inside the card (card grows tall,
   pushes other cards down via collision), (b) always show them (verbose for
   long threads, eats vertical space), or (c) open a popover/sidebar when the
   card is focused (keeps cards compact, but adds a hover surface)?
   Recommendation: (a), capped at 5 replies visible with a "… N more" chevron
   that opens a per-card scroll inside the card.

2. **Initial scroll position when entering a doc with active reviews** —
   center the editor on the **first comment** (most context for the owner),
   or stay at the **top** (predictable, owner picks their pace)?
   Recommendation: top by default; flash the first card to draw the eye.

3. **Edit-mode visibility** — when the editor is in edit mode (user is
   typing), do cards stay visible (Google Docs behavior) or hide (some apps,
   to maximize horizontal space)? Recommendation: stay visible; cards are
   the whole point of the design.

4. **Connector treatment when a card is collision-offset** — SVG line
   (cleanest), dotted border around the inline highlight that thickens when
   the card is focused (less new visual vocabulary), or both? Google Docs
   uses both subtly. Recommendation: SVG line for offset cards (always);
   highlight border thickens only on focus.

---

## 8. Considered Alternatives — Original Panel-River Exploration

*This section is preserved as historical context. The recommendation below
("Candidate b: flat thread list") was the original 10.1 conclusion. It was
superseded by the margin-card design above. The candidates remain useful for
understanding what was rejected and why, and for revisiting if the v2 use
case shifts (e.g., reviews across 50+ files where spatial anchoring loses
to filtering).*

### 8.1 Original problem framing

The review panel is the only durable surface for collaboration that does not
anchor to a specific paragraph in the document. It must host: open comment
threads, suggestion cards with accept/reject controls, ambiguous-anchor
pickers when the resolver returns two or more candidates within 0.10
confidence (Decision #15), stale items that lost their anchor entirely and
need manual re-anchoring, per-file and per-snapshot context (Decision #11
means a single review can span 2-5 snapshots of the same file), and inline
status (snapshot age, "reviewer on older snapshot," connection badge).
Density matters: an agent that has run a careful pass typically produces
20-40 findings, and the panel sits in a 360 px column to the right of the
editor — narrower than a GitHub PR file pane.

### 8.2 Candidate (a): Grouped by File → Snapshot → Thread

Classic IDE PR-comments tree. Hierarchy mirrors the data model
(`fileId → snapshotId → AnchorRef → thread`).

```text
┌─────────────────────────── 360px ────────────────────────────┐
│ Review · 23 open · 4 suggest ▼ filter   live ●   Cmd+J ╳    │
├──────────────────────────────────────────────────────────────┤
│ ▼ planning/collab/data-model.md          7 threads · 2 sugg │
│   ▼ snapshot @ 14:02 (current)           5 threads          │
│     ┌──────────────────────────────────────────────────────┐│
│     │ alex · 3m  · §Phase 0c                       ▲ moved ││
│     │ "Do we still need the spike here? Decision    open   ││
│     │  #1 already kills it."                       1 reply ││
│     └──────────────────────────────────────────────────────┘│
│     ┌──────────────────────────────────────────────────────┐│
│     │ agent-rufus · 6m · §Anchor resolver        suggest   ││
│     │ replace "8 steps" → "10 steps (+math,        accept  ││
│     │   +mermaid)"                       diff ▾    reject  ││
│     └──────────────────────────────────────────────────────┘│
│   ▶ snapshot @ 13:30 (superseded)        2 threads          │
│ ▶ planning/collab/relay-spec.md          4 threads · 1 sugg │
├──────────────────────────────────────────────────────────────┤
│ ▶ Stale (2)         ▶ Resolved (12)                          │
└──────────────────────────────────────────────────────────────┘
```

Rejected because: three layers of disclosure swamp a 30-comment review;
snapshot is the least interesting axis (Decision #11 means most files have
one current snapshot); chrome cost is paid every render.

### 8.3 Candidate (b): Flat Thread List with File/Snapshot Chips

Linear/Notion-style. Threads are first-class line items, ordered newest-first.

```text
┌─────────────────────────── 360px ────────────────────────────┐
│ Review · 23 open · 4 suggest                live ●  Cmd+J ╳ │
│ ▼ all files  ▼ all snapshots  ▼ open    sort: newest  ⌕     │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 7m              ? ambiguous · 2 candidates │ │
│ │ data-model.md · snap 14:02                               │ │
│ │ "weights are tunable"                       pick anchor →│ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 6m            suggest · accept │ reject │~ │ │
│ │ data-model.md · snap 14:02 · §Anchor resolver   ▲ moved │ │
│ │ replace "8 steps" → "10 steps (+math, +mermaid)"  diff ▾│ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ alex · 3m                          comment · 1 reply ↩   │ │
│ │ data-model.md · snap 14:02 · §Phase 0c          ▲ moved │ │
│ │ "Do we still need the spike here? Decision #1 already   │ │
│ │ kills it."                                              │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 11m              stale · re-anchor ⚠       │ │
│ │ data-model.md · snap 13:30 · §line ~488 (lost)          │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ 12 resolved (hidden)  ·  show                                │
└──────────────────────────────────────────────────────────────┘
```

**Was the original recommendation.** Superseded because spatial anchoring
beats filter-driven grouping at the v2 scale (~40 findings across 1-5
files). The "scroll a river of cards while glancing at highlights" gaze
pattern lost to "card sits next to the highlight."

### 8.4 Candidate (c): Tabbed by Lifecycle State

Tabs across the top: Threads / Suggestions / Pickers / Stale. Inside each
tab the list is flat and chronological.

```text
┌─────────────────────────── 360px ────────────────────────────┐
│ Review · 23 open                            live ●  Cmd+J ╳ │
│ ┌────────┬────────────┬─────────┬───────┐                   │
│ │Threads │Suggestions │ Pickers │Stale  │                   │
│ │  17    │     4      │    2    │   2   │                   │
│ └────────┴────────────┴─────────┴───────┘                   │
├──────────────────────────────────────────────────────────────┤
│ Suggestions · 4 pending                       sort: newest  │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 6m                                         │ │
│ │ data-model.md · §Anchor resolver               ▲ moved   │ │
│ │ replace "8 steps" → "10 steps (+math, +mermaid)"        │ │
│ │              [accept]  [accept + edit]   [reject]       │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 22m              three-way · stale source ⚠│ │
│ │ data-model.md · §line ~488                              │ │
│ │              [open three-way]   [reject]                │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Rejected because: owner has to context-switch across four tabs to check
"is there anything left"; reviewer's primary action lives in two of four
tabs only; tabs eat three rows of chrome on every view; the lifecycle
"home" of an accepted-then-replied suggestion is ambiguous.

### 8.5 Why the margin pivot wins over the original recommendation (b)

The margin design subsumes (b)'s strengths and removes its weakness:

- **(b) gave**: density, single-cursor keyboard, file/snapshot chips on cards,
  inline-expandable pickers. **Margin keeps all four** (cards are smaller,
  one cursor over document-order list, chips on cards, picker in tray).
- **(b)'s weakness**: constant gaze ping-pong between inline highlight and
  the panel river. **Margin removes it**: card is *adjacent to* the highlight.
- **(b)'s filter-driven grouping** is now unnecessary at v2 scale: spatial
  position is the grouping. File switching is implicit (you're in the file
  whose cards you see). Snapshot is shown in 10.3's snapshot badge.

The (c) tab argument ("ambiguous/stale need dedicated homes") is preserved
in the margin design via the **orphan tray** (§2), which is a single sticky
slot rather than two tabs.
