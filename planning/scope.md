# attn — Scope & Phases

## Phase 1: Core Viewer

The minimum viable tool — open a markdown file and see it rendered beautifully.

  - [x] CLI accepts a file path argument

  - [x] Starts local HTTP server with embedded web assets

  - [ ] Opens default browser to rendered view

  - [ ] Markdown rendered with full GFM support

  - [ ] Syntax-highlighted code blocks (shiki)

  - [ ] Clean typography, full-screen layout

  - [ ] Light/dark mode (respects system preference)

  - [ ] File watching with live reload on change

  - [ ] Clean shutdown on ctrl+c

  - [ ] Image rendering (relative paths resolved)

## Phase 2: Directory Browsing

Navigate a folder of markdown files.

  - [ ] CLI accepts a directory path argument

  - [ ] Sidebar with file tree navigation

  - [ ] Collapsible folder sections

  - [ ] Click to navigate between files

  - [ ] File search/filter in sidebar

  - [ ] Preserve scroll position per file

## Phase 3: Rich Content

Mermaid, math, and other embedded content.

  - [ ] Mermaid diagram rendering

  - [ ] Tables with horizontal scroll

  - [ ] Frontmatter display (collapsible)

  - [ ] Math/LaTeX rendering (stretch)

  - [ ] Embedded images with zoom

## Phase 4: Editing

Quick edits without leaving attn.

  - [ ] Toggle between rendered and edit mode

  - [ ] Checkbox toggling in rendered view (writes back to file)

  - [ ] CodeMirror (or similar) for edit mode

  - [ ] Save writes back to source file

  - [ ] Edit mode preserves scroll position

## Phase 5: Beads Integration

Plan-to-execution visibility.

  - [ ] Detect .beads/ in repo

  - [ ] Parse plan markdown for task structure

  - [ ] Query bead status via `bd` CLI

  - [ ] Annotate rendered tasks with bead status badges

  - [ ] Progress overlay (X/Y tasks beaded, Z closed)

  - [ ] File path validation (check referenced paths exist)

  - [ ] Stale plan detection (plan references files that changed since plan was written)