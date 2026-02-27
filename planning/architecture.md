# attn — Architecture

## Overview

```
┌──────────────────────────┐        IPC         ┌──────────────────────┐
│     Rust CLI Binary      │◄──────────────────►│   wry Window         │
│                          │                     │   (WKWebView)        │
│  • CLI arg parsing       │  evaluate_script()  │                      │
│  • File system access    │  ──────────────────► │  • Preact UI         │
│  • File watching         │                     │  • Rendered markdown │
│  • Markdown → HTML       │  ipc.postMessage()  │  • Shiki highlighting│
│  • Plan structure parse  │  ◄────────────────── │  • Mermaid diagrams  │
│  • Beads detection       │                     │  • Sidebar nav       │
│  • Path validation       │                     │  • Keyboard shortcuts│
│                          │                     │  • Edit mode         │
└──────────────────────────┘                     └──────────────────────┘
```

## How It Works

1. User runs `attn plan.md` in terminal
2. Rust binary parses args, reads file, renders markdown to HTML
3. Opens a native window via wry (uses system WKWebView — no bundled engine)
4. Injects pre-rendered HTML into the webview
5. Watches file for changes, pushes updates via `evaluate_script()`
6. User interacts (keyboard shortcuts, sidebar clicks, edits)
7. Frontend sends events back to Rust via `window.ipc.postMessage()`
8. User presses `q` or closes window — process exits, back to terminal

No HTTP server. No WebSocket. Direct IPC between Rust and the webview.

## Rust Side

### Responsibilities

- **CLI**: Parse args via clap (`attn <path>`, `attn --skim`, `attn --check`, `attn --json`)
- **Markdown pipeline**: Parse markdown (pulldown-cmark or comrak), extract plan structure (tasks, phases, file refs)
- **File watching**: FSEvents on macOS via notify crate. Push updates on change.
- **Beads integration**: Detect `.beads/`, shell out to `bd ready --json` / `bd list --json` to get status
- **Window management**: Create wry window, embed web assets, handle IPC messages
- **Headless mode**: `--check`, `--status`, `--json` flags skip the window entirely, output to stdout

### Key Crates

- `wry` — native webview window (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux)
- `clap` — CLI argument parsing
- `comrak` or `pulldown-cmark` — markdown to HTML (comrak has better GFM support)
- `notify` — cross-platform file watching
- `include_dir` — embed web assets in binary at compile time
- `serde` / `serde_json` — IPC message serialization

### Markdown Pipeline

Rust parses markdown and produces:
1. **Rendered HTML** — the visual output
2. **Plan structure** — extracted metadata:
   - Tasks (checkbox items with line numbers)
   - Phases (top-level headers)
   - File references (detected paths like `src/foo/bar.ts`)
   - Progress (checked/total counts per phase)
   - Mermaid blocks (passed through for client-side rendering)

Both are sent to the frontend. The HTML goes into the content area. The structure drives the progress bar, skim mode, and beads overlay.

## Frontend (Preact + Vite)

### Why Preact

- 3KB bundle — embedded in a binary, size matters
- React API — familiar, productive immediately
- Sufficient for the UI complexity (one document, few modes, a sidebar)
- No router needed (single view), no heavy state management (simple signals/state)

### Responsibilities

- **Render HTML** — inject Rust-provided HTML into the content area
- **Shiki** — syntax highlighting for code blocks (runs client-side, loaded lazily)
- **Mermaid** — diagram rendering for mermaid blocks (runs client-side, loaded lazily)
- **Keyboard handling** — j/k scroll, q quit, e edit, s skim, f focus, / search, n/p navigate files
- **Sidebar** — file tree for directory mode, collapsible, searchable
- **Density modes** — skim (headers + first lines), read (full), focus (single section)
- **Edit mode** — swap content area to CodeMirror, save writes back via IPC
- **Checkbox toggling** — click a checkbox in rendered view, send line number + state to Rust
- **Theme** — light/dark, respects system preference, toggleable
- **Transitions** — crossfade between files, smooth scroll restoration

### Build

Vite builds the Preact app to static assets (index.html, JS bundle, CSS).
These are embedded into the Rust binary at compile time via `include_dir!`.
No runtime file serving — everything is in-memory.

## IPC Protocol

### Rust → Frontend (via evaluate_script)

```typescript
// Initial content load
window.__attn__.setContent({
  html: "<rendered markdown>",
  structure: {
    phases: [{ title: "Phase 1", progress: { done: 3, total: 7 } }],
    tasks: [{ line: 14, text: "Implement auth", checked: false }],
    fileRefs: ["src/auth/middleware.ts", "src/db/schema.ts"],
  },
  filePath: "planning/goals.md",
  fileTree: [...],  // directory mode only
})

// File changed (live reload)
window.__attn__.updateContent({ html, structure })

// Bead status overlay
window.__attn__.setBeadStatus({
  tasks: [
    { line: 14, beadId: "bd-a1b2", status: "in_progress" },
    { line: 18, beadId: "bd-c3d4", status: "closed" },
  ],
  progress: { beaded: 4, closed: 2, total: 7 }
})
```

### Frontend → Rust (via ipc.postMessage)

```typescript
// Checkbox toggled
{ type: "checkbox_toggle", line: 14, checked: true }

// File navigation (directory mode)
{ type: "navigate", path: "planning/scope.md" }

// Edit saved
{ type: "edit_save", content: "# Updated content..." }

// Quit
{ type: "quit" }
```

## File Structure

```
attn/
├── planning/              # goals, architecture, design docs
├── Cargo.toml             # Rust workspace
├── src/                   # Rust source
│   ├── main.rs            # CLI entry, arg parsing
│   ├── window.rs          # wry window creation, IPC handling
│   ├── markdown.rs        # markdown parsing, plan structure extraction
│   ├── watcher.rs         # file watching
│   └── beads.rs           # .beads/ detection, bd CLI integration
├── web/                   # Frontend source (Preact + Vite)
│   ├── index.html
│   ├── src/
│   │   ├── app.tsx        # root component
│   │   ├── viewer.tsx     # markdown content display + density modes
│   │   ├── sidebar.tsx    # file tree navigation
│   │   ├── editor.tsx     # CodeMirror edit mode
│   │   ├── keyboard.ts    # keyboard shortcut handling
│   │   ├── ipc.ts         # IPC bridge to Rust
│   │   └── theme.ts       # light/dark theme management
│   ├── styles/
│   │   └── typography.css # the core reading experience styles
│   ├── vite.config.ts
│   └── package.json
├── build.rs               # build script: runs vite, then include_dir!
└── test/
```

## Build Pipeline

```bash
# Development
cd web && npm run dev        # iterate on frontend with hot reload
cargo run -- plan.md         # test full binary (embeds latest web build)

# Release
cargo build --release        # build.rs runs vite build, embeds output
# Result: single binary at target/release/attn
```

## CLI Interface

```bash
# Viewer modes (opens native window)
attn plan.md                 # view a single file
attn ./planning/             # browse a directory
attn .                       # browse current directory
attn plan.md --skim          # open in skim mode
attn plan.md --dark          # force dark mode
attn plan.md --light         # force light mode

# Headless modes (stdout only, no window)
attn plan.md --check         # validate file refs, report stale sections
attn plan.md --status        # print task progress
attn plan.md --json          # structured plan data for agents
attn ./planning/ --status    # progress across all plans in directory
```
