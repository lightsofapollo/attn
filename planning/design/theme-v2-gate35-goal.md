# GOAL: every attn surface ≥ 35/40 on /impeccable critique

> Continuation goal after the Theme v2 pass (see `theme-v2-goal.md`). Close the
> remaining gap so the native app, hosted app, and landing all clear 35/40 with
> zero P0/P1. Reference implementation for visuals/behaviors stays
> `planning/design/prototypes/editor-polish.html`. On resume: read this file,
> `bd ready`, and the Progress Log at the bottom.

## Starting scores (final Theme v2 gate)
- Landing **36/40** — already over. Task: hold, no regressions.
- Native **29/40** as-reviewed (+4 verified fixes landed after: checkbox truth,
  save-chip home, CSS-leak scope, ⌘K label). Needs ~+3 real points.
- Hosted **25/40**. Needs ~+10; gated by the desktop editor.

## Work per surface

### Hosted (the crux — attn-vea)
1. **Markdown input rules in the shared editor** (`web/src/lib/Editor.svelte`
   `buildPlugins`): typed `# … ######`, `- `/`* `/`1. `, `> `, ` ``` `,
   `**b**`/`*i*`/`` `code` ``, `---` become real nodes/marks live. The schema
   already supports every one (it parses them from disk); only the live
   input rules are missing — benefits native too. Add `prosemirror-inputrules`
   (tiny first-party pkg; watch the 32 MiB gate + route-bundle gate).
2. **Serif reading register on the hosted desktop editor** — it renders Source
   Sans; apply the serif/72ch reading typography the mobile editor and native
   already use (Read/Do rule).
3. Empty-editor onboarding hint (placeholder: "Start typing — # for a heading").
4. Branded `/s/*` open-failure page (cause + "paste a different link" + path to
   /app) instead of the raw Times fallback.
5. attn-z0t: surface transient dirty→saving→saved (commits already persist).
6. Delete-confirm anchored to its row (not bottom-of-list).

### Native (attn — filed on pickup)
1. Background-settings (ResidentSettings) popover: Escape + outside-click +
   toggle dismissal (currently undismissable — Topmost-Escape rule).
2. Theme flip preserves scroll position (currently resets to top).
3. PAPER code AA: warm-ground-tuned light syntax theme so the keyword clears
   4.5:1 (shiki github-light `fn` measured 3.23:1).

### Landing
Hold at 36. Optional: INK "Two surfaces" panel differentiation; mobile Copy
target ≥44pt. Only if they don't risk regression.

## Hard constraints
No `any`; npm not pnpm; binary ≤32 MiB (`task check:size`); no TURN; no
window.confirm/alert; visibility never depends on animation; shortcuts match
e.code; Escape pops topmost only; WCAG AA by measurement; reduced-motion
designed; wide content spans, prose 72ch. Subagents never run `bd`.

## Verify per surface before done
Native via daemon automation (`npm --prefix web run build` before `cargo build`).
Hosted via headless Playwright over a relay-configured `dist-browser`
(`VITE_ATTN_RELAY_URL=https://relay-staging.attn.sh npm run build:browser`) —
the default build throws BrowserRelayUrlError and mis-scores the editor.
Suites green (web, apply, review E2E, lib). Re-run /impeccable critique on all
three; gate = ≥35/40 each, zero P0/P1. Commit per issue, push at the end.

## Out of scope
attn-3dv UI/protocol half (undo grammar + cross-peer reopen), native mobile,
new features beyond the list above.

---
## Progress log
- 2026-07-12 (5967318): **attn-vea DONE** (biggest lever) — markdown input rules
  (prosemirror-inputrules) + serif .ProseMirror in the SHARED editor. Verified in
  relay build: typed # → serif H1, **b** → bold, - → list, no literal syntax;
  unblocks attn-cjn auto-rename (desk auto-names). Native re-checked serif.
- 2026-07-12 (81e1b0d): **native trio DONE** — ResidentSettings popover Escape+
  outside-click dismiss (was undismissable); shiki light github-light→vitesse-
  light (warmer, on-brand); light code ground 0.885→0.972 near-white card so
  keyword clears AA 3.23→5.21. Verified on daemon.
- 2026-07-12 (68935cf): **hosted polish DONE** — empty-editor placeholder hint;
  branded /s/ review-link error card (wordmark + cause + Go-to-desk, key
  stripped). Verified in relay build.
- 2026-07-12: THREE confirmation design-reviews launched vs current build
  (native @ /tmp/attn-gate-final, hosted relay dist-browser, landing). ON
  RESUME: collect scores, confirm ≥35 each, persist snapshots, final push.
  Deferred (noted P2, low value): native theme-flip scroll reset; attn-z0t
  transient save-state; hosted delete-confirm row-anchoring.
- 2026-07-12: goal created. Found: shared editor has ZERO markdown input rules
  (native reads fine only because it opens a comrak-rendered view; live typing
  wouldn't parse either) — so input rules fix is shared and high-leverage.
  `prosemirror-inputrules` not yet installed. Next: install it, wire the
  standard markdown rule set into buildPlugins, verify on both builds.
