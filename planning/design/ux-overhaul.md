# attn UX/UI Overhaul — "The Identity Walks In"

*2026-07-12 · Derived from the dual-surface impeccable critique (`.impeccable/critique/2026-07-12T14-16-*`). Baseline: both surfaces scored **19/40** (Poor band) — for the same structural reason.*

## The Diagnosis, in One Sentence

attn has a 9/10 brand shell (landing, desk, storage, native reading surface — real editorial identity, nobody calls it AI-made) wrapped around a 4/10 working core: **the identity stops at the door of the room where work happens**, and the behavior layer keeps writing checks the paper warmth can't cash (silent comment loss, ghost modals, checkboxes that revert, dead ⌘K).

Both review agents, working independently on different surfaces, converged on the same verdict: *warm surface* is shipped; *sharp behavior* is not. The 10/10 plan is therefore not a restyle — it is finishing the design where the user actually lives, and making state always truthful.

## What 10/10 Means (acceptance tests, not vibes)

1. **The 5-second test passes in the editor**, not just the landing: a Linear-fluent stranger dropped into the editing surface says "this is a crafted reading instrument," not "shadcn scaffold."
2. **Pixels always equal state.** No UI-visible fact (modal open, comment arrived, file saved, checkbox checked) ever depends on an animation completing or a debounce flushing. Testable: CI screenshot asserts `data-state` vs rendered opacity.
3. **A comment's first 60 seconds are accounted for.** Reviewer posts → owner sees a badge/toast within one sync cycle, on every surface, or sees a first-class error.
4. **Zero foreign vocabulary.** No browser-blue selection, no WebKit focus ring, no shadcn-blue fallback, no candy icon, no teal one-off — every rendered color traceable to DESIGN.md.
5. **⌘K opens the same command palette everywhere** (native + hosted, editor focused or not) and every pointer action has a keyboard path.
6. **Score ≥ 32/40** on re-critique of both surfaces, zero P0/P1 open.

---

## Part 1 — Theme v2: one identity, one source, two rooms

The PAPER/INK identity is *right* — both reviews praised it independently. Theme v2 is not a new theme; it is enforcement, unification, and extension of the existing one into the interaction layer.

### 1.1 One token source (kills the drift at the root)

Today three regimes coexist: `web/src/app.css` (OKLCH, canonical per DESIGN.md), `web/src/hosted/tokens.css` (parallel hex system), and a rogue px/hex regime inside the review components (110+ off-palette hits, `var(--x, #2563eb)` shadcn-blue fallbacks, 9–18px raw type).

- Single `web/src/tokens/` OKLCH source generating both entries (or hosted imports the same file). Cut over, delete the hex file — no compat layer.
- **Fallback rule:** `var()` fallbacks either match the token's real value or are removed. `#2563eb`/`#dc2626`/`#16a34a` disappear from the codebase.
- Review components migrate from raw px onto the DESIGN.md rem ramp and radius scale (detector: 65 type + 39 radius findings are this one cleanup).
- Resolve the dark-mode schism: DESIGN.md is canonical — **INK is the cool blue-black study with steel accent**. Hosted dark (warm brown `#181510`, salmon) migrates to INK so native and web are "the same room at two times of day," not two products.

### 1.2 The interaction layer joins the brand

The identity currently lives only in *static* surfaces. Extend it to everything the hand touches:

- **Selection:** `::selection` = amber wash (comment-anchor family) on PAPER, steel wash on INK. Browser blue is gone everywhere, including the hosted editor and reviewer view.
- **Review marks:** the DESIGN.md vocabulary (ledger-green ins, red-wash del, amber comment anchors, role-hued peer chips) becomes the *only* vocabulary — hosted thread cards drop their blue accents, the Comment pill becomes an anchored, paper-lifted popover (it currently overlaps document text).
- **Focus:** the 2px terracotta/steel ring on *every* focusable — the WebKit-blue leak (native share-retry) is a bug class, not an instance: audit with a keyboard-walk script.
- **Icons:** replace the candy VS Code file-icon pack with monochrome ink-line glyphs + rust accents (worst in INK, where yellow folders glare). One icon style, per the product register.
- **Retire the strays:** teal "Backup recommended" pill → rust-family warning tone; full-width ＋↥↗ unicode glyphs → drawn icons.

### 1.3 Motion signature ("sharp behavior" must be felt)

Both surfaces currently have zero motion at idle — precision reads as *static*. One signature, applied narrowly:

- **120–160ms ease-out-quart** on: dialog/sheet enter, command palette, Saved-chip state change, review-card arrival. Nothing else. No page choreography.
- **The Truth Rule (from the native P0):** animation is enhancement only. `[data-state=closed] { display: none }` in plain CSS; closed dialogs unmount; theme switches are atomic (no transition on the theme flip itself). Modal visibility, input-blocking, and theme state never wait on the animation clock — this is what turned an occluded native window into a soft-lock.
- `prefers-reduced-motion`: crossfade/instant alternatives, kept as a real design, not a global kill.

### 1.4 Typography: the reading column is the product

- **Full-width sheet, capped prose measure (decided 2026-07-12).** The reading surface is NOT a centered narrow column: the sheet is left-set and spans the pane so wide content — mermaid diagrams, tables, code blocks — gets the whole width. Only running prose (paragraphs, lists, quotes, headings) caps at ~72ch for readability. Desktop hosted editor (measured 1078px ≈ 135 CPL, sans!) adopts the mobile reader's serif register with this measure cap; native applies the same split. Scrollbars are thin, trackless, ink-tinted — never a default white gutter.
- Fixed rem ramp per DESIGN.md; the px-regime components (badges, PeerStrip, review cards) fold onto it.
- Hairline link underlines (`text-decoration-color` at 40%) — links currently sit at ~2.4:1 against body ink, a WCAG 1.4.1 fail on color alone.
- Dark muted labels raised to ≥ `oklch(0.62 …)` (currently ~4.4:1 at 0.7rem).
- Ship the paper grain on the native surface (DESIGN.md promises it; only hosted has it) — or amend DESIGN.md. Ship it: it's the cheapest "not a flat webapp" signal we have.

---

## Part 2 — UX plan by loop

### 2.1 Entry & the desk (hosted) — fix the front door

The signature complaint, confirmed and worse than reported: `#new` is a **GET-that-mutates** — the landing's primary CTA (and the *only* mobile CTA) unconditionally mints `Untitled · 1 file · Local only` clones; bookmarks and back-button re-create; empties accumulate forever; `#join` (a third of the entry triptych) is a dead click.

1. **State-aware entry.** Returning visitor with local workspaces: header/hero primary becomes **"Your desk (4)"**, "New workspace" demotes to secondary. First-time visitor keeps the current zero-friction New. Mobile nav gets "Your desk" back.
2. **Idempotent #new.** Reuse the most recent *empty, untouched* Untitled instead of minting; creation becomes an explicit POST-shaped action, never a navigation side effect.
3. **Auto-name from content.** First H1 (or filename) names the workspace on first save; "Untitled" should be a transient state, not a permanent pile. Desk rows gain a one-line content preview + relative time.
4. **#join becomes real:** paste-a-link modal with a one-line explainer — or the card is removed until it exists.
5. **Destructive hygiene:** delete = row-anchored dialog (never below the fold) + 10s undo toast; bulk-select for cleaning the existing Untitled pile. Row actions hit 44px targets on mobile.
6. **One word for the thing.** It is a **workspace** on every surface; "project"/"desk-as-object"/"room" leak out of user-facing copy (room stays in share/protocol contexts only).

### 2.2 The editor — the room gets designed

1. Serif 68ch column (Part 1.4) — the single highest-leverage visual change in the product.
2. **Full markdown behavior:** inline input rules (`**bold**`, `*italic*`, backticks), paste-as-markdown, and **visible list markers** (native currently renders every bullet markerless — 60 indistinguishable lines in DESIGN.md itself). Marker style: small rust dot / en-dash, per identity.
3. **Frontmatter card:** YAML frontmatter parses into a folded, mono-labeled metadata card instead of a wall of serif prose — table stakes for agent-authored docs.
4. **Save truth:** a quiet Saved/Editing chip (hosted already has one; native has *nothing* while a background serializer rewrites files), flush-on-navigate/blur (observed keystroke loss in a 1–2s window), and window title = filename.
5. **Checkbox persistence (native P0):** task-item NodeView joins the write path, or renders read-only. A control that reverts on watcher reload is worse than no control.
6. **Empty state teaches:** ghost hint ("Start typing — # for a heading, ⌘K for commands") replaces the void.

### 2.3 The review loop — the reason attn exists

1. **[P0] The owner sees comments.** Hosted owner editor gets the persistent review rail (the reviewer side already has one), a synced thread count, and an arrival toast; the silent mailbox `400` becomes a visible, retryable error state. Until this ships, the product's one-sentence promise is false.
2. **Local annotation without a room (native P1).** Selection toolbar stops gating on `currentRoomId`: comments/suggestions work on a local doc and upgrade into a room when shared. This makes "private by construction" structural — annotation shouldn't require a relay.
3. **Branded review furniture:** anchored composer popover, amber selection, thread cards vertically aligned to their anchors, DESIGN.md review-card lift shadow.
4. **The reviewer page is a front door:** small wordmark + "What is this?" link (it's the product's viral surface, currently anonymous), and an active empty state — "Select any text to comment" — instead of "No review threads on this file."
5. **Share dialog decompression:** first screen = scope choice + one primary action; delivery mode/permissions/safety live behind Advanced (currently ~12 interactive elements in one modal). Reframe the data-loss warning constructively ("unlikely; here's the one-click backup").

### 2.4 The command system — one spine, both builds

1. **⌘K everywhere.** One command palette (files *and* commands: share, theme, new file, switch workspace, outline jump, resolve thread) on native and hosted. ⌘P stays as an alias.
2. **Fix the guard:** `keyboard.ts:133` `if (editingTarget) return` currently kills ⌘P/⌘//⌘W/⌘[⌘] whenever the always-editable document has focus — i.e. almost always. Global chords (palette, help, nav, tab-switch) move above the guard.
3. **Discoverability:** `?`/⌘/ shortcut sheet reachable from everywhere; chrome shows shortcut hints in tooltips/menus; the theme control becomes a visible two-state PAPER/INK toggle (brand feature — let it be seen), `t` stays as the power path; system appearance honored on first launch.
4. **Palette empty state** shows recents, not "No matching files."

---

## Part 3 — Rollout

Sequenced so trust lands first, identity second, delight last. Each phase re-runs `/impeccable critique` on both slugs; the score is the gate.

**Phase 0 — The product tells the truth (P0s, ~days)**
Owner review rail + arrival surfacing + visible mailbox errors · dialog visibility off the animation clock (`data-state` CSS, unmount on close) · checkbox persistence · flush-on-navigate saves · idempotent `#new` + state-aware entry CTA.
*Gate: comment round-trip demo works owner-side; CI state-truth screenshot test green; no new Untitled clones from normal navigation.*

**Phase 1 — The identity walks in (theme v2 core, ~1 week)**
Single token source, hex file deleted · shadcn-blue fallback purge · serif 68ch editor column both builds · brand selection/focus/review marks · frontmatter card · visible list markers · INK unification (hosted dark → cool blue-black).
*Gate: detector `design-system-color` count < 15 (from 211 combined); editor passes the 5-second test.*

**Phase 2 — Flow (~1 week)**
⌘K unified palette + keyboard-guard fix + shortcut sheet · auto-naming + desk previews + bulk cleanup · #join modal · delete/undo hygiene · vocabulary unification · share dialog decompression · reviewer-page wordmark + active empty state.
*Gate: Alex persona completes open→edit→share→review keyboard-only; heuristics 3/5/6/7 each ≥ 3.*

**Phase 3 — Sharp behavior felt (~days)**
Motion signature (dialogs, palette, saved chip, card arrival) with reduced-motion designs · ink-line icon set · native grain · link underlines + dark-label contrast · type/radius ramp migration of review components · empty states that teach.
*Gate: re-critique both surfaces ≥ 32/40, zero P0/P1.*

### Out of scope (explicitly)
- New features beyond the loops above (no new pieces — this is the integration-finishing pass).
- Rebrand/rename, marketing site restructure (the shell already works).
- Native mobile app work (mobile *web* is covered by the shared fixes).

### Open questions for James
1. **Workspaces vs documents** (hosted): flatten the desk to auto-named documents and materialize "workspace" only on folder import? (Critique Q1 — I lean yes, but it's an IA cutover.)
2. **Owner's default mode:** should the owner's editor default to *suggesting* (like reviewers), with direct-edit as the deliberate mode? (Native critique Q1 — bigger product question, Phase-independent.)
3. INK unification changes the hosted dark look users may have seen — cut over silently or note it?
