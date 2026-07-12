# Variant set — delta plan

The phased implementation delta, sized, with each phase shaped to become a bead.
Read [format.md](./format.md) first for the decisions this plan assumes.

## Sizing summary

The delta is **moderate, and mostly additive**. Risk is concentrated in one place
— turning "a snapshot is a string" into "a snapshot is a directory" — and the
[JSON file-map encoding](./format.md#chosen-json-file-map-in-content) collapses
most of that risk by keeping `content: String` unchanged.

| Unit | Size | New vs reuse |
|---|---|---|
| Open a dir as a set (`DocType::VariantSet`, discovery) | S | new, mechanical |
| Serve the set over origin (scoped `attn://`) | M | extends existing protocol |
| Toggle UI + brief panel | M | overlaps `attn-61t` shell wiring |
| Directory snapshot (file-map pack/unpack/serve, watcher) | M | the real new piece |
| Per-variant comment scoping | S | free from `attn-61t` |
| Agent CLI (share/comments/reply/resolve) | S–M | thin wrappers over existing IPC |

## Two increments

### Increment 1 — Viewer + bundle  *(independent of `attn-61t`)*

Delivers value with no commenting: browse, compare, flip, and share variant sets.

- **V1.1 — Directory-as-set model.** Add `DocType::VariantSet`. Open a directory:
  scan top-level `*.html` **and `*.md`** → variants (a set is heterogeneous —
  markdown and HTML mix freely, each rendered via its own pipeline), read the
  optional `attn:variant` island / frontmatter, order them; `README.md` is the
  brief, every other `.md` is a variant.
  - *Touches:* `src/review/model.rs` (DocType), a new set-discovery module, the
    open/CLI entry in `src/main.rs`.
  - *Done when:* opening a variant directory is recognized as a set with an
    ordered, labelled variant list; a single `.html` still opens as a size-one
    set; markdown/single-HTML open paths unchanged.

- **V1.2 — Scoped origin serving.** Extend the `attn://` protocol handler to serve
  any file under the set root with relative-ref resolution; reject `../`
  traversal. Watch the whole tree; reload on change.
  - *Touches:* the custom-protocol handler (`src/main.rs` region around the
    existing HTML serve), `src/watcher.rs`.
  - *Done when:* a variant referencing `./base.css` + `./images/x.png` renders
    correctly from disk; editing any asset live-reloads; paths outside the set
    root are refused.

- **V1.3 — Toggle UI + brief.** A variant switcher (segmented control, keys 1–9
  to flicker-compare), active variant fills the canvas, `README.md` shown as the
  brief. Styled in PAPER/INK.
  - *Touches:* a new `VariantSetViewer.svelte` + switcher component;
    `web/src/App.svelte` / `BrowserReviewApp.svelte` branching for the set
    doc-type.
  - *Done when:* you can flip between variants by click and keyboard; the brief
    renders; theme tokens match.

- **V1.4 — File-map snapshot (pack/unpack/serve).** Owner: pack the set into the
  JSON file-map `content`. Reviewer: unpack to a temp `ATTN_HOME`-scoped dir and
  serve it via V1.2's path. No change to encryption/transport.
  - *Touches:* `src/review/bootstrap.rs` (snapshot a set instead of a string),
    reviewer reconstruction, reuse V1.2 serving.
  - *Done when:* an owner shares a multi-file set and a remote reviewer renders it
    faithfully (CSS + images intact); round-trips through the existing snapshot
    path.

- **V1.5 — Share + agent CLI (publish half).** `attn share <dir>` →
  **idempotent per directory** (same dir → same room → new snapshots, comment
  continuity). The watcher carries iteration after the initial share.
  - *Touches:* CLI surface in `src/main.rs`, room/share plumbing in
    `src/review/manager.rs`.
  - *Done when:* re-running `share` on a dir returns the same room/URL; saving a
    file produces a new snapshot without a re-share command.

- **V1.6 — React variants.** <a id="react-variants"></a>Render React as a
  prototyping primitive, in two tiers — **both client-side, no transform in Rust**
  (so zero binary-gate impact; same philosophy as client-side anchor resolution):
  - *Tier 2 (priority for our lane) — React source variants.* `.jsx`/`.tsx` files
    in a set are transformed in the doc frame via **esbuild-wasm** (CDN) with
    `jsxDev: true`, deps resolved from **esm.sh**, mounted into the origin frame.
    `jsxDev` injects `__source` (file:line) into every element → **source-mapping
    for free**, feeding V2.2/V2.3 anchoring (no fiber reverse-engineering needed).
  - *Tier 1 (edge) — live React dev-server variant.* A live-URL variant points the
    origin frame at a running dev server; falls out of Design B with ~no new work.
    Lower priority for the prototyping lane (it's the live-app case).
  - *Boundary:* single-entry components + CDN deps only. **No bundler /
    `node_modules` resolver in Rust.** Beyond minimalistic → use a dev server
    (Tier 1).
  - *Depends on V1.2 (serving); independent of the annotation epic.*
  - *Done when:* a `.jsx` component variant renders and mounts from a set; its
    elements carry source locations; a live dev-server URL renders as a variant.

### Increment 2 — Annotate  *(depends on `attn-61t`)*

Layers commenting onto the viewer once HTML annotation lands.

- **V2.1 — Per-variant comment scoping.** Each variant = its own `file_id` =
  its own anchor surface; group `file_id`s under a set; rail shows the active
  variant's comments. Mostly free from `attn-61t`'s file scoping.
  - *Done when:* a comment on variant B never appears on variant A; switching
    variants switches the rail.

- **V2.2 — Agent CLI (feedback half).** `attn comments --json [--since <cursor>]`
  returns per-comment `{ variant, anchor:{selector, quote, label}, body, author,
  threadId, resolved }`. `attn reply <threadId>` / `attn resolve <threadId>`.
  - *Anchors must carry both selector and quote* so the agent can locate and act,
    and so the comment survives the edit.
  - *Normalize across types:* markdown anchors (line/quote/block) and HTML anchors
    (selector/quote) present through one unified read-back shape, since a set can
    mix both.
  - *Done when:* an agent can read structured feedback, act on it, and close the
    thread from the CLI.

- **V2.3 — Comment carry-over across redrafts.** Use `attn:variant` `id` +
  `parent`/`version` so a superseding draft carries prior comments; the
  client-side resolver re-anchors against the new DOM; unresolvable comments
  surface as *needs re-anchor* (existing `AnchorResolutionChanged` machinery),
  never silently lost.
  - *Done when:* editing CSS preserves all anchors; a structural HTML edit
    re-anchors where selector/quote survive and flags the rest.

- **V2.4 — Decision capture.** A per-variant "👍 going with this" recording a
  set-level decision the agent can read to proceed.
  - *Done when:* a reviewer marks a winner; `attn comments --json` (or a sibling
    `attn decision --json`) reports it.

## Dependency spine

```
V1.1 → V1.2 → V1.3
            → V1.4 → V1.5            (Increment 1, no epic dependency)
                       │
            attn-61t ──┤
                       ▼
                     V2.1 → V2.2 → V2.3 → V2.4   (Increment 2)
```

## Explicitly deferred

- **Content-addressed asset blobs (Wire v2):** dedup + large-file efficiency.
  Behind a size-warning seam; defer until base64 bloat actually hurts.
- **Side-by-side / split compare:** toggle/flicker first; split doubles layout +
  anchor-geometry work.
- **Cross-variant anchors** ("prefer A's spacing to B's"): for v1, a comment on
  one variant that mentions the other. A real cross-variant anchor is research.
- **Direct agentation integration:** out of scope — different lifecycle lane
  (live-app review vs UX prototyping); see [README](./README.md#positioning--non-goals).
  Optional inbound edge bridge only, and only if attn later moves toward live-app
  review. We render + source-map our own React variants instead (V1.6).
- **Full React app bundling** (`node_modules` resolution, multi-file module
  graphs, build pipelines): use a dev server (V1.6 Tier 1). attn won't ship a
  bundler.

## Open questions for review

1. **Set layout** — top-level `*.html` = variants is simple but ambiguous if
   someone wants an `index.html` gallery. Alternative: a subdir per variant. Keep
   the flat convention, or support both?
2. **Versioning gesture** — should "new draft" (supersede, carry comments) vs
   "new variant" (sibling) be two explicit agent commands, or inferred from the
   `attn:variant` `parent`/`version` island?
3. **Set grouping metadata** — where does "these `file_id`s are one set" live:
   room-level metadata, an island `set` field, or purely the directory?
4. **Decision capture shape** — a special comment, a distinct event type, or a
   room-level field? Affects V2.4 and the agent read-back contract.
5. **Base64 threshold** — at what asset size do we warn and/or auto-jump to
   content-addressing (Wire v2)?
6. **Increment boundary** — ship V1 (viewer + bundle) standalone first, or hold
   until `attn-61t` so the first release is annotatable?
7. **React deps / offline (V1.6)** — CDN-load esbuild-wasm + esm.sh deps (network
   at view time, zero binary cost), or vendor esbuild-wasm + React for offline
   (a few MB against the 32 MiB gate)? Recommend CDN-first; vendor only if offline
   becomes a real requirement.

## Constraints (from repo conventions)

- No backwards-compat shims — cut over.
- No `any` types in TypeScript — proper types throughout.
- `web/` uses **npm** (not pnpm).
- Svelte 5 runes outside components need the `.svelte.ts` extension.
- Watch the **32 MiB** release-binary gate — the client-side-resolution decision
  keeps a headless HTML parser out of the binary.
- No `./dist/` references — import TypeScript directly.
