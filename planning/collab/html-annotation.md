# HTML document annotation — design note

Status: **locked** (2026-08-04). Phase 0 of epic `attn-61t`.
Prototype: [`prototypes/html-annotation.html`](prototypes/html-annotation.html) (validated UX — do not redesign).
Supersedes: the "Design B / distinct localhost origin" decision recorded on `attn-61t` 2026-06-18. See §1.

---

## Goal

Bring attn's review surface — comments, replies, resolve, and (later) AI suggestions —
to **rendered HTML documents**, for both *text-range* and *whole-element* targets
(including the `cell ‹ row ‹ table` scope chain), with no mode switch.

Read-only HTML *sharing* already ships (`attn-qgd`): `DocType::Html` snapshots publish
over the encrypted transport and reviewers render them. This note covers the missing
half — *annotation*.

Everything from the envelope outward (crypto, relay, WebRTC/WS transports, outbox,
invites, share links, store) is already content-type-agnostic and needs **no change**.
The work is confined to the anchor substrate, the viewer frame, an in-document runtime,
and the shell wiring.

---

## 1. Decision — the runtime lives in the doc frame, which stays an opaque-origin sandbox

**The annotation runtime is injected into the HTML document and runs inside the existing
sandboxed iframe. The shell talks to it over a `MessageChannel` port. The frame keeps
`sandbox="allow-scripts"` *without* `allow-same-origin`, i.e. it stays on an opaque origin.**

The runtime cannot live in the parent: the shell cannot touch the frame's DOM across
origins, so selection, geometry, and highlight painting must happen in-frame. That much
was already settled. What changes is *how the frame is hosted*.

The June design ("Design B") called for serving the shared document from a distinct
`localhost` origin so the frame would have a real, checkable origin. **That cannot work,
because the hosted browser reviewer has no Rust process.** In the hosted build the
reviewer receives decrypted bytes over the encrypted channel and renders them via
`srcdoc` (`HtmlViewer.svelte` content mode; `BrowserReviewApp.svelte`). There is no local
server, no port, and no origin to serve from. Adopting Design B would have supported the
native daemon and left half the product — every browser-side reviewer — unable to comment.

Keeping the opaque-origin sandbox is also *better*, not merely more convenient:

- **One code path.** Injection is a pure content transform on the HTML source, so native
  (`attn://` path mode) and hosted (`srcdoc` content mode) run byte-identical runtimes.
- **Stronger isolation.** An opaque origin has no storage access, no same-origin reads,
  and no cookie jar. A real `localhost` origin would hand the untrusted document *more*
  capability than it has today.
- **No new listener.** Design B required standing up an HTTP server in the daemon —
  new attack surface and port management for no gain.
- **`postMessage` already works.** An opaque-origin frame can `postMessage` its parent;
  `event.origin` is the string `"null"`. Origin checking is therefore useless — but it is
  also unnecessary, because the handshake below binds the channel by *frame identity*
  (`event.source`) and then moves all traffic onto a private `MessagePort` that no other
  content can observe or forge.

### Handshake

1. Shell renders the iframe with the runtime injected into the document.
2. On boot the runtime posts `{ type: 'attn:doc:hello', v: 1 }` to `window.parent`
   with `targetOrigin: '*'` (the only possible value — the shell's origin is not
   knowable from an opaque frame, and the message carries no secrets).
3. The shell handles the `hello` **only** if `event.source === iframe.contentWindow`,
   creates a `MessageChannel`, and transfers `port2` to the frame in a single
   `postMessage({ type: 'attn:shell:init', ... }, '*', [port2])`.
4. Both sides then ignore window-level messages entirely. All protocol traffic runs
   over the port.

The runtime initiates because `iframe.onload` does not imply the injected script has
run, and a shell-initiated poll would race. Binding on `event.source` means a second
frame, a nested frame, or an opened window cannot claim the channel.

---

## 2. Decision — HTML anchors are W3C selectors resolved client-side; Rust never parses HTML

Unchanged from June, and re-validated against 2026 practice.

An HTML anchor carries a **selector set**, all layers written at creation time, following
the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/):

- `CssSelector` — element identity, with ranked fallbacks (most specific first).
- `TextQuoteSelector` — `exact` + `prefix`/`suffix` context.
- `TextPositionSelector` — offsets into the document's canonical text.
- `RangeSelector` — start/end element + offset, for ranges crossing element boundaries.

Resolution happens **in the document frame**, where a real DOM exists. Rust persists and
syncs the selector set as an opaque blob and never inspects it. This is what keeps a
headless HTML parser out of the binary, protecting the size gate (`task check:size`).

Resolution order in-frame, mirroring the markdown resolver's philosophy:
exact quote → normalized quote (whitespace/smart-quote folding) → CSS selector →
fallback selectors → bounded fuzzy quote. Multiple exact matches are disambiguated by
prefix/suffix similarity; an **undisambiguated multi-match resolves to `ambiguous`, never
to a silently-picked occurrence**. This maps onto the existing `ResolvedAnchor`
vocabulary (`exact` / `remapped` / `ambiguous` / `stale`) so the rail's confidence and
staleness UI works unchanged.

### Agent-context block

Each HTML anchor additionally carries a small, agent-legible context block written at
creation time: the target element's tag and ARIA role, the human-readable scope preview
the prototype's breadcrumb already computes (`row 3 · Fuzzy quote · edit-distance match`),
and a short DOM-path breadcrumb.

This exists because attn's whole point is human comments feeding AI suggestions. A comment
that says "this is wrong" is only actionable to a coding agent if the payload also says
*what* it was attached to. Capturing it at anchor time is free; reconstructing it later
requires the document.

---

## 3. Decision — the document frame is untrusted input

**The doc frame may *propose* anchors and *report* geometry. It may never create, mutate,
or resolve review state.** Comment bodies and the submit action originate in shell-owned
UI, always.

The document is untrusted: it is agent-authored, or it arrived from another participant in
a share. Its own scripts share a JavaScript context with the injected runtime, so a hostile
page can tamper with the runtime, read the port, and send whatever protocol messages it
likes. The trust boundary must therefore sit at the shell, not inside the frame.

Concretely the shell:

- treats every inbound payload as untrusted data — validated for shape, clamped for size,
  never `eval`'d, never rendered as HTML;
- opens its own composer for the user to type into, and creates the review event itself;
- never accepts a "create comment", "resolve thread", or "accept suggestion" instruction
  from the frame.

With that boundary, the worst a hostile document can do is raise a Comment pill the user
did not ask for, or misdescribe what a proposed anchor covers. Both are visible in the
shell's composer before the user commits, which bounds the risk to *misleading preview* —
not forged authorship, and not review-state corruption.

## 4. Decision — the document's own scripts keep running

Annotation does **not** disable page scripts. Self-contained AI-generated HTML routinely
depends on charting and animation libraries; a review surface that renders every chart
blank is not a review surface. The alternative (a nonce CSP admitting only the runtime)
was rejected for that reason.

This is safe *given §3* — the frame is already assumed hostile, and the trust boundary
does not depend on the frame behaving. It is recorded as a decision rather than an
oversight so a future reader does not "fix" it.

**This changes the hosted reviewer's posture.** Today the hosted browser reviewer passes
`allowScripts={false}`, so a peer's HTML renders with no scripts at all. The injected
runtime needs `allow-scripts`, so annotating a snapshot turns scripts on there too. The
frame remains on an opaque origin in both cases — no `allow-same-origin` — so the document
still cannot reach the app, the user's files, or any storage; what it gains is the ability
to run its own code inside its own frame. Since §3 already assumes exactly that, the
marginal risk is confined to the document misbehaving *visually* (annoying or phishy
content inside the viewer), which it could already do with static HTML and CSS.

Scripts are enabled **only when annotating**. A shared HTML document being viewed
read-only keeps today's script-free rendering.

---

## 5. postMessage protocol surface

Version-tagged (`v: 1`). Every message is `{ type, v, ...payload }`. Unknown `type`s are
ignored by both sides so the protocol can extend without a lockstep upgrade.

### Document → shell

| type | payload | meaning |
|---|---|---|
| `hello` | `{}` | runtime booted; sent on `window.parent`, pre-port |
| `ready` | `{ textLength, title }` | port live, document indexed |
| `selection` | `{ proposal, rects, caret }` | user selected text; drives the Comment pill |
| `selectionCleared` | `{}` | selection collapsed/lost |
| `scopeHover` | `{ chain, rects }` | block hover; drives gutter pin + scope breadcrumb |
| `scopePicked` | `{ proposal, rects }` | user chose a scope (pin or breadcrumb entry) |
| `anchorsResolved` | `{ results[] }` | resolution status + rects per rendered anchor |
| `geometry` | `{ results[], scrollTop, viewport }` | rects moved (scroll/resize/reflow) |
| `anchorActivated` | `{ anchorId }` | user clicked an overlay chip / pin |

`proposal` is a candidate anchor (§6) — *proposed*, per §3, never authoritative.
`results[]` entries are `{ anchorId, status, confidence?, rects }`.

### Shell → document

| type | payload | meaning |
|---|---|---|
| `init` | `{ theme, anchors[] }` | sent with the transferred port |
| `renderAnchors` | `{ anchors[] }` | full desired-state set; the frame diffs |
| `setAnchorState` | `{ anchorId, state }` | `default` / `active` / `resolved` |
| `focusAnchor` | `{ anchorId, scrollIntoView }` | rail card → document |
| `dismissSelection` | `{}` | composer cancelled |
| `theme` | `{ mode, tokens }` | PAPER/INK switch |

`renderAnchors` is deliberately full-state rather than incremental: the frame owns no
review state, so a diffable snapshot keeps it stateless and makes recovery after a reload
or a hostile-script wipe trivial (re-send the set).

### Geometry and coordinates

The frame reports rects in **its own viewport coordinates**. The shell converts with
`shellY = iframeRect.top + docRect.top`. The frame scrolls internally and the shell cannot
observe that scroll cross-origin, so the frame re-reports on scroll, resize, and on
`ResizeObserver`/`MutationObserver` reflow, throttled to animation frames. The rail's
existing push-down collision layout then runs unchanged on shell coordinates.

---

## 6. Anchor payload shape

HTML anchors reuse the existing `Anchor` envelope and add **one** optional, doc-type-tagged
layer. Markdown anchors are untouched; the new field is `skip_serializing_if = "Option::is_none"`
so existing wire bytes are byte-identical.

- `position` is populated with UTF-8 byte offsets into the document's canonical text
  (`textContent`), matching `canonicalEncoding: utf8-bytes`. For markdown these are source
  offsets; for HTML they are rendered-text offsets. Rust never interprets them for HTML.
  `lineRange` is `[0, 0]` — meaningless for HTML, retained for struct compatibility.
- `quote` and `context` are populated from rendered text and are reused **as-is** — they
  are plain strings with no markdown semantics.
- `block` and `structure` are omitted (they are comrak/heading-path concepts).
- `html` is the new layer: target kind, CSS selector + fallbacks, text position, range
  selector, and the agent-context block of §2.

A whole-element anchor sets `target: element` and fills `quote` with the element's
(truncated) text, so element and text anchors present identically to the rail.

`SnapshotPlaintext::validate` currently *rejects* an HTML snapshot carrying an
`anchorIndex`; that stays true — HTML never gets a Rust-built index. What changes is that
HTML snapshots gain an explicit **annotation capability** flag so the UI can distinguish
"HTML, annotatable" from "HTML, read-only" without inferring it from `anchorIndex`
presence.

---

## 7. What Rust does and does not do

**Does:** persist and sync HTML anchors as opaque blobs; carry them through
`CreateComment` / `CreateSuggestion`; record webview-reported resolution status and emit
`AnchorResolutionChanged`; mark HTML snapshots as annotation-capable at publish.

**Does not:** parse HTML, build an anchor index for HTML, resolve HTML anchors, or apply
suggestions to HTML source. Suggestion *authoring* on HTML is out of scope for v1 —
comments only. The byte-splice apply pipeline is format-agnostic and could support it
later, but "edit the HTML source" is not a coherent gesture from a rendered view, and
resolving that is a separate design problem.

Because Rust cannot verify an HTML anchor, the canonical anchor-index rebuild/verify step
(`manager.rs`, markdown-only today) has **no HTML equivalent by design**. HTML anchors are
explicitly *unverified-by-authority* — the client that authored them is the only party
that ever interpreted them. This is acceptable because an anchor is a pointer, not a
claim: a bad one produces a misplaced highlight, not corrupted review state.

---

## 8. Non-goals for v1

- Suggestions (accept/reject edits) on HTML documents.
- Live co-typing / collaborative editing of HTML.
- Annotating HTML sub-resources (iframes inside the document, shadow DOM, canvas).
- Re-anchoring across *structurally different* revisions of a document. Selector-set
  resolution handles incremental edits; a rewritten page will correctly go `stale`.
