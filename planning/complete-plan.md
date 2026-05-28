# Complete plan: In-app HTML file viewing

## 1. Background & current state
attn (Rust wry/tao + Svelte 5) previews markdown/image/video/audio. HTML is
currently `Unsupported` and hidden. Goal: **showcase AI-generated HTML in-app** —
polished, self-contained pages that typically use inline JavaScript, custom web
fonts, and CDN-hosted animation libraries (GSAP, anime.js, Lottie) — while keeping
the user safe.

Existing pieces this builds on:
- `attn://` custom protocol serves any local file (`src/main.rs:526-596`) and
  already returns `text/html` for `.html/.htm` (`mime_from_extension`, `src/main.rs:1608`).
- Non-markdown viewers render via `markdownSourceUrl(path)` →
  `attn://localhost/<abs>` (`web/src/lib/markdown-layer.ts:99`).
- File-type routing lives in `App.svelte`'s `mainContent()` snippet (~`web/src/App.svelte:2408`).
- `FileType` is mirrored in Rust (`src/files.rs`) and TS (`web/src/lib/types.ts:23`).
- Binary-size gate: 32 MiB (CLAUDE.md). This feature adds **no dependencies**.

## 2. Goals / non-goals
**Goals:** display `.html/.htm` in-app (navigable from sidebar/search/tabs);
**run the page's JavaScript** and let it load remote fonts/animation libraries for
aesthetics; do so safely (page cannot write the disk, drive attn, or read other
local files); live-reload on disk change.

**Non-goals (v1):** a strict offline-only mode for untrusted files (future
toggle), editing HTML, comments/suggestions/live-collab on HTML.

## 3. Architecture
Render HTML in a sandboxed `<iframe sandbox="allow-scripts">` pointed at the
existing `attn://` URL. Nothing is parsed or sanitized in Rust/JS — the OS webview
renders and executes it in an isolated opaque-origin frame. Two independent walls
keep it safe: (a) the iframe sandbox isolates the page from the app's DOM/storage;
(b) the app's file-writing IPC bridge is fenced off from that frame (subframe
guard + capability token). A CSP served with HTML responses allows external
fonts/styles/scripts (aesthetics) while forbidding JS from reading local file
bytes (exfiltration). File-change notifications already flow for the active file;
the viewer refetches via a `?v=<mtime>` cache-bust.

## 4. Detailed changes

### Backend (Rust)
- `src/files.rs`
  - Add `FileType::Html` variant (serde `rename_all = "lowercase"` → `"html"`,
    matching the frontend union).
  - `detect_file_type` (`:56`): `Some("html" | "htm") => FileType::Html`
    (extension is already lowercased upstream).
  - `is_previewable` (`:129`): include `FileType::Html`.
  - Extend the unit test (`:347`) with `.html`/`.htm`/`.HTML`.
- `src/main.rs`
  - `tree_node_for_path` (`:1246-1249`): a **second** previewable filter that does
    *not* call `is_previewable`. Add `FileType::Html` (or refactor it to call
    `files::is_previewable` to stop the drift). Missing this makes html appear in
    the initial tree snapshot but vanish from incremental tree-ops.
  - `mime_from_extension` (`:1608`): lowercase the extension (it currently does
    not, unlike `detect_file_type`); add asset types HTML references — `woff2`,
    `ttf`, `mjs`, `avif`, `wasm`.
  - File-serve branch (`:573-579`): strip any `?…` query string before `fs::read`,
    **after** the review-invite / reserved-path checks. Enables `?v=` cache-bust.
  - **CSP header** for `.html`/`.htm` responses (see §5 for the exact policy).
  - **Drop `Access-Control-Allow-Origin: *`** (`:587`) for files served to the
    viewer, to close the canvas-based cross-origin image-read trick. (Relative
    same-scheme subresource loads — `<img>`/`<link>`/`<script>` — do not need CORS,
    so this does not break asset loading.)
  - **IPC capability token:** generate a random per-session token; inject it into
    the **main-frame init payload only** (`build_page_html` /
    `build_initialization_script` → `window.__attn_init__`). The iframe loads the
    user's HTML, never the app payload, so it never receives the token.
  - `build_initialization_script` (`:1482`): **subframe guard** — at the very top,
    if `window.self !== window.top`, neutralize the bridge (`delete window.ipc`;
    define it non-configurable `undefined`; `delete window.webkit`) and skip
    installing `__attn__` / the error handlers. Runs at document-start before page
    scripts.
- `src/ipc.rs` `handle_message`
  - Require the token on **write-class** messages (`edit_save`, `checkbox_toggle`,
    `navigate`, `switch_project`, …); reject messages without it. Read-only /
    diagnostic messages (`js_error`) stay tokenless.

### Frontend (Svelte)
- `web/src/lib/types.ts:23`: add `'html'` to the `FileType` union. (This makes the
  `EXTENSIONS_BY_TYPE` `Record<FileType,…>` require the key — compiler-enforced.)
- `web/src/lib/markdown-layer.ts:3`: add `html: ['html', 'htm']` to
  `EXTENSIONS_BY_TYPE`. `detectFileType` is data-driven — no body change.
- New `web/src/lib/HtmlViewer.svelte` (mirrors `ImageViewer`):
  - `h-full` container; `<iframe sandbox="allow-scripts" class="h-full w-full"
    src={srcWithVersion}>` (iframes have no intrinsic height inside the
    `ScrollArea` in `mainContent`, so fill height like the image/media viewers).
  - Header bar: filename + "Open in browser" (reuse the external-open path the
    navigation handler already provides at `src/main.rs:511-525`).
  - Loading / empty states. Props `path`, `mtime`; derive
    `src = markdownSourceUrl(path) + '?v=' + mtime`.
- `web/src/App.svelte`:
  - `mainContent()` (~`:2408`): add `{:else if activeFileType === 'html'}` →
    `<HtmlViewer …/>` before the `{:else}` unsupported fallback.
  - `applyUpdateContent` (~`:1856-1892`) is markdown-gated and currently drops
    `contentMtimeMs` for an html active file (the watcher *does* ship it,
    type-agnostic, at `src/main.rs:770-781`). Add an html branch recording the
    active file's mtime into reactive `$state` for the viewer's `?v=`.
- Icons: `web/src/lib/CommandPalette.svelte:131` `iconForType` — add `case 'html'`.
  Check `web/src/lib/icon-resolver.ts` / `Sidebar.svelte` for any other
  FileType→icon map (defaults are acceptable).

## 5. Security model — rich, styled JS pages that stay safe
Three independent controls:

1. **Web boundary (iframe sandbox).** `sandbox="allow-scripts"` *without*
   `allow-same-origin` gives the page a **unique opaque origin**: scripts run, but
   the page cannot read the app's DOM/storage/cookies, navigate the top frame,
   open popups, or submit forms (none of `allow-same-origin`,
   `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` granted).

2. **Native boundary (IPC bridge — the most important protection).** wry's
   process-level WebKit message bridge (`window.ipc` / `window.webkit.messageHandlers`)
   is reachable from any frame and reaches handlers that **write files**. Closed by
   the subframe guard (strips the bridge in the iframe) **and** the main-frame-only
   capability token (the iframe never gets it, so write-class IPC is rejected even
   if the guard is somehow bypassed). This is independent of the CSP / network
   policy.

3. **Content policy (aesthetics vs. exfiltration).** The CSP served with HTML
   responses allows pretty external assets but forbids JS from reading local file
   bytes:

   ```
   script-src  'self' 'unsafe-inline' https:;
   style-src   'self' 'unsafe-inline' https:;
   font-src    'self' https: data: attn:;
   img-src     'self' https: data: attn:;
   connect-src https:;        # remote APIs OK; attn: omitted -> no fetch() of local files
   base-uri 'none'; object-src 'none';
   ```

   - Custom web fonts and CDN animation libraries (GSAP, anime.js, Lottie, Google
     Fonts) load → pages look polished.
   - `connect-src` excludes `attn:`, so JavaScript cannot `fetch()`/XHR the bytes
     of any local file. Loading a font/image/script as a resource never exposes its
     contents to JS. With ACAO `*` dropped, the canvas-taint image-read trick is
     also closed.

**Net:** AI-generated HTML runs its JS, uses custom fonts and CDN animation
libraries, and looks great — while unable to write the user's disk, control attn,
or read their local files.

**Residual risk (explicit):** the page can reach the internet (required for
fonts/libs), so a script could exfiltrate data the user types *into that page*.
For showcasing AI-generated HTML this is expected, not a leak. A future
"strict / offline-only" per-file toggle (`connect-src 'none'`, no `https:`) would
cover truly untrusted files.

## 6. Edge cases / integration points
- `find_first_previewable_path` / `findFirstFile` may now auto-open an `.html` as
  a directory's first file — intended once html is previewable.
- `DirectoryOverview` counts only md/image/video/audio — html not counted in the
  summary (cosmetic; add a count if desired).
- Search results carry `fileType: 'html'`; `openPath` routes by type (works).
- `markdownCacheByPath` is markdown-specific; simply unused for html.
- Collab/share chrome is gated on `activeFileType === 'markdown'` → stays hidden
  for html tabs.
- Navigation handler opens non-`attn:`/`data:`/`about:` links (http links clicked
  inside the HTML) in the system browser — desired.

## 7. Phasing
1. **Backend type plumbing** — `files.rs` (enum, detect, is_previewable, test) +
   `main.rs:1246` filter + `mime_from_extension` polish. Compiles; html shows in
   tree/search.
2. **Frontend display** — `types.ts`, `markdown-layer.ts`, `HtmlViewer.svelte`
   (`sandbox="allow-scripts"`), `App.svelte` branch, icons.
3. **Sandbox hardening** — CSP header + drop ACAO `*` + IPC capability token +
   subframe guard. **Land together with enabling `allow-scripts`** so the iframe is
   never shipped with scripts enabled before the bridge is fenced.
4. **Live reload** — query-string strip + `applyUpdateContent` html branch + `?v=`.

## 8. Testing
- `cargo test`: extended `detect_file_type` for `.html/.htm/.HTML`; a test that a
  write-class IPC message without the token is rejected.
- E2E (CLAUDE.md automation): fixture `tests/fixtures/sample.html` with inline JS
  + a remote font/lib reference; open it; `attn --query 'iframe'` asserts the
  viewer mounts; `--eval` confirms the page's script ran but `window.ipc` is absent
  inside the frame; `--screenshot` for visual check.
- Live reload: edit the fixture on disk; confirm the iframe `src` `?v=` bumped.
- `task check:size`: release binary unchanged and < 32 MiB.
- Confirm collab/share chrome stays hidden on an html tab.
