# Embedded SVG: Threat Model and Sanitisation Decision Record

**Issue:** attn-vlmz.4.1 (decision) → attn-vlmz.4.2 (implementation)
**Date:** 2026-08-06
**Status:** Accepted and implemented. Re-argued against six named bypass classes
after review — see §6.

| File | |
| --- | --- |
| `web/src/lib/svg-sanitizer.ts` | allowlist sanitiser (DOM-free, unit-testable) |
| `web/src/lib/embedded-svg-view.ts` | DOM builder, post-build audit, sizing, injected CSS |
| `web/src/lib/schema.ts` | `embedded_svg` node, `attn_svg_block` markdown-it rule, serializer |
| `web/src/lib/svg-sanitizer.test.ts` | 74 cases, adversarial |
| `web/src/lib/embedded-svg-roundtrip.test.ts` | 22 cases, byte-exact round trip |

## The report

A document containing raw SVG rendered as literal escaped text in a paragraph —
the reporter saw `<svg preserveAspectRatio="xMinYMin meet"…` as body copy.

The cause is deliberate, not a bug: `web/src/lib/schema.ts` builds the parser as
`MarkdownIt('default', { html: false })`, so markdown-it escapes every raw HTML
run, and the ProseMirror schema has no node that could hold embedded markup even
if it didn't.

The fix is *not* `html: true`. That flag turns every byte of agent- and
peer-authored markup into live DOM. This document is the boundary that has to
exist before any parser flag moves.

## 1. Threat model

### 1.1 Nothing in a document is trusted

attn renders three classes of document and none of them are author-controlled by
the person reading them:

- **Agent-authored files.** The product's premise (`PRODUCT.md`) is reviewing
  documents an agent just wrote. An agent that has been prompt-injected by
  anything it read — a web page, a dependency README, an issue comment — writes
  its payload into the file under review. There is no "local files are trusted"
  tier here; a local `.md` is exactly the output of an untrusted process.
- **Peer documents over a share.** A review share transports the document from
  another machine. End-to-end encryption authenticates the *channel*, not the
  *content*: it guarantees the bytes came from the peer, which is precisely the
  party we are defending against. A malicious or compromised peer is the
  expected case, not the edge case.
- **Pasted / imported content.** The hosted build imports files the user drops
  in, from wherever they came from.

### 1.2 What an injected script gets

**Hosted build (`attn.sh`, `staging.attn.sh`).** The app origin holds room
secrets and content-encryption keys in memory and in browser storage
(`web/src/lib/review/browser-session.ts`, `browser-invite.ts`). Script running
on that origin can read every key the reviewer holds, decrypt every document in
every room they have joined, and exfiltrate to the relay origin that
`connect-src` already permits. This is a total compromise of the product's
central security claim, not a defacement.

**Native build (wry/tao WKWebView).** The webview exposes the `window.__attn__`
IPC bridge to the Rust host. The bridge reaches file reads and writes, the
daemon socket, and share operations. Script here escapes the browser sandbox
into the user's filesystem.

### 1.3 The layers that already exist, and where they stop

| Layer | Hosted | Native app shell |
| --- | --- | --- |
| CSP `script-src` | `'self' 'wasm-unsafe-eval' '<sha256 of theme preflight>'` — no `unsafe-inline`, so injected inline handlers and inline `<script>` are refused (`web/src/lib/hosted/csp.ts`) | **None.** The only CSP in `src/main.rs` is attached to `.html` files served to the sandboxed `HtmlViewer` iframe; the app shell document itself carries no policy |
| CSP `img-src` / `connect-src` | closed to `'self'`, blob:, data:, relay only | none |
| `style-src` | `'self' 'unsafe-inline'` — **inline CSS is permitted** | none |

Two conclusions follow, and they drive the rest of this document:

1. **The sanitiser is the only layer in the native build.** Any argument of the
   form "CSP would catch that anyway" is false on the platform where a bypass is
   worst. Policy must therefore be identical across builds — see §4.
2. **CSP never stops CSS.** `style-src` allows inline styles in the hosted build
   and there is no policy at all natively, so a stylesheet smuggled in through a
   document is unopposed by anything except this sanitiser. That is why `<style>`
   and `class` are refused outright in §3.

### 1.4 Attacker goals in scope

- **Script execution** — `<script>`, `on*` handlers, `javascript:` URLs, SMIL
  animating an attribute into a URL, `<foreignObject>` re-entering HTML parsing.
- **Local file / remote resource disclosure** — DTD external entities (XXE),
  `<use href="http…">`, `<image href="http…">`, CSS `url()`.
- **Passive tracking** — any outbound request at render time tells a third party
  that a named reviewer opened a named document, and leaks their IP. For a tool
  whose pitch is "files never leave your machine", a beacon is a product defect
  even when it executes no code.
- **UI spoofing** — a document-scoped `<style>` element inside inline SVG is
  *not* scoped to the SVG; it styles the whole app. A document could hide the
  share indicator, restyle the accept/reject controls, or paint fake chrome over
  the reviewer's own UI. Likewise `class` would let a document borrow app
  classes. Both are refused.
- **DOM clobbering / ref collisions** — `id` attributes from a document colliding
  with app element ids, or with a second SVG's gradient ids in the same document.
- **Denial of service** — billion-laughs entity expansion, unbounded nesting,
  an SVG that paints over the whole viewport.

### 1.5 Explicitly out of scope

- Rendering-engine memory-safety bugs in WebKit/Chromium's SVG code. Nothing at
  this layer helps; the allowlist reduces surface but is not a mitigation.
- Timing/pixel side channels via SVG filters. Handled bluntly by refusing
  filters entirely (§3), not by analysis.
- Malicious *content* that is merely misleading (a diagram that lies). That is a
  review problem, which is what the product is for.

## 2. Decisions

### D1 — SVG only, not general HTML. Block level only.

General raw HTML stays escaped exactly as it is today. Only a block that
*begins* with `<svg` becomes a rendered node.

Rationale: the reported defect is SVG. General HTML would drag in `<iframe>`,
`<form>`, `<img onerror>`, `<a target=_blank>`, and the entire HTML parser's
quirks-mode behaviour, for no reported user need. Widening later is a small,
reviewable change against a boundary that already exists; narrowing later is a
regression for anyone who came to depend on it.

Implementation: `html: false` **stays**. A custom markdown-it block rule
(`attn_svg_block`, modelled on the existing `front_matter` rule in
`schema.ts`) recognises the one construct we support. This is strictly narrower
than flipping the flag and filtering afterwards — markdown-it never enters HTML
mode at all, so there is no second code path to audit.

The rule fires only when *all* of these hold, and otherwise falls through to
today's escaped-text behaviour:

- the line begins `<svg` (followed by whitespace, `>`, or `/`) at an indent of
  less than 4 (4+ is an indented code block, which wins);
- `state.blkIndent === 0` — top level only, never inside a list item or
  blockquote (this also keeps the serializer's block-delimiter handling simple);
- a matching `</svg>` closes the element, with nothing but whitespace after it
  on its line;
- the line after the close is blank or end-of-document.

That last condition is what makes round-tripping unconditional rather than
best-effort; see D5.

### D2 — Hand-written allowlist sanitiser, no new dependency.

**DOMPurify is not currently a dependency** (checked `web/package.json`), and it
is not being added. Reasons, in order of weight:

1. **It could not be unit-tested here.** `web/` has no vitest and no jsdom; the
   test harness (`web/scripts/run-tests.mjs`) runs each `*.test.ts` as a bare
   Node + tsx process, and Node 22 exposes neither `DOMParser` nor
   `XMLSerializer`. DOMPurify requires a DOM. Adopting it means also adopting
   jsdom purely to test it — and the acceptance criteria require direct unit
   tests with real XSS payloads. A sanitiser whose tests can't run is worse than
   a smaller one whose tests do.
2. **DOMPurify's default output is a string, and that string gets re-parsed.**
   `DOMPurify.sanitize()` parses to a DOM, cleans it, and returns *HTML* which
   the caller assigns back into the page — a serialise→reparse round trip, which
   is exactly the mXSS surface and the reason DOMPurify has itself shipped mXSS
   fixes over the years. This design has no such step (D3). A careful DOMPurify
   deployment can avoid it with `RETURN_DOM_FRAGMENT`, so this is an argument
   about the default path rather than an absolute one — but the default path is
   what gets written.
3. **DOMPurify is built for the general HTML problem.** We deliberately do not
   have that problem (D1). Its value is its long tail of browser-parser
   idiosyncrasies; against a ~25-element SVG subset that value is mostly unspent
   while its configuration surface — which is where DOMPurify deployments
   usually go wrong — is fully present.

**Re-argued after review (2026-08-06), because §1.3 cuts against the original
reasoning.** The finding that the native app shell has *no CSP at all* means the
sanitiser is the only layer on the build that also exposes the IPC bridge. That
genuinely inverts a cost/benefit framed on bundle size: ~20 KB against a 40 MiB
budget is cheap insurance for a surface with no backstop. **The size argument is
withdrawn** — it was the weakest of the three and it is not why this decision
stands.

What the argument does not touch is reason 1 (an untestable sanitiser here) or
reason 2 (the reparse step). And the class of failure it invokes — *hand-rolled
sanitisers are historically where XSS lives* — is real but specific: those
failures are overwhelmingly **blocklist** designs, or **parse-then-clean**
designs that try to repair hostile markup and then re-serialise it. This is
neither. It is deny-by-default with no cleaning step and no serialisation. §6
answers each named bypass class against a line of code.

Two hardenings were added in response rather than a library swap:

- **An independent post-build audit** (`auditConstructedSvg`,
  `web/src/lib/embedded-svg-view.ts`) re-walks the DOM that was actually
  constructed and re-checks every element and attribute against the same
  allowlist tables, plus the SVG namespace and a URL-scheme check. A tokenizer
  or tree-builder defect is therefore no longer sufficient on its own — the
  parser and the audit must fail together. On any violation the block falls back
  to showing its source.
- **A structural regression test** asserting that neither module contains
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`, so the
  no-reparse property cannot be quietly lost later.

If a reviewer still prefers the library, the fallback positions in preference
order are: DOMPurify with `RETURN_DOM_FRAGMENT` and `USE_PROFILES: { svg: true }`
plus jsdom for tests; or gating rendering behind the hosted CSP and leaving
native on escaped text until the app shell has a policy of its own. Both remain
open; neither is needed for the classes in §6.

### D3 — The trust boundary is DOM *construction*, not string filtering.

This is the load-bearing decision.

```
raw source ──▶ tokenizer ──▶ SanitizedNode tree ──▶ createElementNS + setAttribute
              (untrusted)     (allowlist only)      (cannot express <script>)
```

`sanitizeSvg()` returns a **plain data tree** (`{ tag, attrs, children }` /
`{ text }`), never a string. `renderEmbeddedSvg()` walks that tree and builds
real nodes with `document.createElementNS(SVG_NS, tag)`, `setAttribute`, and
`createTextNode`.

Three properties follow, and they are the actual security argument:

- **`innerHTML` is never used, anywhere on this path.** No sanitised string is
  ever handed back to a parser, so the entire class of mutation-XSS (mXSS) —
  where a string survives sanitisation and then *re-parses* into something else
  — is structurally impossible rather than merely defended against. This is the
  failure mode that has broken most sanitiser deployments, including several in
  DOMPurify's own history.
- **A tokenizer bug cannot become script execution.** The builder only ever
  creates elements whose names are in `ALLOWED_ELEMENTS` and only ever sets
  attributes in the allowlist. Even if the tokenizer mis-parses adversarial
  input, the worst outcome is a wrong-looking picture or a rejection, because
  there is no code path that can produce a `<script>` element or an `on*`
  attribute. Parser differentials do not matter because there is only one parser
  and its output is never re-parsed.
- **The allowlist is auditable in one file** with no configuration object, no
  hooks, and no defaults inherited from a library.

### D4 — Sanitise at render time only. Never at parse time.

The ProseMirror document holds the **original source, verbatim**, in
`embedded_svg`'s `source` attribute. Sanitisation happens in the node's `toDOM`, on the way to the screen.

Rejected alternatives:

- *Sanitise at parse time and store the clean form.* The document is what gets
  written back to the user's file. Storing the sanitised form means opening a
  file and saving it silently rewrites the author's SVG — deleting their filters,
  their links, their ids. Unacceptable: attn must never damage a file it merely
  displayed.
- *Store both the original and the sanitised form.* Two representations of the
  same bytes that can drift, doubling document size and adding a synchronisation
  invariant, to save work that is cheap and runs only when ProseMirror builds
  the node's DOM.

Render-time-only also means a future tightening of the allowlist applies
immediately to already-open documents, with no migration.

Sanitisation is on the **receiving** side, which is the only side that can be
trusted to do it. A sender's claim to have sanitised is worth nothing.

The render hook is the node spec's own `toDOM`, not a registered NodeView.
`embedded_svg` is an atom with no `contentDOM`, so ProseMirror already ignores
mutations inside it and rebuilds only when the node changes — the two things a
NodeView would have been added for. Using `toDOM` also means the editor, the
read-only editor (`editable={false}`, which is the actual viewer path — see §4),
and every other `DOMSerializer` consumer such as clipboard copy all render
through one code path with no registration step to forget.

### D5 — Round-trip is guaranteed by construction.

The serializer emits `node.attrs.source` and nothing else:

```ts
embedded_svg(state, node) {
  state.text(String(node.attrs.source ?? ''), false);  // escape=false
  state.closeBlock(node);
}
```

The sanitised DOM is never consulted during serialization, and the sanitiser has
no way to reach the document — it takes a string and returns a tree, with no
reference to the editor state. `state.text(…, false)` (rather than the
single-`write` used by the frontmatter node) preserves interior blank lines and
applies block delimiters per line.

The parse side captures `state.src.slice(state.bMarks[startLine],
state.eMarks[endLine])` — the exact bytes of the source lines, including leading
indentation — so the stored attribute is byte-identical to the file.

The four gating conditions in D1 are what make this total. In particular,
requiring a blank line or EOF after `</svg>` means the block's boundary in the
file always coincides with the block boundary the serializer will re-emit; there
is no case where the node fires and the surrounding blank lines shift. An SVG
that does *not* meet the conditions is not recognised, and its bytes pass through
the unchanged paragraph path — also byte-exact, just not rendered.

Tests assert `serialize(parse(md)) === md` over a corpus including the reporter's
`preserveAspectRatio` case and SVGs whose content is entirely stripped by the
sanitiser (which is the case that would catch any leak of the clean form into
serialization).

### D6 — Native and hosted run identical policy.

No build-time divergence, no `import.meta.env` branch, no "local files are safer"
relaxation.

The tempting relaxation is that the native build opens files the user chose from
their own disk. §1.1 disposes of it: those files are agent output. And §1.3 shows
the native app shell has *no CSP at all*, so it is the build with the least
defence in depth and the most valuable target (filesystem access through
`window.__attn__`). Relaxing there would be exactly backwards.

The existing `htmlViewerSandbox(allowScripts)` split
(`web/src/lib/html-viewer-sandbox.ts`) is not a precedent for this: it governs
whole `.html` *files* the user explicitly opened, rendered inside a sandboxed
iframe on a separate origin with the IPC bridge fenced off. Embedded SVG renders
inline in the app document, with no such fence.

### D7 — Fail closed, and say so.

Anything the tokenizer cannot parse with confidence rejects the **whole** block:
mismatched or unclosed tags, unquoted attribute values, a DTD/DOCTYPE, a CDATA
section, a processing instruction, an unknown named entity, or nesting past a
depth/size cap. The block then shows the raw source in a collapsed
`<details>` — the user loses the picture, never the content.

A block that parses but had content removed renders, with a small
"*n* elements removed" chip. In a security review tool the reviewer should be
able to see that what they are looking at is not the whole of what the author
sent. Silent stripping would let an attacker hide content from a human reviewer
while it stays present in the file the reviewer is approving.

## 3. The allowlist

Matching is **exact and case-sensitive** — SVG is XML, so `clipPath` is a
different name from `clippath`. Nothing is lowercased, which means `<SCRIPT>`,
`<ScRiPt>` and `onLoad` simply fail to appear in the list and are dropped, with
no case-folding logic to get wrong.

### 3.1 Elements — everything else is dropped with its entire subtree

```
svg  g  defs  symbol  use  title  desc
path  rect  circle  ellipse  line  polyline  polygon
text  tspan
linearGradient  radialGradient  stop  pattern  clipPath  mask  marker
```

The root must be exactly one `<svg>`, with nothing but whitespace outside it.

**Refused, with reasons:**

| Refused | Why |
| --- | --- |
| `script` | direct execution |
| `foreignObject` | re-enters HTML parsing — the standard SVG-to-HTML-XSS pivot |
| `style` | inline SVG `<style>` is **not scoped to the SVG**; it restyles the whole app (UI spoofing, §1.4), and CSP's `style-src` permits it hosted and does not exist natively |
| `a` | with fragment-only URLs (§3.2) it can do nothing useful, so it earns no surface |
| `image` | fragment-only URLs leave nothing for it to load |
| `animate`, `animateTransform`, `animateMotion`, `set`, `mpath` | SMIL can animate an attribute *into* a `javascript:` URL, defeating a static value check. No SMIL at all |
| `filter` and every `fe*` primitive | large surface; the documented pixel-stealing side-channel class; not needed by the diagrams this feature exists for |
| `switch` | conditional rendering that depends on `requiredExtensions`/`systemLanguage` makes what a reviewer sees dependent on their environment |
| `metadata` | a hole for arbitrary foreign XML |
| `handler`, `listener`, and all SVG 1.2 event elements | execution |

### 3.2 Attributes

Anything not listed is dropped. `on*` therefore needs no special rule — it is
simply absent — and the tests assert that outcome directly for `onload`,
`onLoad`, `onclick`, `onerror`, and `onbegin`.

**Structural / geometry**

```
id  x  y  x1  y1  x2  y2  cx  cy  r  rx  ry  width  height
d  points  dx  dy  rotate  transform  viewBox  preserveAspectRatio
offset  gradientUnits  gradientTransform  spreadMethod  fx  fy
patternUnits  patternContentUnits  patternTransform
clipPathUnits  maskUnits  maskContentUnits
markerWidth  markerHeight  markerUnits  refX  refY  orient
pathLength  textLength  lengthAdjust  xml:space
```

**Presentation**

```
fill  fill-opacity  fill-rule  stroke  stroke-width  stroke-linecap
stroke-linejoin  stroke-dasharray  stroke-dashoffset  stroke-opacity
stroke-miterlimit  opacity  color  display  visibility  overflow
clip-path  clip-rule  mask  marker-start  marker-mid  marker-end
stop-color  stop-opacity  paint-order  vector-effect  shape-rendering
text-rendering  mix-blend-mode  isolation
```

**Text**

```
font-family  font-size  font-weight  font-style  font-variant  font-stretch
letter-spacing  word-spacing  text-anchor  dominant-baseline
alignment-baseline  baseline-shift  text-decoration  white-space
writing-mode  direction  unicode-bidi
```

**Conditionally allowed**

- `href`, `xlink:href` — **only on `<use>`**, and only matching
  `^#[A-Za-z0-9_.:-]+$`. One rule closes `javascript:`, `data:text/html`,
  `data:image/svg+xml`, `<use href="http…">`, protocol-relative `//evil`, and
  every beacon in §1.4. The scheme check runs *after* entity decoding and after
  stripping ASCII control characters and whitespace, so `&#106;avascript:` and
  `java\tscript:` are caught.
- `style` — kept, but each declaration must pass §3.3. Real-world SVG
  (particularly tool exports, and the reporter's own file) leans on inline
  style, so dropping it wholesale would fail the actual use case.

**Always dropped:** `class` (lets a document borrow app CSS — spoofing),
`xmlns` and `xmlns:*` (we construct nodes in the SVG namespace ourselves; a
document-supplied namespace could only be an attempt to change that),
`xml:base`, `externalResourcesRequired`, `requiredExtensions`,
`systemLanguage`, `tabindex`, `role` and `aria-*` (a document should not be able
to lie to a screen reader about app chrome).

**`id` is rewritten, not merely allowed.** Every `id` is prefixed with a
per-render token (`attn-svg-<n>-`), and every internal reference — `href="#x"`
and every `url(#x)` in a presentation attribute or style declaration — is
rewritten to match. This blocks DOM clobbering against app element ids and also
fixes a plain rendering bug: two SVGs in one document that both define
`id="gradient"` currently paint each other's fills.

### 3.3 Attribute value rules

Applied to every kept attribute, in this order:

1. Decode the five XML predefined entities and numeric character references.
   **Any other `&name;` rejects the whole block** — without a DTD (which we also
   refuse) an undefined entity is an XML error anyway, so this is spec-correct as
   well as safe, and it forecloses entity-obfuscated payloads.
2. Reject the block on any C0/C1 control character.
3. If the value contains `url(`, it must be exactly `url(#id)` after trimming;
   the id is rewritten per §3.2. Otherwise the attribute is dropped.
4. Reject the attribute if the value contains `javascript:`, `vbscript:`,
   `data:`, `expression(`, `-moz-binding`, or `behavior:` after control-character
   and whitespace normalisation. Strictly redundant given rules 3 and the `href`
   pattern — kept as a named, directly-tested backstop.

**`style` declarations** are re-parsed into `prop: value` pairs. The property
must be in a CSS presentation allowlist (the §3.2 presentation and text
properties, plus `transform`, `transform-origin`, `cursor`); the value must match
`^[A-Za-z0-9 #%.,()\-+_/'"]*$` and pass rules 3 and 4; only the function names
`rgb`, `rgba`, `hsl`, `hsla`, `url` may appear. `var()` is refused — it would
resolve against app-controlled custom properties. `@import`, `@media`,
`!important`, comments (`/* */`) and backslash escapes all reject the
declaration. The style attribute is rebuilt from the surviving declarations, so
nothing from the original string is passed through verbatim.

### 3.4 Structural caps

Nesting depth 64, element count 5,000, source length 512 KB. Exceeding any
rejects the block. These bound tokenizer work and stop a document from shipping a
multi-megabyte SVG bomb; they are far above any legitimate diagram.

## 4. Sizing

An SVG must not blow out the reading column, and it must obey the
Shared-Column Rule (`web/styles/prosemirror.css` §"shared content column").

- If the root has `width`/`height` in absolute units but **no** `viewBox`, one is
  synthesized from them and the attributes are dropped, so CSS owns the box and
  the intrinsic aspect ratio comes from the `viewBox` (the same trick as
  `ensureViewBox` in `mermaid-nodeview.ts`).
- An SVG that *did* declare an absolute width keeps it as a `max-width`, so a
  24px glyph is not upscaled to a 960px column. One that declared none — the
  responsive `viewBox` + `preserveAspectRatio` form the bug reporter's file used
  — fills the column, which is what it asked for.
- The container is capped at `min(100%, var(--content-measure))` and centred.
- The SVG is `max-width: 100%; height: auto; max-height: 80vh`, so a tall
  diagram letterboxes under the default `preserveAspectRatio` instead of taking
  the viewport.
- Chrome (the removal chip, the fallback `<details>`) is sized in `em` so it
  tracks `--attn-doc-scale` per the contract at the top of
  `web/styles/typeset.css`, rather than in `rem`, which would follow app chrome.

`.ProseMirror`'s shared-column allowlist is hand-maintained and this block's
container class must eventually be named in it; until then the rules ship in an
injected stylesheet owned by the view module (`ensureEmbeddedSvgStyles()`),
which is a temporary home, not the intended one.

### The viewer path

`web/src/lib/Viewer.svelte` (`article.attn-doc` + `{@html html}`, fed by Rust
comrak) is **not** the read-only path any more — nothing imports it; `App.svelte`
and `BrowserReviewApp.svelte` import only `ImageViewer` and `HtmlViewer`. The
read-only surface is `Editor.svelte` with `editable={false}`, rendering
`.prosemirror-mount.attn-doc` through the same schema. Editor and viewer are
therefore the same code path and need no separate treatment. If `Viewer.svelte`
is ever revived, `.embedded-svg` also needs adding to the
`article.attn-doc > :is(…)` allowlist in `web/styles/base.css`.

## 5. What this does not do

- No inline (mid-paragraph) SVG. Block level only.
- No `<svg>` inside a list item or blockquote.
- No external or `data:` images, no web fonts inside SVG, no filters, no
  animation, no links.
- No general HTML. `<div>`, `<img>`, `<iframe>` stay escaped text.

Each is a deliberate narrowing under D1, and each is a small additive change
against this boundary if a real use case turns up.

## 6. Bypass classes, and the line that stops each

Raised in review of D2. Line numbers are `web/src/lib/svg-sanitizer.ts` unless
stated.

### The general answer: deny by default

Every class below has the same root answer, so state it once. There is **no
cleaning step**. An element is included or it is discarded whole:

```ts
// svg-sanitizer.ts:254
const keep = ALLOWED_ELEMENTS.has(tag);
...
// svg-sanitizer.ts:310 — the element itself
if (!keep) return null;
// svg-sanitizer.ts:299 — its attributes are never even examined
if (!keep) continue;
// svg-sanitizer.ts:362 — and its children are never attached
if (child && keep) out.push(child);
```

and the same for attributes:

```ts
// svg-sanitizer.ts:456
if (!ALLOWED_ATTRIBUTES.has(rawName)) return null;
```

This is why an unrecognised construct cannot survive by being *incompletely*
cleaned — the failure mode of blocklists and of repair-based sanitisers. It also
means `on*` needs no rule of its own: no handler name is in the table. Nothing
has to be enumerated for the property to hold, which is what makes it robust
against constructs that did not exist when it was written.

Since a tokenizer defect could in principle emit a tree that misrepresents the
source, a **second, independent gate** re-checks the constructed DOM:
`auditConstructedSvg` (`web/src/lib/embedded-svg-view.ts:64`) rejects any node
outside the SVG namespace, any element or attribute not in the tables, any name
matching `/^on/i`, and any dangerous URL scheme. Both stages must fail together
for a payload to land.

### 1. mXSS / mutation XSS

**Direction: parse once, build DOM directly. The sanitised result is never
serialised and never re-parsed.** `sanitizeSvg()` returns a data tree
(`{ tag, attrs, children }`), never markup; `buildNode`
(`embedded-svg-view.ts:31`) walks it with `createElementNS` / `setAttribute` /
`createTextNode`. There is no `innerHTML` on the path — asserted by a test that
greps both modules, so it cannot regress.

mXSS requires a round trip in which markup means one thing when serialised and
another when re-parsed. With no serialisation there is no second parse for
anything to mutate *into*. This is stronger than filtering the round trip
correctly: the class is absent rather than defended.

Two shapes are tested anyway, because "no reparse" should be demonstrable, not
just asserted: a comment that fakes a close tag and smuggles `<img onerror>`
after it, and `<style>` wrapping an `<img onerror>`. Both yield trees containing
neither element.

### 2. Namespace confusion

**The document never chooses a namespace; we do.** Every element is created with
`document.createElementNS(SVG_NS, tag)` (`embedded-svg-view.ts:34`) —
unconditionally, with no branch a document can influence. `xmlns` and `xmlns:*`
are absent from the attribute table, so a document-supplied namespace is dropped
before it could be consulted (and could not be consulted anyway). The audit then
independently rejects any node whose `namespaceURI` is not `SVG_NS`.

The specific pivots:

- `<foreignObject>` — not allowlisted; dropped **with its subtree**, not
  unwrapped. Unwrapping is the mistake that would promote HTML children into the
  SVG; `if (child && keep)` at :362 means children of a dropped element are never
  attached to anything.
- `<math>` / `<annotation-xml encoding="text/html">` — neither is allowlisted;
  the whole subtree goes, including any `<svg>` nested inside it to re-enter.
- Prefixed foreign elements such as `<html:script>` — `NAME_CHAR` admits `:`, so
  the name parses as `html:script`, which is not in the table. Dropped.

All three are tested.

### 3. `<use href="#x">` / `xlink:href` fragment references

Four constraints, all in `sanitizeAttribute` (:436–:444):

1. Allowed **only on `<use>`** — `if (!HREF_ELEMENTS.has(tag)) return null;`
   (:440). On any other element the attribute is dropped.
2. Must match `^#[A-Za-z0-9_.:-]+$` (:441). Everything else — `javascript:`,
   `data:`, `http://`, protocol-relative `//` — fails the pattern.
3. Checked **after** entity decoding and control-character stripping, so
   `&#106;avascript:` and `java\tscript:` are caught.
4. The fragment is **rewritten** into the block's own id space:
   `` `#${ctx.idPrefix}${match[1]}` ``.

On the specific worry — a reference resolving to a node allowed for another
purpose — rule 4 is the answer, and it holds even though the prefix
(`attn-svg-<n>-`) is guessable: the rewrite is unconditional, so an attacker
cannot *express* a reference to any id but their own block's. `<use href="#app-root">`
becomes `#attn-svg-7-app-root`, which no app element has. Cross-block references
are impossible for the same reason.

Within its own space, a `<use>` can only clone content that already passed the
allowlist, because that is the only content in the tree. A `<script id="s">`
never gets an id registered, since the element and its attributes were discarded
at :299/:310 — tested.

### 4. Animation elements rewriting a validated attribute

Correctly identified as the reason a static value check is insufficient on its
own. The answer is that **no SMIL element is allowlisted at all**:
`animate`, `animateTransform`, `animateMotion`, `set`, `mpath`, `discard`,
`handler`, `listener` are all absent from `ALLOWED_ELEMENTS` (:82–:89) and
dropped with their subtrees. There is nothing in the rendered DOM that can
rewrite an attribute after the fact.

`<set attributeName="href" to="javascript:alert(1)">` is tested by name, and a
loop covers all six SMIL elements.

### 5. `<style>` inside SVG

**The `<style>` element is not allowlisted** — dropped with its subtree, so
`@import`, `@media`, and selectors reaching outside the SVG never reach the DOM
at all. This matters more than usual precisely because hosted `style-src` permits
`'unsafe-inline'` and native has no policy: CSP would not have stopped it.

Distinguish from the `style` **attribute**, which is kept because real tool-
exported SVG depends on it. It is not passed through: the value is split into
declarations, each property checked against `ALLOWED_STYLE_PROPERTIES`, each
value charset-checked, function names restricted to `rgb`/`rgba`/`hsl`/`hsla`/
`url`, `url()` constrained to `url(#id)` and re-prefixed, and the attribute
**rebuilt from the survivors** (`sanitizeStyle`, :477). Comments, backslash
escapes, `@`, `!important`, `<`, `>`, `{`, `}` and `var()` all drop the
declaration or the attribute. Tested: `@import`, external `url()`,
`expression()`, `-moz-binding`, `url(javascript:)`, comment and escape
obfuscation, and a selector naming an app class.

### 6. Entity expansion / DTD, and `<script>` with a non-standard type

**DTD:** any `<!` construct other than `<!--` rejects the entire block (:345),
and any `<?` processing instruction likewise (:348). That single pair of lines
closes DOCTYPE, `<!ENTITY>` (XXE), internal subsets, billion-laughs, CDATA, and
`<?xml-stylesheet href="evil"?>`.

**Entities:** only the five XML predefined entities and numeric character
references decode; any other `&name;` rejects the block (:411). Numeric
references are range- and surrogate-checked. Since there is no DTD, no entity can
be *defined*, so expansion has nothing to expand — the rejection is also
spec-correct, as a browser would refuse the same document.

**`<script type="…">`:** irrelevant by construction. The **element name** is what
is matched, so `type="module"`, `type="text/plain"`, unknown types and the absent
attribute all behave identically — the element is not in `ALLOWED_ELEMENTS` and
is discarded before its attributes are read. Tested across six type values.

One honest note: a `<script>` whose body contains a bare `<` (`if (a<b)`) makes
the block unparseable to an XML-strict tokenizer and **rejects the whole block**
rather than dropping just the script. That is fail-closed and intended, but it is
a behaviour difference from a lenient HTML parser and is tested as such.

## 7. Test corpus

`web/src/lib/svg-sanitizer.test.ts` asserts on real payloads, not shapes:
`<script>` and case variants, `onload`/`onLoad`/`onerror`/`onbegin`,
`javascript:` in `href` and `xlink:href` including numeric-entity and
tab-obfuscated forms, `<foreignObject>` wrapping `<img onerror>`,
`<use href="http://…">`, `data:image/svg+xml` and `data:text/html` in `href`,
DOCTYPE with an external `ENTITY` (XXE) and the billion-laughs expansion,
`<![CDATA[…]]>`, `<?xml-stylesheet?>`, `<style>@import url(…)</style>`,
`style="width:expression(alert(1))"` and `background:url(javascript:…)`,
`<animate attributeName="href" to="javascript:…">`, `<set>`, `<image onerror>`,
`class` borrowing, `xmlns` overriding to XHTML, id collision between two SVGs,
comment-hidden markup, unquoted and unclosed-tag rejection, and depth/size caps.

Round-trip tests in `web/src/lib/embedded-svg-roundtrip.test.ts` assert
`serialize(parse(md)) === md` for each, including blocks the sanitiser empties
completely.
