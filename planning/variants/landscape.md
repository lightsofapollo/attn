# Landscape evaluation — what makes attn the ultimate prototype review tool

> Produced by a 13-agent research workflow (6 landscape categories + 4
> counter-variant deep-dives, web-grounded, June 2026), synthesized and then
> **adversarially critiqued** before this final form. The critique materially
> changed the conclusions — see [Corrections](#corrections-that-change-the-plan).
> Status: for review. Not yet reconciled into [plan.md](./plan.md) or cut to beads.

## Thesis

attn owns one phase the 2026 landscape leaves thin: **structured, persistent
review of real rendered design *drafts* whose reviewee is often an agent,
on-disk, generator-agnostic.**

Everything around that phase is already taken:

- **Generation is commoditized** — v0, Lovable, Bolt, Stitch, Magic Patterns, and
  our own `frontend-design` skill. Not our game.
- **Multiplayer presence + threaded comments are table stakes** — Figma, Framer,
  Liveblocks.
- **"Review the real rendered artifact" is now consensus** — Storybook,
  Chromatic, Bolt, Vercel preview comments.

The defensible core is the **combination** of three things no shipping product
unifies — *not any one in isolation*:

1. **Comments that survive *style-layer* iteration** of churning drafts (the
   honest, narrow version — see Bet 1).
2. **A machine-readable feedback + decision contract** an external agent consumes
   and acts on across sessions.
3. **Local-first, single-binary, generator-agnostic** review of a
   directory-as-set mixing markdown + HTML + React drafts as peers.

attn is the **annotate → converge → survive** half of the agent design loop —
deliberately *not* a generator, *not* a visual editor, *not* a live-app reviewer
(agentation's lane).

## Corrections that change the plan

The critique forced four corrections. These are the highest-value output:

1. **Rescope the headline moat: "survives regeneration" → "survives *style-layer*
   iteration," and make the product ENFORCE it.** Comments survive CSS-only edits
   (the DOM doesn't move). They do **not** survive full regeneration — which is
   exactly the gesture the agent loop produces. The fix: the agent **prefers CSS
   edits**, structural HTML rewrites **auto-route through the existing
   `AnchorResolutionChanged` "needs re-anchor" path**, and we optionally lint/flag
   proposals that would churn structure. Never market "survives regeneration."
   (Our [format.md](./format.md) is already honest here; the new part is
   *enforcement* + never overclaiming in a demo.)

2. **Sequence the substrate before the differentiator.** Two prerequisites are
   currently *assumed* but unbuilt:
   - **The agent-participant runtime is the real P0** — "a Claude agent is joined
     to the room" is treated as existing infrastructure. It isn't: spawn
     lifecycle, where it runs (recommend a persistent owner-side process), how it
     authenticates into the encrypted room, and per-comment generation cost are
     all net-new. The comment→agent *trigger* is **downstream** of this.
   - **Increment 1 viewer + agent-readable comments must work end-to-end first.**
     Prove the core loop (agent drops variants → human flicker/side-by-side +
     annotates → agent reads `attn comments --json` → revises → comment survives a
     CSS edit) before any counter-variant / decision / presence / reactions work.
     "Roofing a house with no walls" otherwise.

3. **A design-review tool cannot omit responsive + stateful review** (both were
   entirely absent):
   - **Responsive / multi-viewport**: a selector anchor can land on a
     `display:none` or restructured element at another breakpoint. Anchors must
     record their **capture viewport**; survival must be defined *across*
     breakpoints; the viewer needs a breakpoint switcher (cf. Polypane).
   - **Stateful / interactive**: hover, modals, multi-screen flows, React
     component state only exist in triggered states. Anchors must record
     **interaction-state**; a reviewer needs a way to reach/anchor a target that
     only exists when triggered. Worst for the React variants we lean on hardest.

4. **Name the real incumbents and the real coupling hazards:**
   - **Chromatic/Storybook** is the closest shipping competitor to Bet 1 (reviews
     real rendered components, story-anchored comments tracked across rebuilds).
     Differentiate on: *generator-agnostic + plain-files-on-disk (no Storybook
     harness) + draft/exploration lifecycle + agent reviewee.* Don't pretend it
     doesn't exist.
   - **Cross-variant CSS coupling**: editing shared `base.css` to satisfy one
     variant silently restyles siblings *and changes the visual meaning of their
     surviving anchors*. Rule: a proposal scoped to one variant edits that
     variant's **own override stylesheet, never shared `base.css`** — applies to
     the *primary agent-edits-CSS path*, not just reviewer proposals.

## Differentiation — what to bet on

Bet on the **combination**, not on any single primitive an incumbent half-owns.

- **Bet 1 (rescoped, honest)** — comments that survive **style-layer** iteration,
  with the product *enforcing* the style layer. The anchoring tech (selector +
  fuzzy TextQuote + context) is **W3C Web Annotation prior art** shipped by
  Hypothesis for a decade — *not* novel. The edge is the **agent-reviewee +
  churning-on-disk-draft context** plus the *discipline* of routing structural
  regeneration through re-anchor.
- **Bet 2 (narrowed)** — the agent is a first-class **reviewee** consuming a
  structured, on-disk, generator-agnostic feedback + decision contract, and the
  reviewer can **counter-propose** into that loop. Machine-readable anchored
  feedback is *not* unoccupied (Chromatic, GitHub API, v0/Lovable/Bolt). The real
  differentiator is the **conjunction**: generator-agnostic + plain files on disk
  + style-layer survival + a durable **signed winner+rationale+graft** record +
  the counter-variant as a *persistent, attributed, multi-variant on-disk
  artifact* rather than an ephemeral chat re-prompt.

**Supporting, not differentiating alone:** local-first / no-accounts /
single-binary (a real buyer segment per Penpot — a positioning asset);
render-the-real-artifact (now consensus); directory-as-set heterogeneity.

**Do NOT bet on:** render speed (Histoire's failed wedge); multiplayer presence
(table stakes); generation (a funded arms race in a different lifecycle stage);
"we invented surviving anchors" (Hypothesis/W3C did); "counter-variant is a
net-new gesture" (v0/Lovable/Bolt ship the gesture — attn ships its *persistence*).

## The counter-variant feature ("maybe like this?")

**Primary authoring path = natural-language intent anchored to the rendered
artifact, materialized by the in-room agent.** Zero-code, reuses attn primitives,
matches "the reviewee is often an agent," and is the only path protected by
style-layer survival. The gesture *"produce a variant"* collapses into *"leave a
comment."* It ships **after** the substrate, not before.

End to end:

1. **Diverge** (Increment 1): the agent drops 3–5 variants into the set dir;
   owner `attn share` (idempotent per dir).
2. **Compare**: reviewer flicker (keys 1–9) *or* **side-by-side**, across
   **breakpoints**, lands on a variant, clicks the hero CTA in the rendered frame,
   presses **Propose**, types *"make this CTA full-bleed, 2× bigger, warm gradient."*
3. **Emit** a `kind:"proposal"` comment carrying
   `{ intent_text, anchor:{selector, quote, viewport, state?}, css_delta? }`,
   scoped to that variant's `file_id`, on the same anchor model + resolver as any
   comment. Thread records `respondsToThreadId`.
4. **Instant preview**: a client-side **CSS-override injector** in the doc frame
   applies any `css_delta` immediately so the reviewer flickers base ↔ proposed
   with no agent round-trip and zero DOM churn. Pure web, zero binary cost.
   *Security:* injected CSS runs in every participant's Design-B frame — same
   XSS-class surface as reviewer markup → same gating (render-behind-explicit-click,
   capability scope).
5. **Trigger**: a daemon on-new-comment hook / `attn review watch` wakes the
   in-room agent (downstream of the agent-participant runtime).
6. **Materialize, style-layer-constrained**: the agent reads the proposal via
   `attn comments --json`, **prefers a CSS edit** to that variant's *own override
   stylesheet* (never shared `base.css`). A genuine new direction → a child
   variant with an `attn:variant` island `{ id, parent, version+1, by, notes,
   from_thread }`; structural rewrites route through "needs re-anchor." **Default
   SUPERSEDE for tweaks** (carry comments), **SIBLING only for genuine alternatives.**
7. **Render** in the same toggle, nested under its parent, chipped with provenance
   ("from Jane's proposal").
8. **Converge**: reviewer compares and hits "going with this" — a signed
   **set-level `DirectionChosen`** event whose rationale can cite the README brief
   criteria. Agent reads `attn decision --json` and builds against a frozen target.
   Honest authorship: `EventAuth.createdBy` = who decided; `attn:variant.by` = who
   authored.

**Secondary/bounded:** (b) markdown-text variants get track-changes proposals via
suggesting-mode; (c) duplicate-and-hand-edit is the coder fallback (free via
watcher). **Declined:** a full visual CSS editor (Lovable/Onlook lane) — net-new,
pressures the binary gate, re-opens HTML-parsing-in-Rust, out of lane.

**Reviewer→owner write-back is deferred and resized to P3/L** (not M): a
human-reviewer-authored variant must live as copy-on-write room/snapshot proposal
state until the owner *adopts* it (the non-goal is remote participants mutating the
owner's disk). That's the full `SuggestionCreated→SuggestionAccepted` pipeline at
whole-artifact scale + a new `Capability` variant. **For v1 the *agent* is the
writer on the owner side, so no new transport is needed.**

## Prioritized features

| # | Feature | Pri | Eff | Differentiating? |
|---|---|---|---|---|
| 1 | **Agent-participant runtime + cost model** (spawn/where-it-runs/auth/cost) | **P0** | L | Shape, yes — and the true unbuilt prerequisite |
| 2 | **Increment 1 substrate proven E2E** + agent-readable comments | **P0** | L | The combination is; viewer mechanics are table stakes |
| 3 | **Agent feedback contract** `comments --json` {anchor:selector,quote,viewport,state}, normalized md/html/react | **P0** | S | As a conjunction, not as "an agent can read it" |
| 4 | **Style-layer survival enforcement** (prefer CSS; route structural churn to re-anchor) | P1 | M | The *discipline* is the edge, not the anchoring tech |
| 5 | **Responsive / multi-viewport review** (viewport switcher; anchors record viewport) | P1 | M | Yes, in this lane |
| 6 | **Counter-variant primary path** (NL intent → agent child variant + CSS-delta preview) | P1 | M | In *persistence/attribution*, not the gesture |
| 7 | **Set-level scope** (room `setId`; migrate event log off per-FileId) | P1 | M | Internal prerequisite, not user-facing |
| 8 | **`DirectionChosen`** signed set-level event (winner+rationale+grafts) + `attn decision --json` + freeze | P1 | M | Yes — no design tool emits this for a generative loop |
| 9 | **Comment→agent trigger** (on-new-comment hook / `attn review watch`) | P1 | M | Makes the loop feel live; downstream of #1 |
| 10 | **Side-by-side / overlay compare**, co-equal with flicker | P1 | M | Table stakes; flagged because draft over-committed to flicker |
| 11 | **Brief-as-rubric** (contract + decision cite README criteria) | P2 | S | Lightweight, rare in agent-design tools |
| 12 | **Stateful / interactive anchoring** (record interaction-state) | P2 | L | Partly research; scope minimally |
| 13 | **Cross-variant CSS coupling guard** (edit per-variant override, not base.css) | P2 | S | Safety discipline from the multi-file insight |
| 14 | **Presence** (variant-aware + agent chip; ephemeral, configurable subset) | P2 | L | Mechanism is table stakes; *variant-aware* framing differs |
| 15 | **Reactions** (emoji/thumbs, optimistic) | P2 | S | Table stakes — match, don't lead |
| 16 | **Lineage-aware toggle** (provenance chips, collapse nesting, soft cap ~3–5, elimination-first) | P2 | M | Mild anti-overload edge |
| 17 | **Reviewer→owner write-back** (`propose_variant` capability; copy-on-write; owner adopts) | P3 | L | GitHub-suggestions at artifact scale; heavy, defer |
| 18 | **Thin optional MCP edge** — *only via explicit non-goal amendment* | P3 | M | See risks; this reverses `goals.md` |

## What to drop / defer outright

- **DROP: pairwise Bradley-Terry ranking + LLM-judge pre-sort** — recommendation-
  engine drift, "only worth it at scale," contradicts the intimate 2-party lane.
- **DROP: the "Vercel has the data but refuses to expose it" line** — speculation
  about a competitor's internals; can't anchor a moat.
- **DEFER (decision, not feature): MCP.** This is a genuine **non-goal reversal**
  (`goals.md`: "No MCP server"; "The CLI is the Product"), not additive interop.
  The category standardized on MCP in 2026 (agentation/BugHerd/Userback/Canny/
  Subframe/Builder), so reach is real — but if pursued it needs an explicit
  documented amendment and stays a thin edge over the same `--json` contract.
  Recommend deferring the decision.

## Top risks

- **Headline-claim risk** — selling the easy case (CSS edit) as the hard case
  (regenerate). Mitigation: rescope + enforce (correction #1).
- **Substrate-before-differentiator** — designing counter-variant/decision/
  presence before Increment 1 exists. Gate them.
- **Agent-runtime-assumed** — the trigger was ranked P0 but its prerequisite
  runtime is unbuilt. Build the runtime first.
- **Responsive + stateful gaps** — fatal for a design tool if omitted.
- **Cross-variant `base.css` blast radius** — restyles siblings, changes the
  meaning of their surviving anchors.
- **React-path reliability** — esbuild-wasm + esm.sh are runtime CDN deps,
  single-entry only; the preview loop sits atop the shakiest renderer.
- **Set-identity migration** — per-FileId event log vs set-level decisions; a real
  data-model change, not a footnote.
- **Lane creep into a visual editor**; **convergence/choice overload**;
  **authorship ambiguity** (human intent realized by agent); **MCP non-goal reversal**.

> The critique found **no 32 MiB / Rust-bundler violation** — esbuild-wasm/esm.sh
> stay client-side, the CSS injector is pure web, no Rust HTML parser. The
> binary-discipline of the plan is its strongest quality.

## How this resolves existing open questions

- **plan.md Q#1 (set layout):** keep flat top-level `*.html` canonical, reserve
  `index.html` as gallery/entry (not a variant), allow optional subdir-per-variant
  for the large case.
- **plan.md Q#2 (supersede vs sibling):** default SUPERSEDE for tweaks, SIBLING
  for genuine alternatives; soft cap ~3–5; elimination-first convergence.
- **plan.md Q#4 (decision shape):** `DirectionChosen` as a first-class signed
  set-level append-only event keyed by `setId` — `{ winnerVariantId (stable id,
  not filename), rankedOrder?, grafts?, rationale }` + `attn decision --json` +
  freeze. **Not** a per-variant thumbs reaction.
- **plan.md Q#7 (React offline):** CDN-first; vendor only if offline becomes a
  requirement — decide *before* the counter-variant preview leans on React.

## New open questions

- Agent runtime: where does `kind=agent` run, how does it auth into the encrypted
  room, and what's the per-comment generation-cost ceiling before the loop stops
  feeling interactive?
- Responsive: how does an anchor encode its capture viewport, and what's the UX
  when a comment's target doesn't resolve at another participant's viewport?
- Stateful: v1 anchor only to the currently-rendered state (recording which), or a
  minimal capture-state-then-anchor gesture from the start?
- Confirm v1 ships **agent-as-writer only** (no reviewer→owner write-back)?
- How minimal can `css_delta` be — pure typed intent for v1, preview only when the
  agent returns a CSS edit?
- Multi-decider rooms: who may emit a binding `DirectionChosen`, and the tie-break?
- Brief-as-rubric: does the brief need machine-readable criteria, or is free-text
  rationale citing it enough for v1?

## See also

- [README.md](./README.md) · [format.md](./format.md) · [plan.md](./plan.md)
- `planning/goals.md` (CLI-is-the-product / No-MCP stance), `planning/differentiation.md`
- `planning/collab/data-model.md` (anchors, snapshots, suggesting-mode, non-goals)
