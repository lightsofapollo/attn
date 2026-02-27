# attn — Differentiation

## The Problem

Every markdown renderer uses the same pipeline (markdown-it/remark + shiki + mermaid) and produces visually similar output. Using the same tech means the baseline rendering is commodity. attn must differentiate on experience, not rendering correctness.

## What Makes Reading Great

### Typography as a Feature

Most markdown viewers apply CSS and stop. attn should treat typography as a core feature:

- **Measure**: 60-75 character line width. Content never stretches to viewport. The reading column is fixed and centered.
- **Vertical rhythm**: All spacing (paragraphs, headings, code blocks, lists) snaps to a baseline grid. The eye never stumbles.
- **Scale**: A deliberate type scale (e.g., 1.25 or 1.333 ratio) for heading hierarchy. Not arbitrary font sizes.
- **Font selection**: One typeface, well-chosen. Not a font pairing exercise — a single family (with mono for code) that's optimized for screen reading at the body size we choose.
- **Code integration**: Code blocks should feel like part of the document, not rectangles pasted in. Matching vertical rhythm, harmonious background, no harsh borders.
- **List polish**: Proper hanging punctuation for ordered lists. Consistent indent depth. Checkbox alignment that doesn't shift text.

### Zero Chrome

Not "minimal UI" — zero visible UI until needed.

- No toolbar, no menu bar, no status bar visible by default
- Content fills the entire viewport
- Sidebar slides in on hover at left edge, or keyboard shortcut
- Controls (theme toggle, edit mode, search) appear via keyboard shortcuts or a command palette
- The only visible element is the rendered markdown

### Transitions

The feel of navigation matters:

- File-to-file transitions: crossfade with content, not a hard page swap
- Scroll position: restored per-file, animated on return
- Sidebar: slides in/out with spring physics, not a CSS toggle
- Edit mode: content morphs from rendered to editable, not a full re-render
- Live reload: diff-aware — only re-render changed sections, not the whole page

### Density Modes

Plan review has two modes of attention:

- **Skim mode**: Show only headers + first paragraph/line of each section. Collapse everything else. Task checkboxes remain visible. Get the shape of the plan in one screen.
- **Read mode**: Full content rendered. This is the default.
- **Focus mode**: Single section expanded, everything else collapsed. Navigate between sections with j/k or arrow keys.

Toggling between these should be a single keystroke.

## What Makes attn Different From "Another Viewer"

### 1. Plan Intelligence

attn understands markdown plans as structured documents, not flat text:

- **Task extraction**: Parse checkboxes as tasks. Show progress (7/12 complete) without the user adding anything to their markdown.
- **Phase detection**: Top-level headers are phases. Show a phase progress bar.
- **File reference detection**: Recognize file paths in the document (e.g., `src/auth/middleware.ts`). In the future, validate whether they exist.
- **Dependency hints**: If a section says "after X" or "depends on Y" or "blocked by Z", surface that.

This parsing happens in the CLI, not the browser. The browser receives structured data, not just HTML.

### 2. Beads Status Overlay

When .beads/ is present, the rendered plan becomes a live dashboard:

- Tasks that have corresponding beads show status badges (open, in_progress, closed, blocked)
- Progress is real — not checkbox completion but actual execution status from `bd`
- Stale indicators when the plan has diverged from bead state
- This is the feature no other markdown viewer has because no other viewer is aware of the execution layer

### 3. Speed as a Feature

Most markdown viewers feel like apps you launch. attn should feel like a command you run.

- Target: 200ms from keystroke to rendered content visible in browser
- Pre-render markdown in the CLI while the browser tab is opening
- Send rendered HTML over WebSocket the instant the connection opens — no loading spinner, no blank page
- Subsequent file navigation is instant (no HTTP round trip — all via WebSocket)

### 4. Keyboard-Native

The target user lives in the terminal. The viewer should feel like a terminal app that happens to render in a browser.

- j/k or arrow keys to scroll
- n/p to navigate between files (directory mode)
- / to search within document
- f to toggle focus mode
- s to toggle skim mode
- e to toggle edit mode
- q to quit (closes tab, stops server)
- Space to page down
- g/G to top/bottom
- No mouse required for any core operation

### 5. The CLI is the Product

The browser is a render target, not the product. The CLI is where differentiation compounds:

```bash
attn plan.md                    # view (the core)
attn plan.md --skim             # open in skim mode
attn plan.md --check            # validate file refs, show stale sections (no browser)
attn plan.md --status           # show task progress to stdout (no browser)
attn plan.md --json             # structured plan data to stdout (for agents)
attn ./planning/                # directory mode
```

The --check, --status, and --json flags make attn useful without ever opening a browser. Agents use these. Humans use the viewer. Same tool, two interfaces.
