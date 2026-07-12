# GOAL: Ship Theme v2 ("The Identity Walks In") across all attn surfaces

> Session goal file. If you are an agent resuming after compaction: read this file,
> `planning/design/ux-overhaul.md`, and `bd ready`, then continue from the Progress
> Log at the bottom. The reference implementation for every visual/behavioral
> question is `planning/design/prototypes/editor-polish.html`.

Ship Theme v2 across all three attn surfaces — the native app (wry webview), the
hosted app at staging.attn.sh (desk + editor + review), and the landing page — so
each surface re-scores **≥35/40 on `/impeccable critique` with zero P0/P1**, and the
product finally *feels* like its brand: warm surface, sharp behavior.

## Sources of truth (read before writing code)

- `planning/design/prototypes/editor-polish.html` — the reference implementation.
  Its tokens, components, and behaviors are the reviewed, AA-verified spec (critique
  trend 22 → 31 → all findings fixed). When in doubt, match the prototype.
- `planning/design/ux-overhaul.md` — phases, acceptance gates, and the Decisions
  section (rail hugs prose and retreats for wide blocks; share flips the storage
  line to "Shared · relay sees only ciphertext"; undo-after-accept is a real revert
  via the LocalRevision journal; owner stays direct-edit with a save/dirty indicator
  as the compensating requirement).
- `DESIGN.md` + `PRODUCT.md` — visual system and register. Add the 2px micro-radius
  token and the prototype's behavioral rules (Truth Rule, Esc layering, focus
  management) to DESIGN.md as named rules.
- `.impeccable/critique/` snapshots — the full P0–P3 backlogs for staging-attn-sh
  and native-app.

## Work queue

Beads: **attn-5y6** (tokens) → **attn-5e7** (shared reading-surface CSS) →
**attn-ll9** (hug rail) / **attn-n9j** (palette + keyboard guard) / **attn-5bq**
(composer) / **attn-e4l** (share dialog), plus **attn-3dv** (journal revert),
**attn-hg5** (behavioral contracts → DESIGN.md), **attn-u5c** (save indicator +
window title). Deps are wired; follow `bd ready`.

Additionally close the critique P0s not yet filed (file beads issues on pickup):
- Hosted owner review rail with comment-arrival surfacing and visible mailbox
  errors (the silent 400).
- Idempotent `#new` + state-aware entry CTA + auto-name workspace from first H1.
- A working `#join` (paste-a-link modal) — or remove the dead cards.
- Native checkbox persistence (task-item NodeView joins the write path).
- Native dialog visibility off the animation clock (Truth Rule).

Landing page: remove the 3px stage-label side stripes, fix the h1→h3 heading skip,
lift 11px body text to the ramp, make the entry triptych honest (no dead cards).

## Hard constraints

Clean cutover, no backwards compat (delete `web/src/hosted/tokens.css` once the
single OKLCH source lands). No `any` types. `web/` uses **npm**, not pnpm. Release
binary ≤32 MiB (`task check:size`). **No TURN, ever.** No window.confirm/alert.
Visibility must never depend on an animation completing. Shortcuts match `e.code`,
not `e.key`. Escape pops the topmost layer only. WCAG AA verified by measurement
(canvas-resolved contrast), not by eye. `prefers-reduced-motion` gets designed
alternatives. Wide content (mermaid via the existing mermaid-nodeview, tables,
code) spans the pane; prose caps at 72ch. Subagents must never run `bd` commands
(dolt-wipe risk) — serialize beads ops in the parent session.

## Verification, per surface, before calling anything done

Native via the daemon automation API (`attn --screenshot/--query/--click` under an
isolated `ATTN_HOME`; `npm --prefix web run build` before `cargo build` so the
frontend embeds). Hosted via headless Playwright against a local build and staging.
Both themes screenshotted. Keyboard-only walk with no ghost stops and no
unreachable controls. Zero horizontal overflow at 390/700/768/1024/1440. Existing
suites green (`task test:review`, `task test:apply`, `task test:dual`). Finish by
re-running `/impeccable critique` on the native app, the hosted editor, and the
landing page — the score gate is **≥35/40 each, zero P0/P1**. Commit per beads
issue, close issues as they land, push at the end of each phase.

## Out of scope

The workspaces-vs-flat-documents IA question (open decision), suggest-first owner
mode (decided against), native mobile, new features. This is the
integration-finishing pass — converge, don't proliferate.

---

## Progress log (update as phases land)

- 2026-07-12: Goal file created. Prototype (reference spec) at v4+rail-hug, pushed
  as 483a4b2..; beads attn-5y6…attn-u5c filed with deps. Nothing from the queue
  implemented in the real app yet. Next: claim attn-5y6, inventory token
  consumption in both builds, execute the cutover.
- 2026-07-12 (f82582d): **attn-5y6 DONE.** web/src/tokens.css is the single source;
  hosted hex tokens.css deleted, chrome.css alias layer added, INK unified cool,
  --muted collision resolved via --hosted-muted rename. Verified both builds/themes.
  Learned: (1) both builds already stamp `.dark` + `data-theme`, so no toggle work;
  (2) the occluded-window stale-paint bug is real — native screenshots after a
  theme flip need a forced repaint until attn-hg5 lands; (3) hosted app entries
  also load app.css via desktop-editor-styles.ts (Tailwind utilities). Next:
  attn-5e7 (base.css/prosemirror.css: 72ch measure + wide track, fonts→tokens,
  grain z 9999→40, scrollbars, ::selection, markers, table hairlines).
- 2026-07-12 (fcb9c28): **attn-n9j DONE.** ⌘K (+⌘P alias), help, and tab-nav
  moved above the keyboard.ts editing guard — global chords work with editor
  focus. CommandPalette gained a typed Commands group (6 reviewer verbs wired
  in App.svelte to the same handlers as the chords). Verified on native daemon;
  80 web test files pass.
- 2026-07-12 (9da4229): **attn-hg5 DONE.** Truth Rule: overlay slots display:none
  at data-state=closed (unlayered, beats tw-animate) — ghost-modal P0 fixed and
  verified (dialog unmounts, no click-block, on occluded window). theme.ts flips
  atomically. DESIGN.md: Truth Rule, Topmost-Escape, Wide-Sheet named rules +
  micro 2px radius token. NOTE: native --screenshot after theme flip may still
  show stale paint (repaint freeze on occluded windows) — force repaint before
  screenshotting; interaction is now safe regardless.
- 2026-07-12 (f880a23): **attn-ll9 DONE.** Review-component retint (109 blue
  fallbacks purged, px→ramp, radii, monograms, stripe→wash, presence colors →
  brand hues) + rail restyled to paper-margin look + hug/retreat implemented in
  WorkspaceEditorFrame with IntersectionObserver+ResizeObserver+MutationObserver
  (NO scroll listeners — James asked for this; layout reads only on resize/
  mutation). Note: ReviewMargin already had anchor-aligned scroll-tracked cards;
  ll9 was retint+hug only. Suites green (80 web files, test:review 0 FAIL).
- 2026-07-12 (78359b0): **attn-5bq DONE.** Draft caches (Escape keeps work,
  Cancel/submit clear), scroll-tracking popovers via shared rAF tracker
  (popover-anchor.svelte.ts, mount-scoped listeners), live ledger diff in
  replace mode. svelte-check clean, tests green.
- 2026-07-12 (d7b5705): **attn-cjn DONE** (staging #new P0): idempotent #new
  (reuses empty Untitled), desk-count localStorage beacon -> landing hero+nav
  CTA 'Your desk (N)' for returning users, auto-name from first H1 on durable
  autosave commit. Behaviorally verified in headless Chromium vs real service;
  route-bundle gate holds. Filed remaining: attn-ri1 (#join modal), attn-9ua
  (hosted owner rail P0), attn-5j5 (landing sweep). Also open: attn-3dv.
- 2026-07-12 (prev): **attn-6d2 DONE** (checkbox persistence P0): toggle was
  mousedown-only; keyboard/AT/synthetic activation never persisted. Moved to
  click path, disk write verified. REMAINING: attn-3dv (journal revert, Rust),
  hosted owner review rail P0 (comment arrival + visible mailbox errors),
  hosted #new idempotency + state-aware CTA + auto-name + #join modal, landing
  sweep (stripes/heading-skip/11px/dead cards), design.json sidecar refresh,
  then /impeccable critique x3 with >=35/40 gate.
- 2026-07-12 (168f9ae): **attn-e4l DONE.** Desk rows say 'Shared · relay sees
  only ciphertext' (decision #2); share-error copy gains 'Nothing left this
  machine.' Native ShareDialog shape already matched e4l. Remaining queue:
  attn-3dv (journal revert) + unfiled P0s (checkbox persistence, hosted owner
  rail, #new/#join, landing) + 3 re-critiques >=35.
- 2026-07-12 (9d27c7c): **attn-u5c DONE.** Save chip in ReviewBar (dirty/saved,
  role=status) + document.title tracks the file. Verified live. Note: native
  mode defaults to 'edit' (App.svelte:134); saves are explicit via saveEdits(),
  not a background debounce.
- 2026-07-12 (0864528): **attn-5e7 DONE.** base.css + prosemirror.css carry the
  wide-sheet split (prose 72ch, wide blocks full-pane, left-set), token-fed fonts/
  selection/motion, restored list markers, global ink scrollbars, semantic z
  ladder (grain 40, mermaid modal 70), reduced-motion designed alternative, no
  transition:all. Verified native render. Next by value: attn-n9j (palette ⌘K +
  keyboard.ts:133 guard fix), then attn-hg5 (Truth Rule → fixes ghost-modal P0),
  then remaining components (ll9/5bq/e4l), then unfiled P0s (checkbox persistence,
  hosted owner rail, #new/#join, landing sweeps), then re-critiques ≥35 ×3.
