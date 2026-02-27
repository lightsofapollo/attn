# attn — Architecture

## Overview

```
┌─────────────────────────┐       WebSocket        ┌──────────────────┐
│      CLI (binary)       │◄──────────────────────►│   Browser Tab    │
│                         │                         │                  │
│  • File system access   │   push: rendered html   │  • Rendered MD   │
│  • File watching        │   push: file tree       │  • Typography    │
│  • Markdown parsing     │   push: live reload     │  • Mermaid       │
│  • Beads detection      │                         │  • Shiki         │
│  • Plan structure       │   recv: edit saves      │  • Sidebar nav   │
│  • Path validation      │   recv: checkbox toggle │  • Edit mode     │
│                         │   recv: navigation      │                  │
└─────────────────────────┘                         └──────────────────┘
```

## Components

### CLI Binary

Responsibilities:
- Parse CLI args (file path or directory)
- Start HTTP server on random available port
- Serve embedded web assets (HTML, CSS, JS)
- Establish WebSocket for live communication
- Watch files for changes (FSEvents/inotify)
- Parse markdown and extract structure
- Detect .beads/ and query bead status via `bd` CLI
- Open default browser
- Shut down on SIGINT or WebSocket disconnect

### Web Frontend

Responsibilities:
- Render markdown to beautiful HTML
- Syntax highlighting (shiki)
- Mermaid diagram rendering
- Sidebar file navigation (directory mode)
- Toggle between read and edit mode
- Send edits/checkbox toggles back to CLI via WebSocket
- Responsive, full-screen layout
- Theme switching (light/dark)

### Communication Protocol (WebSocket)

CLI → Browser:
- `file_content` — rendered markdown + metadata for current file
- `file_tree` — directory listing for sidebar
- `file_changed` — live reload trigger with new content
- `bead_status` — bead annotations for current file (if .beads/ present)

Browser → CLI:
- `navigate` — user clicked a file in sidebar
- `edit_save` — user edited and saved content
- `checkbox_toggle` — user toggled a checkbox (line number + new state)

## Tech Stack Decision (TBD)

### Option A: Rust binary + embedded web assets
- Ship as single binary via cargo install
- Embed HTML/CSS/JS with rust-embed or include_bytes!
- Use axum or warp for HTTP + WebSocket
- Pros: fast startup, single binary, no runtime deps
- Cons: web frontend build step, two languages

### Option B: Bun/Node compiled binary
- Ship as single binary via bun build --compile
- Same language for CLI and web frontend
- Pros: one language, faster iteration
- Cons: larger binary, slower startup

### Option C: Hybrid — Rust CLI, web assets built separately
- Rust for CLI/server, TypeScript for frontend
- Frontend built with vite, output embedded in Rust binary at build time
- Best of both worlds but more complex build

Decision deferred until design phase.

## File Structure (Proposed)

```
attn/
├── planning/          # goals, architecture, design docs
├── src/               # CLI source (Rust or TS)
├── web/               # frontend source (HTML, CSS, JS/TS)
├── build/             # build scripts
└── test/              # tests
```
