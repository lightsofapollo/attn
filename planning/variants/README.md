# Design variant review

> **Status:** proposal / under review. Not yet broken into beads.
> Read this folder in order: **README → format → plan**.

Ship rendered **design variants** (real HTML + CSS + images) back and forth
between a human and an agent (or two people), flip between them, and **comment on
the actual rendered artifact** — not a screenshot, not a Figma frame that lies
about the implementation.

This is the use case that gives the [HTML annotation epic](#relationship-to-the-html-annotation-epic)
(`attn-61t`) a reason to exist: annotation is the substrate, *variant review* is
the product.

## The loop we're actually building

```
Claude generates N variants  ──►  drops them in a dir  ──►  attn shows a toggle
        ▲                                                          │
        │                                                          ▼
   revises a file  ◄── reads `attn comments --json` ◄──  human flips + annotates
```

The `frontend-design` skill lives in **this repo** and already emits distinctive,
self-contained HTML designs. The natural pipeline is: *"design me three homepage
heroes and put them up for review"* → Claude generates a variant directory, shares
it, returns a link → you flicker through and annotate the rendered CSS →
`attn comments --json` feeds Claude → it revises → the comments survive → you mark
the winner. **The reviewee is often an agent.**

## Why attn specifically

- You review the **real rendered artifact**: live CSS, real fonts, actual
  responsive/interactive behaviour — the thing other tools flatten to an image.
- attn already ships files over an **encrypted room** and (per `attn-61t`) lets
  you comment on rendered text *and* elements.
- attn already **watches files and re-snapshots on save**, so in the loop the
  agent's only job is to *write files* — iteration is just saving.

## Two foundational decisions

1. **A directory is the canonical unit.** A variant set is a folder of real,
   multi-file HTML (`index.html` + `base.css` + `images/`), not a single inlined
   blob. A self-contained single HTML file is just the degenerate one-file case.
   Multi-file is also *architecturally better for comment survival* — see
   [format.md](./format.md#why-multi-file-helps-comment-survival).
2. **The wire format is a JSON file-map carried in the existing snapshot string.**
   No binary snapshot type, no change to the encryption/transport path. A new
   `DocType::VariantSet` tags it. Content-addressed asset blobs (dedup, large
   files) are a deferred upgrade behind a clean seam. See
   [format.md](./format.md#wire-format).

## Relationship to the HTML annotation epic

The work splits into two increments along a clean dependency line:

- **Increment 1 — Viewer + bundle (independent of `attn-61t`).** Open a dir as a
  set, serve it over the origin, toggle UI, file-map snapshot, share + agent CLI.
  Delivers value with *no commenting*: browse/compare/share variants.
- **Increment 2 — Annotate (depends on `attn-61t`).** Per-variant comment
  scoping, agent feedback read-back, decision capture. Layers commenting onto the
  viewer once HTML annotation lands.

You can ship Increment 1 before the annotation epic completes.

## Positioning & non-goals

attn's lane is **UX prototyping / design exploration** — generating and comparing
*variants* of a design that don't exist yet as shipped code, choosing a direction,
iterating fast. The artifacts are **drafts**, and comments must **survive
regeneration** (content-anchored, via the resolver).

That's a different lifecycle stage from [agentation](https://www.agentation.com/),
which comments on **live, real, running (React) apps** — late-stage feedback
mapped back to existing source the agent must discover. Its coordinate/source-file
anchors suit a fixed app; our content-anchors suit churning drafts.

**Non-goal (for now): direct agentation integration.** We focus on attn
primitives instead. Because attn renders *and transforms* its own React variants,
we get reliable source-mapping for free (the `jsxDev` flag — see
[plan.md](./plan.md#react-variants)) — better than reverse-engineering it from a
black-box app — so the integration's main draw doesn't apply to our lane. If attn
later moves toward live-app review, agentation stays available as an *optional
inbound edge bridge* (interop only, never embed — it's PolyForm Shield /
non-compete), but it is explicitly out of scope today.

## Files in this folder

| File | What |
|---|---|
| [README.md](./README.md) | This overview + the vision |
| [format.md](./format.md) | The on-disk format, identity, wire encoding, decisions |
| [plan.md](./plan.md) | Phased delta, increments, bead-mapping, open questions |
| [landscape.md](./landscape.md) | Competitive landscape + what makes attn the ultimate prototype review tool (13-agent, adversarially checked) |
| [prototypes/review-loop-demo.html](./prototypes/review-loop-demo.html) | Interactive demo of the end-to-end loop — click **▶ Play the loop** for the auto-driven walkthrough |

## See also

- `planning/collab/prototypes/html-annotation.html` — the validated annotation UX
- `attn-61t` (beads epic) — HTML document annotation, the substrate
- `planning/collab/data-model.md` — anchors, snapshots, resolver
