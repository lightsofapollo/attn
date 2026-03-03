# attn v2 — Plan

## What aaaae have (done)

* Rust binary with wry/tao native window (not browser tab)
* Markdown rendering via comrak + syntect with syntax highlighting
* Light/dark/system theming with CSS custom properties
* File watching with 100ms debounced live reload

  Checkbox toggling that writes back to the markdown file
* Headless modes: `--json`, `--status`, `--check`
* Keyboard shortcuts: j/k scroll, g/G top/bottom, space page-down, t theme, q quit, e edit
* Svelte 5 frontend compiled to single HTML file, embedded in binary
* IPC bridge: Rust→JS via evaluate_script, JS→Rust via window.ipc.postMessage
* Basic edit mode (plain textarea, Escape to cancel, Cmd+S to save)

## What's changing

### 1. Single-instance daemon with tabs

Currently `attn plan.md` blocks the terminal and opens a new window every time.

**New behavior:**

```
attn plan.md     # first call: fork daemon, open window, show plan.md, shell returns immediately
attn other.md    # second call: send path to daemon, opens as new tab, brings window to front, exit
attn ./docs/     # opens directory as new tab with sidebar file tree
```

* Unix socket at `~/.attn/attn.sock`
* First invocation: fork, listen on socket, open window
* Subsequent invocations: connect to socket, send file path, exit — new tab added
* Each `attn <path>` call adds a tab; switch between tabs with keyboard shortcuts
* Daemon exits when window is closed
* No dock icon, no menu bar — pure utility window

### 2. ProseMirror replaces dual-mode rendering

Currently: comrak renders HTML for read mode, textarea for edit mode. Two completely different views.

**New behavior:** ProseMirror is the single renderer for both viewing and editing markdown.

* Markdown parsed into ProseMirror document (via prosemirror-markdown)
* Read mode: ProseMirror with `editable: false` — looks identical to current rendered view
* Edit mode: press `e`, ProseMirror becomes `editable: true` — cursor appears, you type inline
* No mode switch flash, no re-render. Same document, just becomes editable.
* Checkbox toggling is native ProseMirror — click toggles the node, serialize back to markdown, write file
* Save: Cmd+S serializes ProseMirror doc back to markdown string, writes to file

**What this replaces:**

* Remove comrak HTML rendering for the window (keep for `--json`/`--status`/`--check` headless modes)
* Remove Svelte Viewer component ({@html} injection)
* Remove textarea editor
* Remove SSR hydration pattern (no more `<!-- SSR_CONTENT -->`)

**What this keeps:**

* Rust still reads files and sends raw markdown to the frontend
* Rust still watches files and pushes raw markdown updates
* Syntax highlighting moves client-side (highlight.js in ProseMirror code block plugin)

### 3. Sidebar with full recursive file tree

When viewing a directory OR a single file, a sidebar shows the file tree.

* **Directory mode** (`attn ./planning/`): tree rooted at `./planning/`
* **Single file mode** (`attn plan.md`): tree rooted at the file's parent directory, file highlighted
* Full recursive tree with collapsible folders (like VS Code)
* All files shown in the listing, but only supported types are clickable/openable
* Sidebar always visible, can be toggled with a keyboard shortcut

### 4. Multi-type file viewer

attn is not just a markdown viewer — it handles the files you find in project directories.

**Supported file types:**

| Type | Extensions | Viewer |
| --- | --- | --- |
| Markdown | .md | ProseMirror (editable) |
| Images | .png, .jpg, .jpeg, .gif, .svg, .webp | Gallery viewer with zoom |
| Video | .mp4, .webm, .mov | HTML5 video player |
| Audio | .mp3, .wav, .ogg, .m4a | HTML5 audio player |

**Unsupported files** show in the sidebar listing but are grayed out / not clickable.

**Gallery mode:** When viewing an image, left/right arrow keys cycle through all supported files in the same directory (not just images — all viewable files). This makes it a file previewer.

**Local file access:** wry custom protocol (`attn://`) maps to the local filesystem so images referenced in markdown (`![](./screenshot.png)`) resolve correctly.

### 5. Rendering pipeline change

**Before:**

```
file.md → Rust (comrak) → HTML string → webview → {innerHTML} → done
```

**After:**

```
file.md → Rust (read) → markdown string → webview → ProseMirror (parse) → rendered document
image.png → Rust (detect type) → webview → <img> with attn:// protocol
video.mp4 → Rust (detect type) → webview → <video> with attn:// protocol
directory → Rust (read dir) → webview → file tree sidebar + content area
```

Rust's role: read files, detect types, watch for changes, serve files via custom protocol, manage tabs. Frontend handles all rendering.

## Implementation phases

### Phase 1: Single-instance daemon

  - [ ] Add unix socket listener in Rust (`~/.attn/attn.sock`)

  - [ ] On launch: try connect to existing socket → send path → exit

  - [ ] On launch (no socket): fork, become daemon, listen, open window

  - [ ] Handle incoming paths: push new tab to webview via IPC

  - [ ] Clean up socket on window close / daemon exit

  - [ ] No dock icon (LSBackgroundOnly or equivalent for wry)

### Phase 2: ProseMirror integration

  - [ ] Add prosemirror-markdown, prosemirror-model, prosemirror-view, prosemirror-state to web/

  - [ ] Create ProseMirror schema matching GFM (headings, lists, task lists, code blocks, tables, blockquotes, links, images, hr)

  - [ ] Create Editor.svelte component wrapping ProseMirror

  - [ ] Parse incoming markdown string → ProseMirror doc

  - [ ] Render in read-only mode (editable: false)

  - [ ] Style to match current typography (72ch column, same font stack, same spacing)

  - [ ] Remove Viewer.svelte, remove comrak HTML from init payload

  - [ ] Register `attn://` custom protocol in wry for local file access (images in markdown)

### Phase 3: Editing

  - [ ] `e` key toggles editable: true/false on ProseMirror view

  - [ ] Cursor appears at click position when entering edit mode

  - [ ] Cmd+S: serialize doc → markdown string → send via IPC → Rust writes file

  - [ ] Escape: discard changes, reload from file, back to read-only

  - [ ] Checkbox click: toggle node, serialize, write file (native ProseMirror)

  - [ ] Visual indicator when in edit mode (subtle border glow or cursor style)

### Phase 4: Sidebar + file tree

  - [ ] Rust: read directory recursively, send tree structure to frontend

  - [ ] FileTree.svelte component with collapsible folders

  - [ ] Sidebar always visible (toggleable with keyboard shortcut)

  - [ ] Tree rooted at opened path (`attn ./planning/` → planning/ is root)

  - [ ] Single file mode: root at parent dir, opened file highlighted

  - [ ] Click supported file → load in main content area

  - [ ] Unsupported files shown but grayed out

  - [ ] Rust: watch directory for new/deleted/renamed files, push tree updates

### Phase 5: Tabs

  - [ ] Tab bar UI at top of content area

  - [ ] Each `attn <path>` call from CLI adds a tab

  - [ ] Keyboard shortcuts: Cmd+W close tab, Cmd+\[ / Cmd+\] switch tabs

  - [ ] Each tab has its own: file path, scroll position, edit state, file watcher

  - [ ] Clicking sidebar file opens in current tab (Cmd+click for new tab)

  - [ ] Close last tab → daemon exits

### Phase 6: Multi-type viewers

  - [ ] ImageViewer.svelte: centered image, scroll/pinch to zoom

  - [ ] Gallery navigation: left/right arrows cycle through all supported files in directory

  - [ ] MediaPlayer.svelte: HTML5 video/audio with native controls

  - [ ] File type detection in Rust (by extension) — send type + content/path to frontend

  - [ ] Router in Svelte: based on file type, render correct viewer component

### Phase 7: Code block highlighting

  - [ ] ProseMirror plugin for syntax-highlighted code blocks

  - [ ] Use highlight.js for tokenization (lazy loaded)

  - [ ] Decorations overlay colored spans on code block content

  - [ ] Language detection from info string (`rust, `typescript, etc.)

  - [ ] Theme-aware (light/dark colors from CSS custom properties)

### Phase 8: Rich content (stretch)

  - [ ] Mermaid diagram rendering (ProseMirror node view with lazy mermaid.js)

  - [ ] Table editing (prosemirror-tables)

  - [ ] Math/LaTeX (prosemirror-math)

## Non-goals

* Not a code editor (use your real editor for .rs/.ts/.py files)
* Not a note-taking app or second brain
* No database, accounts, cloud sync
* No Electron (wry is the runtime)
* No MCP server
* No backwards compat with v1 inline HTML approach

## Key dependencies

| Package | Purpose |
| --- | --- |
| prosemirror-model | Document schema |
| prosemirror-state | Editor state management |
| prosemirror-view | DOM rendering |
| prosemirror-markdown | Parse/serialize markdown ↔ ProseMirror |
| prosemirror-keymap | Keyboard shortcut handling |
| prosemirror-history | Undo/redo |
| prosemirror-commands | Basic editing commands |
| highlight.js | Code block syntax highlighting |

## Architecture after v2

```
┌──────────────────────────────────────────────┐
│ CLI: attn plan.md                            │
│                                              │
│  ┌─ try connect ~/.attn/attn.sock            │
│  │  success → send path → new tab → exit     │
│  │  fail → fork daemon ─┐                    │
│  └──────────────────────┐│                   │
│                         ││                   │
│  Daemon:                ▼▼                   │
│  ├─ unix socket listener                     │
│  ├─ file watchers (one per open tab)         │
│  ├─ custom protocol (attn://) for files      │
│  ├─ wry window                               │
│  │   └─ Svelte 5 app                         │
│  │       ├─ Tab bar                          │
│  │       ├─ Sidebar (recursive file tree)    │
│  │       └─ Content area                     │
│  │           ├─ .md → ProseMirror            │
│  │           ├─ images → Gallery viewer      │
│  │           ├─ media → HTML5 player         │
│  │           └─ unsupported → (not opened)   │
│  └─ IPC: evaluate_script / ipc.postMessage   │
└──────────────────────────────────────────────┘
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| j / k | Scroll down / up |
| g / G | Top / bottom |
| Space | Page down |
| e | Toggle edit mode (markdown files) |
| t | Cycle theme (system → light → dark) |
| q | Quit (close daemon) |
| f | Toggle sidebar |
| Cmd+W | Close current tab |
| Cmd+\[ / Cmd+\] | Previous / next tab |
| ← / → | Previous / next file (gallery/preview mode) |
| Cmd+S | Save edits |
| Escape | Cancel edits / exit edit mode |