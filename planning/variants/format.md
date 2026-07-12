# Variant set — format & wire encoding

The design-decisions doc. Covers what a variant set *is* on disk, how a variant
keeps its identity across redrafts, and how a directory travels to a remote
reviewer.

## On-disk format

**A variant set is a directory.** Convention:

```
homepage-hero/
  README.md            ← the brief: rendered + commentable (markdown review already works)
  01-editorial.html    ← a variant. <link href="./base.css">, <img src="./images/hero.png">
  02-brutalist.html    ← a variant
  base.css             ← shared across variants
  brutalist.css        ← per-variant override
  images/
    hero.png
  fonts/
    inter.woff2
```

Rules:

- **Top-level `*.html` and `*.md` files are variants**, ordered by filename (the
  optional identity island/frontmatter overrides — see below). A variant is *any
  renderable doc*, not just HTML — attn is already a dual markdown + HTML
  renderer, so a set can mix both freely.
- **`README.md`** (if present) is the *brief* — shown alongside the toggle and
  itself commentable. Every other top-level `.md` is a variant.
- **Everything else** (css, images, fonts, subdirs) is a *served dependency*, not
  a variant. Shared base CSS with per-variant overrides is a first-class,
  encouraged pattern.
- A **single self-contained `*.html`** is just a set of size one with inlined
  assets. Same code path.

### Mixed sets

A set is **heterogeneous** — each variant renders and anchors through its own
existing pipeline; the toggle and per-variant `file_id` scoping don't care about
type:

```
api-surface/
  README.md          ← brief
  spec.md            ← markdown variant  → comrak pipeline, Rust AnchorIndex + resolver
  impl-a.html        ← HTML variant       → origin iframe, client-side selector resolution
  impl-b.html        ← HTML variant
  diagram.png        ← shared asset, referenced by spec.md (![](./diagram.png)) and the HTMLs
  base.css           ← styles the HTML variants (markdown keeps attn's theme)
```

- **Markdown variant** → existing comrak render + Rust resolver (what attn does
  today).
- **HTML variant** → origin-iframe render + client-side resolution (per
  `attn-61t`).
- **Images** → referenced relatively by either; served over the scoped origin
  (so markdown relative images get served too — new vs today).
- **CSS** → meaningfully styles the HTML variants; markdown renders with attn's
  theme. CSS is not arbitrarily applied to markdown.
- **Markdown embedding HTML** within one doc → already works; comrak emits the
  HTML block as an anchor block, so it's just part of the markdown anchor model.

This is a strength, not an edge case: review a markdown spec next to its HTML
implementation next to design mocks, in one room, all commentable.

## Variant identity

Each variant HTML *may* carry a stable identity island in `<head>`:

```html
<script type="application/json" id="attn:variant">
{
  "id": "hero-brutalist",
  "label": "Brutalist",
  "version": 2,
  "parent": "hero-brutalist@1",
  "by": "claude",
  "notes": "Widened gutters, bigger CTA per review."
}
</script>
```

For a **markdown variant**, the equivalent identity lives in YAML **frontmatter**:

```markdown
---
attn_variant: { id: spec-v2, label: "Spec", version: 2, parent: spec-v1 }
---
```

- The island/frontmatter is ignored by rendering and trivial for an agent to emit.
- **`id` is the only field that matters.** It's the anchor key that lets comments
  survive a file rename or a regeneration. Everything else defaults: `label` ←
  filename, `version` ← inferred, etc.
- `parent` / `version` drive comment **carry-over** when a draft supersedes a
  prior one.

## Why multi-file helps comment survival

This is the non-obvious win. Comments anchor to the **rendered DOM** (CSS selector
+ quoted text). When iteration happens in **CSS**, the DOM does not move — so
every anchor stays exactly valid with **zero resolver work**.

> "Make the CTA bigger" → the agent edits `brutalist.css` → the DOM is untouched →
> the comment survives perfectly.

Regenerating a self-contained monolith is exactly the case that *churns*
selectors and orphans comments. Separating style from structure keeps the anchor
surface stable across the visual iteration that dominates design review. So the
directory format is not just convenient — it reduces the one fragile path in the
whole system.

## Serving (local)

Serve the set from a localhost origin via attn's existing `attn://` custom
protocol (the same mechanism `HtmlViewer` path mode already uses for single HTML).
Point the iframe at the set's origin root; **relative refs (`./base.css`,
`./images/hero.png`) resolve for free** as same-origin fetches.

- The watcher watches the **whole tree** instead of one file.
- Hardening: scope the per-set origin to the set root and **block `../`
  traversal** out of it. Standard, cheap.
- This is consistent with **Design B** (origin isolation; shell ⇄ doc only via
  `postMessage`), as defined for the annotation epic.

## Wire format

The snapshot model today (`src/review/model.rs:244`):

```rust
pub struct SnapshotPlaintext {
    pub doc_type: DocType,          // Markdown | Html  → add VariantSet
    pub content: String,
    pub anchor_index: Option<AnchorIndex>,
}
```

A directory has to travel to a remote reviewer, but `content` is a `String`. Three
ways to carry a tree, **staged**:

| Stage | Approach | Cost | When |
|---|---|---|---|
| Local | Files on disk, served over origin. No bundle. | none | solo loop / owner view |
| **Wire v1 (chosen)** | **JSON file-map in the existing `content` string** | ~33% base64 bloat on binary assets | first remote share |
| Wire v2 (deferred) | Content-addressed asset blobs + manifest (dedup; CSS tweak doesn't re-ship images) | most plumbing | when v1 bloat bites |

### Chosen: JSON file-map in `content`

```json
{
  "brief": "README.md",
  "files": {
    "01-editorial.html": "<!doctype html>…",
    "base.css": ".cta{…}",
    "images/hero.png": "data:image/png;base64,iVBORw0KGgo…"
  }
}
```

- `doc_type = DocType::VariantSet` tells the reviewer: parse `content` as a
  file-map, write it to a temp dir under `ATTN_HOME`, serve it over their origin.
- **Zero change to the encryption / transport / persistence path** — `content`
  stays a UTF-8 string. The only genuinely new logic is *pack* (owner) and
  *unpack-and-serve* (reviewer), and the reviewer's serve path is shared with the
  owner's local serve path.
- Text files inline as-is; binary assets as `data:` URIs (base64).
- Clean upgrade seam to Wire v2: swap inline base64 for content-addressed blob
  references behind a size threshold; nothing above this layer changes.

## Anchoring across a set

- The **commentable artifact is each variant's rendered DOM.** CSS/images are
  dependencies, not anchor targets. An `<img>` is anchored as an element (by
  selector + optional alt-text quote) like anything else.
- Each variant HTML is its **own file with its own `file_id`** → comments are
  scoped per variant for free (a comment on B's hero never bleeds onto A). This
  rides attn's existing per-file review scoping (`ReviewFileNav`, multi-file
  rooms — see `attn-67j`).
- HTML anchor *resolution is client-side* (per `attn-61t`): W3C selectors
  (CssSelector + TextQuote + TextPosition + Range) resolved in the doc frame.
  Rust never parses HTML — protects the **32 MiB binary gate**.

## Decisions locked here

1. Directory is canonical; single self-contained HTML is the degenerate case.
2. Top-level `*.html` = variants; everything else = served deps; `README.md` =
   brief.
3. `attn:variant` JSON island; **`id`** is the stable carry-over key.
4. Serve over `attn://` scoped to the set root; block `../`.
5. New `DocType::VariantSet`.
6. Wire v1 = JSON file-map in `content` (base64 binary). Content-addressing
   deferred behind a seam.
7. CSS/asset files are dependencies, not anchor targets; per-variant `file_id`
   scoping is reused, not rebuilt.
