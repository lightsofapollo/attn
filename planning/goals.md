# attn — Goals

## What is attn?

A minimal, beautiful markdown viewer that runs from the CLI and renders in the browser. Built for developers who work with AI coding agents and need to review plans, docs, and specs before execution.

```bash
attn plan.md           # view a single file
attn ./planning/       # browse a folder
attn .                 # browse current directory
```

## Core Goals

### 1. Beautiful, distraction-free reading

- Full-screen, minimal chrome
- Excellent typography optimized for long-form technical reading
- Light and dark mode
- The aesthetic should feel like a high-end reading app, not a dev tool

### 2. First-class markdown rendering

- GitHub-flavored markdown
- Syntax-highlighted code blocks (shiki)
- Mermaid diagram rendering
- Image rendering (relative paths resolved from file location)
- Task/checkbox lists
- Tables
- Frontmatter display (optional)
- Math/LaTeX (stretch)

### 3. CLI-first, browser-rendered

- `attn <file-or-dir>` starts a local server, opens the browser, watches for changes
- Live reload on file change
- Exits cleanly on tab close or ctrl+c
- No install beyond a single binary — web assets embedded in the binary
- Fast startup (<500ms to rendered page)

### 4. Folder browsing

- Sidebar navigation when viewing a directory
- File tree with collapsible sections
- Sort by name or modification time
- Search/filter files

### 5. Optional quick editing

- Toggle between rendered view and edit mode
- Edits write back to the source .md file
- Checkbox toggling in rendered view writes back to file
- CodeMirror or similar for edit mode

### 6. Beads awareness (when present)

- If `.beads/` exists in the repo, detect it
- Annotate plan markdown with bead status (open, in_progress, closed, blocked)
- Show which tasks in a plan have corresponding beads
- Show progress overlay (e.g., "4/7 tasks beaded, 2 closed")
- This is purely additive — without .beads/, attn is just a markdown viewer

## Non-Goals

- Not a general-purpose markdown editor (use Typora/Obsidian for that)
- Not a note-taking app
- Not a task execution engine (beads handles that)
- No database, no accounts, no cloud sync
- No MCP server — agents interact via CLI if needed
- No Electron — browser tab is the render target

## Technical Direction

- Single binary distribution (Rust with embedded web assets, or Bun compiled)
- WebSocket connection between CLI and browser for live updates
- The CLI owns the filesystem; the browser owns the pixels
- File watching via native OS APIs (FSEvents on macOS)
- Plan structure parsing: extract phases, tasks, file refs from markdown hierarchy

## Success Criteria

- `attn plan.md` goes from keystroke to rendered page in under 500ms
- Viewing experience is noticeably better than reading raw markdown in a terminal or VS Code preview
- Checkbox toggling in a plan file works without switching to edit mode
- A developer using beads can see plan-to-bead status at a glance
- The tool disappears when not needed — no persistent process, no dock icon, no tray

## Context

- **Org**: gpu-cli
- **Pairs with**: [beads](https://github.com/steveyegge/beads) (`bd` CLI) for plan execution
- **Workflow**: Write plan (markdown) -> Review with attn -> Execute with beads
- **Prior art explored**: Typora, Obsidian, Mark Text, iA Writer, glow, Ally, Tasks.md, Markwhen, Vercel Streamdown
