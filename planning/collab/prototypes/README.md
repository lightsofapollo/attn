# HTML annotation prototype

A self-contained visual prototype of **commenting on rendered HTML** in attn —
both *text-range* comments and *whole-element* comments — styled with attn's
real PAPER/INK tokens and `ReviewMarginCard` look so it reads as in-context.

## View it

`file://` is blocked for the CSS Custom Highlight API, so serve it (this also
mirrors the real **design B** — doc served from a distinct localhost origin):

```bash
cd planning/collab/prototypes
python3 -m http.server 7843
# open http://127.0.0.1:7843/html-annotation.html
```

## What it demonstrates

- **Two anchor gestures, no mode switch** — both are always live:
  - *Select text* → floating "Comment" pill → composer → gold highlight + rail card.
  - *Hover any block* → a comment pin appears in the left margin gutter; hovering it
    outlines exactly what will be anchored (with its CSS selector) → click → blue
    element pin + rail card. An active text selection suppresses the gutter pin, so
    the two gestures never conflict.
  - *Nested targets (cell ‹ row ‹ table)* — the gutter pin defaults to the
    **row** (a horizontal band fits the gutter like a line comment), and hovering
    the pin opens a **scope breadcrumb** so you can drill *into* the specific cell
    or *out* to the whole table. Each scope shows its selector + a human preview
    (`row 3 · Fuzzy quote · edit-distance match`, `Confidence: 0.50–0.75`) and a
    count of comments it already carries. Widen the `SCOPE` set to add list items,
    `<dt>/<dd>`, etc.
  - *Overlays never trap the cursor* — an element overlay's fill is
    `pointer-events: none`, so you can still select (and comment on) the text or
    nested elements underneath a commented element. Only its small tag/count
    chips are interactive — they're the handle for focusing that thread.
  - *Comments inside an already-commented element* — multiple comments on one
    element share a single overlay with an **N badge** (not stacked duplicate
    boxes). A cell comment lands inside its commented row as a smaller inset box
    drawn *above* the row band, so both read at once; the breadcrumb and the
    gutter-pin pip surface the existing counts before you add another. Seeded
    example: an agent comment on the *Fuzzy quote* row plus a separate comment on
    that row's *Confidence* cell.
- **Non-destructive highlights** via the **CSS Custom Highlight API** (`::highlight()`),
  with a base bucket (`attn-text`) and a brighter active bucket (`attn-text-active`) —
  no wrapper spans injected into the document.
- **Google-Docs margin rail**: cards align to their anchor's Y with push-down collision
  layout; hover/focus links card ⇄ highlight/overlay and draws a connector line.
- **PAPER / INK** themes (toggle, top-right), paper grain, Source Serif/Sans/Code.
- Seeded threads from owner / reviewer / agent so the rail looks populated immediately.

## How this maps to the real integration

| Prototype piece | Real attn counterpart |
|---|---|
| Text highlight buckets | `prosemirror/review-decorations.ts` → an HTML decoration layer |
| `selectorFor(el)` element anchor | W3C `CssSelector` (Apache Annotator `dom`) → new `Anchor` layer |
| Text range anchor | existing `quote`/`position` layers (TextQuote/TextPosition) |
| Rail cards | reuse `ReviewMargin` / `ReviewMarginCard` unchanged |
| Composer popover | `CommentComposer.svelte` |
| localhost origin tag | doc served from a distinct origin; shell ⇄ doc via `postMessage` |

The four currently-missing production pieces this previews: an HTML anchor substrate
(`bootstrap.rs:1467` is `None` today), selection bridging across the doc origin,
mounting `ReviewMargin` for HTML (hidden at `BrowserReviewApp.svelte:286`), and HTML
collab seeding (gated on `anchorIndex` presence).

> Prototype only — vanilla JS/CSS, no build, not wired to the Rust backend or collab layer.
