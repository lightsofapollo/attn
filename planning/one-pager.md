# One-pager: In-app HTML file viewing

## Problem
attn previews markdown, images, video, and audio. HTML files are classified
`Unsupported` and hidden from the sidebar/search. We want to **showcase HTML that
an AI has generated** directly inside attn. Such HTML is usually a polished,
self-contained page — inline JavaScript for interactive charts/animations, custom
web fonts, and CDN-hosted animation libraries (GSAP, anime.js, Lottie). So the
viewer must **run JS and load remote fonts/libraries for aesthetics, while staying
sandboxed** so a page can never touch the user's files or the app.

## Proposal
Render `.html`/`.htm` in a native **sandboxed `<iframe>`** that loads the file
through the existing `attn://localhost/<path>` custom protocol — the same URL
mechanism the image/media viewers already use. Use `sandbox="allow-scripts"`
(without `allow-same-origin`) so the page's JS runs in an isolated opaque origin,
and pair it with a CSP that allows pretty external assets but blocks local-file
exfiltration.

## Why this approach
- **Zero new dependencies** → **no impact on the 32 MiB binary-size gate**.
- **Reuses existing infrastructure**: the `attn://` protocol already serves files
  and already returns `text/html`; viewers already route by `FileType`.
- **Native isolation** via the iframe sandbox instead of trusting an HTML sanitizer.
- **Full fidelity** — the HTML renders and runs exactly as authored, including
  custom fonts and CDN animation libraries.

## Running rich, styled JS pages — safely (the headline)
The protections that matter and the things we allow are governed independently:

- **Disk / app safety (most important):** attn's internal IPC bridge can write
  files; it is reachable from any frame by default. We fence it off from the
  viewer iframe with a subframe guard (strips `window.ipc`/`window.webkit` before
  page scripts run) **and** a capability token that only the main app frame
  receives and that write-class IPC requires. The page can run all the JS it wants
  and still cannot write your disk or drive attn. This is independent of the CSP.
- **Aesthetics (fonts, animation libs):** the CSP allows `https:`/`data:` for
  scripts, styles, fonts, and images, so Google Fonts, GSAP, anime.js, Lottie,
  etc. load and pages look polished.
- **No silent theft of your local files:** the CSP's `connect-src` allows `https:`
  (remote APIs) but **not** `attn:`, so JavaScript cannot `fetch()` the *bytes* of
  any local file. Loading a font/image/script as a resource never exposes its
  contents to JS. We also scope `Access-Control-Allow-Origin: *` to the
  markdown/text the app itself fetches and omit it for HTML/image/font assets, so
  the sandboxed iframe can't read local image bytes via a crossorigin
  `<img>` + canvas.

```
default-src 'self' attn: https: data:;
script-src  'unsafe-inline' 'unsafe-eval' attn: https:;  # inline + relative + CDN libs
style-src   'unsafe-inline' attn: https:;
font-src    attn: https: data:;
img-src     attn: https: data:;
media-src   attn: https: data:;
connect-src https:;        # remote APIs OK; attn: omitted -> JS can't read local file bytes
base-uri 'none'; object-src 'none';
```

**Net:** AI-generated HTML runs its JavaScript, uses custom fonts and CDN
animation libraries, and looks great — while being unable to write the user's
disk, control attn, or steal their local files.

## Scope (v1)
- Classify `.html`/`.htm` as a previewable `FileType::Html` (sidebar, search, tabs).
- New `HtmlViewer` component: sandboxed iframe + header (filename, "Open in
  browser") + loading state.
- IPC-bridge hardening (subframe guard + capability token) and the CSP above.
- Live reload on file change (cache-bust the iframe URL).

## Out of scope (v1)
- A "strict / offline-only" no-network mode for fully untrusted files (could be a
  future per-file toggle).
- Comments / suggestions / live-collab on HTML (the review layer is anchored to
  markdown bytes; collab gates already check `activeFileType === 'markdown'`).
- Editing HTML.

## Effort & risk
- Small/medium: ~3 backend files, ~4 frontend files, 1 new component, no deps.
- Main risks (all identified and addressed in the complete plan): a second
  hard-coded previewable filter in `main.rs`; wiring live-reload through the
  markdown-gated update path; getting the bridge fencing + CSP exactly right.

## Residual risk (stated plainly)
Because the page can talk to the internet (needed for fonts/libs), a script could
send out data the user types *into that page*. For showcasing AI-generated HTML
this is expected behavior, not a leak. A future no-network toggle covers the
truly-untrusted case.

## Success criteria
Open an AI-generated `.html` from the sidebar → it renders, its JS runs, custom
fonts and CDN animation libraries load, and it looks polished; embedded scripts
cannot reach `window.ipc`, write files, or read other local files; editing it on
disk updates the view; the binary stays under 32 MiB; collab chrome stays hidden.
