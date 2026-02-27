# attn — Architecture

## Overview

```
┌──────────────────────────┐        IPC         ┌──────────────────────┐
│     Rust CLI Binary      │◄──────────────────►│   wry Window         │
│                          │                     │   (WKWebView)        │
│  • CLI arg parsing       │  evaluate_script()  │                      │
│  • File system access    │  ──────────────────► │  • Svelte UI         │
│  • File watching         │                     │  • HTML injection    │
│  • comrak: MD → HTML     │  ipc.postMessage()  │  • Mermaid (lazy)    │
│  • syntect: code blocks  │  ◄────────────────── │  • Sidebar nav       │
│  • Plan structure parse  │                     │  • Keyboard shortcuts│
│  • Beads detection       │                     │  • Edit mode         │
│  • Theme CSS generation  │                     │  • Theme switching   │
└──────────────────────────┘                     └──────────────────────┘
```

## How It Works

1. User runs `attn plan.md` in terminal
2. Rust binary parses args, reads file, renders markdown to HTML with syntax-highlighted code
3. Opens a native window via wry (uses system WKWebView — no bundled engine)
4. Injects pre-rendered HTML into the webview via `evaluate_script()`
5. Watches file for changes, pushes updates on change
6. User interacts (keyboard shortcuts, sidebar clicks, edits)
7. Frontend sends events back to Rust via `window.ipc.postMessage()`
8. User presses `q` or closes window — process exits, back to terminal

No HTTP server. No WebSocket. Direct IPC between Rust and the webview.

## Rendering Pipeline

```
plan.md (on disk)
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  comrak (Rust)                                       │
│  - Parses GFM markdown (tables, task lists, etc.)   │
│  - Extracts plan structure (phases, tasks, file refs)│
│  - Passes mermaid blocks through as tagged divs      │
│                                                       │
│  syntect plugin (CSS class mode)                     │
│  - Highlights code blocks with `syn-` prefixed classes│
│  - No inline styles — colors come from CSS           │
│  - Theme-independent HTML output                     │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
            ┌─────────────────┐
            │  HTML + metadata │
            │  (pre-rendered)  │
            └────────┬────────┘
                     │ evaluate_script()
                     ▼
┌─────────────────────────────────────────────────────┐
│  Svelte (in wry webview)                             │
│  - Injects HTML into content area                   │
│  - Applies theme via data-theme attribute on <html> │
│  - Finds .mermaid-block divs, lazy-loads mermaid.js │
│  - Renders mermaid with theme matching data-theme   │
│  - All code highlighting is already done — just CSS  │
└─────────────────────────────────────────────────────┘
```

### Code Highlighting: comrak + syntect

comrak has built-in syntect integration via `SyntectAdapterBuilder`:

```rust
let adapter = SyntectAdapterBuilder::new()
    .css_with_class_prefix("syn-")
    .build();

let mut plugins = Plugins::default();
plugins.render.codefence_syntax_highlighter = Some(&adapter);

let html = markdown_to_html_with_plugins(&markdown, &options, &plugins);
```

Output HTML looks like:
```html
<pre class="syn-code"><code>
  <span class="syn-keyword syn-other">fn</span>
  <span class="syn-entity syn-name syn-function">main</span>
  <span class="syn-punctuation">()</span>
</code></pre>
```

No colors in the HTML. Colors come entirely from CSS class rules.

### Theming: data-attribute scoped CSS

At build time (`build.rs`), generate CSS from syntect themes:

```rust
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle};

let ts = ThemeSet::load_defaults();
let style = ClassStyle::SpacedPrefixed { prefix: "syn-" };

let light_css = css_for_theme_with_class_style(&ts.themes["InspiredGitHub"], style).unwrap();
let dark_css = css_for_theme_with_class_style(&ts.themes["base16-ocean.dark"], style).unwrap();
```

Post-process to scope under data-theme:
```css
[data-theme="light"] .syn-code { color: #657b83; background-color: #fdf6e3; }
[data-theme="light"] .syn-keyword { color: #859900; }

[data-theme="dark"] .syn-code { color: #839496; background-color: #002b36; }
[data-theme="dark"] .syn-keyword { color: #859900; }
```

Theme toggle = flip `<html data-theme="dark">`. Instant. No re-render. No round-trip to Rust.

The same `data-theme` attribute drives:
- Code block colors (syntect CSS)
- Body typography colors (custom CSS)
- Mermaid diagram theme (detected in Svelte before rendering)

### Mermaid: lazy client-side rendering

Comrak passes mermaid fenced blocks through as tagged divs:
```html
<div class="mermaid-block" data-content="Z3JhcGggVEQ7IEEtLT5C">
  <span class="mermaid-loading">Loading diagram...</span>
</div>
```

Svelte detects these after HTML injection and lazy-loads mermaid.js only when blocks exist:
```typescript
const blocks = document.querySelectorAll('.mermaid-block');
if (blocks.length === 0) return; // don't load mermaid at all

const mermaid = (await import('mermaid')).default;
const isDark = document.documentElement.dataset.theme === 'dark';

mermaid.initialize({
  startOnLoad: false,
  theme: isDark ? 'dark' : 'default',
  fontFamily: 'inherit',
});

for (const block of blocks) {
  const content = atob(block.dataset.content);
  const { svg } = await mermaid.render(`mermaid-${block.id}`, content);
  block.innerHTML = svg;
}
```

No IntersectionObserver, no async queue, no render cache — attn renders one document at a time, not a streaming chat. Keep it simple.

## Rust Side

### Responsibilities

- **CLI**: Parse args via clap (`attn <path>`, `attn --skim`, `attn --check`, `attn --json`)
- **Markdown pipeline**: comrak with syntect plugin for code highlighting (CSS class mode)
- **Plan structure extraction**: Parse the comrak AST for tasks, phases, file refs, progress
- **Mermaid passthrough**: Detect mermaid fenced blocks, emit tagged divs instead of code blocks
- **File watching**: FSEvents on macOS via notify crate. Push updates on change.
- **Beads integration**: Detect `.beads/`, shell out to `bd ready --json` / `bd list --json` to get status
- **Window management**: Create wry window, embed web assets, handle IPC messages
- **Headless mode**: `--check`, `--status`, `--json` flags skip the window entirely, output to stdout
- **Theme CSS**: Generated at build time from syntect themes, embedded as static assets

### Key Crates

- `wry` — native webview window (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux)
- `clap` — CLI argument parsing
- `comrak` — GFM markdown to HTML (with built-in syntect plugin)
- `syntect` — syntax highlighting with CSS class output
- `notify` — cross-platform file watching
- `include_dir` — embed web assets in binary at compile time
- `serde` / `serde_json` — IPC message serialization

### Markdown Pipeline Detail

Rust parses markdown and produces:
1. **Rendered HTML** — complete HTML with syntax-highlighted code blocks (CSS classes, not inline styles), mermaid blocks as tagged divs
2. **Plan structure** — extracted metadata:
   - Tasks (checkbox items with line numbers)
   - Phases (top-level headers)
   - File references (detected paths like `src/foo/bar.ts`)
   - Progress (checked/total counts per phase)

Both are sent to the frontend. The HTML goes into the content area. The structure drives the progress bar, skim mode, and beads overlay.

## Frontend (Svelte 5 + Vite)

### Why Svelte

- Compiles to vanilla JS — 0KB runtime shipped
- Built-in transitions and animations (crossfade, slide, etc.)
- Built-in CSS scoping per component
- Svelte 5 runes ($state, $derived, $effect) map perfectly to this UI
- Smaller final bundle than any alternative for this complexity level

### Responsibilities

- **HTML injection** — display Rust-provided HTML in the content area
- **Mermaid rendering** — lazy-load mermaid.js, render tagged blocks client-side
- **Keyboard handling** — j/k scroll, q quit, e edit, s skim, f focus, / search, n/p navigate files
- **Sidebar** — file tree for directory mode, collapsible, searchable
- **Density modes** — skim (headers + first lines), read (full), focus (single section)
- **Edit mode** — swap content area to CodeMirror, save writes back via IPC
- **Checkbox toggling** — click a checkbox in rendered view, send line number + state to Rust
- **Theme toggle** — flip data-theme attribute on `<html>`, respect system preference
- **Transitions** — crossfade between files (built-in Svelte transitions), smooth scroll restoration

### Build

Vite builds the Svelte app to static assets (index.html, JS bundle, CSS).
These are embedded into the Rust binary at compile time via `include_dir!`.
No runtime file serving — everything is in-memory.

## IPC Protocol

### Rust → Frontend (via evaluate_script)

```typescript
// Initial content load
window.__attn__.setContent({
  html: "<rendered markdown with syn- classes and mermaid-block divs>",
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

// Theme changed
{ type: "theme_change", theme: "dark" }

// Quit
{ type: "quit" }
```

## File Structure

```
attn/
├── planning/              # goals, architecture, design docs
├── Cargo.toml             # Rust project
├── build.rs               # generates syntect theme CSS, runs vite build, embeds output
├── src/                   # Rust source
│   ├── main.rs            # CLI entry, arg parsing
│   ├── window.rs          # wry window creation, IPC handling
│   ├── markdown.rs        # comrak + syntect pipeline, plan structure extraction
│   ├── watcher.rs         # file watching via notify
│   └── beads.rs           # .beads/ detection, bd CLI integration
├── web/                   # Frontend source (Svelte 5 + Vite)
│   ├── index.html
│   ├── src/
│   │   ├── App.svelte     # root component
│   │   ├── Viewer.svelte  # markdown content display + density modes
│   │   ├── Sidebar.svelte # file tree navigation
│   │   ├── Editor.svelte  # CodeMirror edit mode (lazy loaded)
│   │   ├── keyboard.ts    # keyboard shortcut handling
│   │   ├── ipc.ts         # wry IPC bridge
│   │   └── theme.ts       # data-theme management
│   ├── styles/
│   │   ├── typography.css # reading experience styles
│   │   └── themes/        # generated syntect CSS (light.css, dark.css)
│   ├── vite.config.ts
│   ├── svelte.config.js
│   └── package.json
└── tests/
```

## Build Pipeline

```bash
# Development (frontend hot reload)
cd web && npm run dev       # iterate on Svelte UI with vite dev server
                            # mock IPC for development without Rust

# Development (full binary)
cargo run -- plan.md        # build.rs runs vite build first, then embeds output

# Release
cargo build --release       # build.rs: vite build → include_dir! → single binary
# Result: target/release/attn (~5-10MB binary with all assets embedded)

# Install
cargo install --path .      # installs attn to ~/.cargo/bin/
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
