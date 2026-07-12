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
