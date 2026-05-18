# Review Panel: Layout & Threading Model

Status: design proposal — awaiting human review (`bd human` on attn-nnj.10.1).
Blocks: attn-nnj.4.3 (ReviewPanel.svelte), 4.6 (decorations), 4.7 (ambiguous picker),
4.8 (stale panel state), 4.9 (snapshot badge), 4.10 (share button), 4.11 (connection badge).

References:

- `planning/collab/data-model.md` §UI/UX Changes (lines 776+) — the surface inventory.
- `planning/collab/amendments.md` Decision #15 — anchor resolver confidence cutoffs
  (`exact` / `remapped + moved badge` / `ambiguous` / `stale`).
- `planning/collab/amendments.md` Decision #11 — snapshot cadence
  (snapshots are *coarse*: roughly one per meaningful save batch, not per keystroke).
- `web/src/App.svelte` lines 1421-1435 — the right-rail aside slot
  (`360px` fixed, mounted via `rightRail` snippet prop, toggled by `Cmd+J`).
- `web/src/lib/Sidebar.svelte` — style reference (tabbed segmented control between
  Files/Outline, `SidebarMenu`, `Command.*` for search).
- `web/src/lib/TabBar.svelte` — style reference for any tabbed sub-navigation
  (rounded segments, `color-mix` accent tinting).

---

## 1. Problem Framing

The review panel is the only durable surface for collaboration that does not anchor
to a specific paragraph in the document. It must host: open comment threads,
suggestion cards with accept/reject controls, ambiguous-anchor pickers when the
resolver returns two or more candidates within 0.10 confidence (Decision #15),
stale items that lost their anchor entirely and need manual re-anchoring,
per-file and per-snapshot context (Decision #11 means a single review can span
2–5 snapshots of the same file), and inline status (snapshot age, "reviewer on
older snapshot," connection badge). Density matters: an agent that has run a
careful pass typically produces 20–40 findings, and the panel sits in a 360 px
column to the right of the editor — narrower than a GitHub PR file pane. The
default-active perspective also flips between *owner* (triaging incoming
findings, accepting suggestions) and *reviewer* (composing comments, watching
acceptance state). One layout has to serve both without modal switches.

## 2. Three Candidate Layouts

### Candidate (a): Grouped by File → Snapshot → Thread

Classic IDE PR-comments tree. The hierarchy mirrors the data model
(`fileId → snapshotId → AnchorRef → thread`) directly. Each file is collapsible;
each snapshot inside the file is collapsible; threads sit as leaves.

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
│     ┌──────────────────────────────────────────────────────┐│
│     │ agent-rufus · 7m · §line ~412            ? ambiguous ││
│     │ "weights are tunable"  · 2 candidates       pick →   ││
│     └──────────────────────────────────────────────────────┘│
│   ▶ snapshot @ 13:30 (superseded)        2 threads          │
│ ▶ planning/collab/relay-spec.md          4 threads · 1 sugg │
│ ▶ planning/collab/crypto-spec.md         3 threads · 1 sugg │
│ ▶ planning/collab/amendments.md          5 threads          │
├──────────────────────────────────────────────────────────────┤
│ ▶ Stale (2)         ▶ Resolved (12)                          │
└──────────────────────────────────────────────────────────────┘
```

Pros:

- Mirrors the data model — engineers reading the code can predict the structure.
- Per-snapshot grouping makes "reviewer's snapshot vs current" visible at a glance.
- Triage by file is fast when one file dominates.

Cons:

- Three layers of disclosure (file > snapshot > thread). Two open files = a lot
  of vertical bookkeeping. A 30-comment review across 4 files renders ~15 chrome
  rows before a single thread is visible if everything is collapsed.
- Snapshot grouping is the *least* interesting axis for the owner: Decision #11
  produces few snapshots (1 every ~30s of active editing, gated by open threads),
  so most reviews end up with one "current" snapshot per file and the snapshot
  row is dead weight.
- The chrome ruins density: ~3 threads visible above the fold at the default
  360 px × ~900 px panel, vs 5–6 in the other candidates.

Density estimate (30 comments across 4 files, all expanded):
~3 threads above the fold at default panel height. Scrolling required for everything.

---

### Candidate (b): Flat Thread List with File/Snapshot Chips

Linear/Notion-style. Threads are first-class line items, ordered newest-first
(or by sort dropdown). File and snapshot are *chips* on each thread, not parent
containers. Filtering replaces grouping.

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
│ │ alex · 9m                            comment             │ │
│ │ relay-spec.md · snap 14:02 · §Admission Key             │ │
│ │ "Worth a worked example of the HMAC inputs."            │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 11m              stale · re-anchor ⚠       │ │
│ │ data-model.md · snap 13:30 · §line ~488 (lost)          │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ 12 resolved (hidden)  ·  show                                │
└──────────────────────────────────────────────────────────────┘
```

Pros:

- Density: 5–6 threads above the fold at 360 px. Cards are 4–5 lines each.
- Single scrollable river — j/k moves through *threads*, not chrome.
- Time-ordered feels right for a live review session: the latest agent finding
  bubbles to the top regardless of which file it touched.
- File/snapshot filters in the toolbar give the candidate-(a) view on demand,
  without paying the chrome cost when you don't need it.

Cons:

- Per-file overview is one click away (filter dropdown). When one file has 15
  threads and others have 1–2, that imbalance is less obvious.
- Snapshot-grouped mental model (reviewer pinned to 13:30, owner now on 14:02)
  is conveyed by the chip, not the structure — easier to miss.
- Toolbar real estate is heavy (4 controls + search). Risk of feeling busy in
  short reviews (<5 threads).

Density estimate (30 comments, no filter):
~5–6 threads above the fold. Stale and resolved are out of the river.

---

### Candidate (c): Tabbed by Lifecycle State

Tabs across the top: **Threads** (open + replied), **Suggestions** (pending
accept/reject), **Pickers** (ambiguous, awaiting anchor decision), **Stale**
(lost anchor, needs manual re-anchor). Inside each tab the list is flat and
chronological — same card shape as (b), without the filter row.

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
│ │ ─ diff ──────────────────────────────────────────────── │ │
│ │ - The anchor resolver runs 8 steps.                     │ │
│ │ + The anchor resolver runs 10 steps (+math, +mermaid).  │ │
│ │ ──────────────────────────────────────────────────────── │ │
│ │              [accept]  [accept + edit]   [reject]       │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 15m                                        │ │
│ │ relay-spec.md · §POST /envelopes                         │ │
│ │ insert: "Batch cap = 32 (Decision #7)."                 │ │
│ │              [accept]  [accept + edit]   [reject]       │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ agent-rufus · 22m              three-way · stale source ⚠│ │
│ │ data-model.md · §line ~488                              │ │
│ │ underlying text changed since suggestion authored.      │ │
│ │              [open three-way]   [reject]                │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Pros:

- Each tab has a single clear job; no mode-switching inside a tab.
- Ambiguous pickers and stale items get a dedicated home — they cannot get
  buried under regular threads. Direct mapping from Decision #15's four states
  (`exact` / `remapped` / `ambiguous` / `stale`) to UI placement.
- Pending suggestions are the highest-leverage owner action; surfacing them on
  a counted tab pressures the owner to clear them.
- Each tab can have tab-specific chrome (three-way apply UI in Suggestions, big
  picker dropdown in Pickers) without cluttering the other tabs.

Cons:

- Owner has to context-switch between 4 tabs to fully triage a review.
  ("Is there anything left?" requires checking 4 counts.)
- Reviewer composing a follow-up comment on a previously-suggested edit has to
  jump Suggestions → Threads when the suggestion is accepted and conversation
  continues.
- A thread that *was* a suggestion (now accepted) and now has follow-up replies
  has an ambiguous home. Hidden-state machine bugs likely.
- Tabs eat 3 rows of vertical chrome on every view.

Density estimate (30 comments split across tabs ~17/4/2/2):
~4 cards above the fold inside the active tab (suggestions are taller); ~6 in
the Threads tab. Total visibility across tabs requires explicit clicks.

---

## 3. Cross-Cutting Concerns

### 30-comment review feel

- (a) Tree: Heavy. Disclosure arrows everywhere. Owner ends up either expanding
  everything (and scrolling forever) or playing accordion. Worst case for
  density.
- (b) Flat: Best. The river is the right shape for "work through findings
  top-to-bottom." Filters collapse to specific files on demand.
- (c) Tabbed: Forces a triage *order* (clear Pickers → clear Suggestions →
  reply to Threads → re-anchor Stale). That's helpful for a structured owner,
  prescriptive for everyone else.

### Ambiguous picker placement

Picker payload: 2–4 candidate ranges from the resolver, each with confidence
score, ~80 chars of surrounding context, and a "pick" button. Per Decision #15,
ambiguous is panel-only — there is no inline highlight to click.

- (a) Tree: Inline-expandable inside the thread card. The candidate list pushes
  the card to ~12 lines. Two ambiguous items in the same file expand to dwarf
  everything else.
- (b) Flat: Card collapsed by default shows "? ambiguous · 2 candidates · pick
  anchor →". Click expands inline; expanded card grows to ~10 lines but the
  river handles it. Acceptable. **Modal is rejected** — modals break keyboard
  triage flow.
- (c) Tabbed: Dedicated Pickers tab, expanded by default since the tab exists
  *for* this. Single ambiguous item gets the full panel width and can show
  candidate diff context generously.

### Stale items

- (a) Tree: Bottom-of-panel collapsed footer ("▶ Stale (2)"). Visible but
  out-of-flow. Per-file context is lost when collapsed.
- (b) Flat: Inline cards with a `stale · re-anchor` badge, sorted to the bottom
  by default (or filter-only). Stale items never disappear, but they get out of
  the way of active work. The card shows the *last known* snapshot/section so
  the re-anchor decision has context.
- (c) Tabbed: Dedicated Stale tab. Counter forces attention; tab is empty in
  the happy path so the cost is invisible most of the time.

### Resolved thread visibility

- (a) Tree: "▶ Resolved (12)" collapsed footer per the design above. Most users
  never expand it; resolved is effectively hidden but discoverable.
- (b) Flat: Hidden by default, "12 resolved · show" link at the bottom. Click
  splices them into the river (greyed, with a `✓ resolved` chip) sorted by
  resolution time.
- (c) Tabbed: Per-tab filter "show resolved" toggle in each tab's header. More
  switches to manage.

Recommend **hidden-by-default with one-click reveal** across all candidates,
matching Linear. Reviews that exhaust the open list want closure, not
distraction.

### Owner vs reviewer perspective flex

The two perspectives differ in *which actions matter*:

- **Owner** triages: accept/reject suggestions, pick ambiguous anchors, reply
  to comments. The Suggestions and Pickers states are owner-only actionable.
- **Reviewer** composes: writes new comments/suggestions, watches acceptance
  state on prior submissions, replies to owner.

- (a) Tree: Same view both perspectives. Reviewer wades through the same chrome
  to find their own threads.
- (b) Flat: A `mine` filter solves reviewer's "where are my submissions?"
  question. Default sort (newest) serves both perspectives.
- (c) Tabbed: Worst fit for reviewer — Suggestions and Pickers tabs are mostly
  not-actionable for reviewers, so two of four tabs are dead weight. Reviewer
  effectively lives in the Threads tab.

### Keyboard-only navigation

Per `/Users/jameslal/.claude/CLAUDE.md`: no `window.confirm` / `alert`; all
interactions must be in-app, and a first-class keyboard story is required.

Shared minimum: `Cmd+J` toggles the panel (already wired in App.svelte). `j`/`k`
moves between items. `Enter` opens / expands. `Esc` collapses or closes.
`a` accept, `r` reject on a suggestion. `?` opens shortcuts dialog.

- (a) Tree: Three navigation levels (file/snapshot/thread). Either `h`/`l`
  toggles disclosure on the current row, or `j`/`k` skips through chrome rows
  (annoying) or skips them (then chrome state is invisible from keyboard).
  Hard to get right.
- (b) Flat: One list, one cursor. `j`/`k` cycles cards. `f` opens filter
  popover (keyboard-navigable). `/` focuses search. Clean.
- (c) Tabbed: `1`/`2`/`3`/`4` jumps tabs (or `Tab` cycles), `j`/`k` inside.
  Two-level model but each level is shallow and predictable.

(b) and (c) are both achievable; (a) is the hardest.

---

## 4. Recommendation

**Adopt Candidate (b): flat thread list with file/snapshot chips,
filter-driven grouping.**

Justification:

1. **Density wins.** The panel is 360 px wide and competes for vertical space
   with the editor's outline view. A 30-finding review fits in ~5 screen
   heights vs ~10 for the tree, and ambiguous/stale items don't disappear into
   collapsed sections.

2. **Decision #11 makes snapshot-as-container low-value.** The snapshot cadence
   is coarse (~one per save batch with open threads, never per keystroke). Most
   reviews end up with one current snapshot per file plus maybe one superseded.
   Promoting snapshot to a hierarchy layer (candidate a) inflates chrome for a
   dimension that has 1–2 values. Chip on the card is exactly right.

3. **Decision #15's four states map naturally to inline badges, not tabs.**
   `exact` is silent; `remapped` gets a `▲ moved` badge inline; `ambiguous`
   gets a `? ambiguous · N candidates · pick →` card with inline-expandable
   picker; `stale` gets a `stale · re-anchor ⚠` badge and sorts to the bottom
   (still in the river). The reviewer/owner can see them in one scroll without
   tab switching. This matches the resolver's UI-cutoffs table in §15 directly:
   "≥0.90 inline / 0.70–0.89 inline + badge / ambiguous panel-only with picker
   / stale panel-only manual re-anchor" all live in one river with different
   badges.

4. **Keyboard story is simplest.** Single cursor, single river. No
   level-switching, no decision about whether `j` skips chrome.

5. **Flex between owner and reviewer is cheap.** Add a `mine` filter plus a
   default sort (newest); both perspectives use the same layout. No "owner
   mode" vs "reviewer mode" toggle to maintain.

6. **The tabbed model (c) is appealing for a structured triage flow but is
   wrong for ongoing review.** Once the owner clears Pickers and Suggestions,
   the other tabs are empty and the layout has spent 3 rows of chrome on
   nothing. (c)'s strengths can be recovered as filter presets in (b):
   `filter: ambiguous`, `filter: suggestions`, `filter: stale`.

7. **The tree model (a) is the IDE convention but optimizes for the wrong
   axis** — file-tree review made sense in a multi-hundred-file PR. attn rooms
   live for an hour and review 1–5 markdown files; the tree's discriminating
   power is wasted, and its chrome cost is paid every render.

### Implementation outline for attn-nnj.4.3

- `ReviewPanel.svelte` mounted into App.svelte's existing `rightRail` snippet
  slot (no layout change to App).
- Top bar: counters (`23 open · 4 suggest`), connection badge, panel close.
- Filter row: `file ▾`, `snapshot ▾`, `state ▾` (open/suggestions/ambiguous/
  stale/resolved/mine), `sort ▾` (newest/oldest/file-then-newest), search.
  Filters are persisted per-room in `localStorage`.
- Card list inside `ScrollArea`, virtualized if >100 items.
- Card states: comment, suggestion (with accept/reject/edit), suggestion +
  three-way (when source text changed since author), ambiguous + inline picker,
  stale + re-anchor action, resolved (greyed).
- Each card carries `file · snapshot-time · §section-or-line` as a chip row
  immediately under the author/timestamp.
- Resolved hidden by default, revealed via `12 resolved · show` footer link.
- Keyboard: `j`/`k`, `Enter` to expand, `Esc` to collapse, `a`/`r` for
  suggestions, `/` for search, `f` for filter popover, `Cmd+J` to toggle.

This matches the "Owner UI" surfaces enumerated in `data-model.md` §UI/UX
Changes line-by-line: share button (separate, in the toolbar — not in the
panel; ships in 4.10), room mode selector (toolbar), connection badge (panel
header), peer strip (panel header second row — out of scope here, ships in
4.11), review panel (this doc), snapshot badge (editor header, ships in 4.9),
inline highlights (editor decorations, ships in 4.6), ambiguous picker (panel
card, this doc), stale state (panel card, this doc), suggestion card (panel
card, this doc), three-way apply (suggestion card expanded state).

---

## 5. Open Questions for the User

The following affect 4.3's data model and need a decision before panel
implementation begins:

1. **Resolved threads: hidden or always-shown?** Recommendation above is
   hidden-by-default with a reveal link (Linear's behavior). Notion shows them
   greyed inline. Which?

2. **Filter persistence scope: per-room or global?** A reviewer who lives in
   `filter: mine` probably wants that across rooms. A triaging owner probably
   wants per-room (different reviews have different shapes). Default proposed:
   per-room.

3. **Card timestamp format: relative (`3m`, `2h`) or absolute (`14:02`)?**
   Relative reads more natural in a live session; absolute is unambiguous when
   reviewing async-mode catchup. Could split: relative for <24h, absolute
   beyond. Decide before implementation to avoid mid-stream churn.

4. **Suggestion card width: stay in 360 px panel, or allow expand-to-
   half-editor?** Three-way apply (stale-source suggestions) shows three text
   columns and is cramped at 360 px. Option: clicking "open three-way" opens
   an inline-editor overlay (full editor width, panel stays open) rather than
   a true modal. Needs UX validation against the no-modals rule.
