# attn

A native markdown viewer that launches from the terminal. Built with Rust and Svelte 5.

```
attn README.md
```

Opens a native window with live-reloading, a built-in editor, file tree sidebar, multi-tab support, and interactive task lists — all from one CLI command.

## Install

### npm

```bash
npm install -g attnmd
```

### From source

```bash
git clone https://github.com/lightsofapollo/attn.git
cd attn
cargo install --path .
```

Requires Rust 1.85+ and Node 18+ (for the web frontend build step).

## Features

**View** — Renders markdown with syntax-highlighted code blocks, math equations, mermaid diagrams, tables, and interactive checkboxes that write back to the file.

**Edit** — Toggle into a ProseMirror-based editor with `Cmd+E`. Changes auto-save on blur.

**Watch** — File changes on disk are detected and reloaded in real-time. Edit in your favorite editor, see it in attn.

**Browse** — File tree sidebar with lazy-loading folders, project switching (`Cmd+;`), and fuzzy file search (`Cmd+P`).

**Tabs** — Open multiple files as tabs in a single window. `attn file1.md file2.md` or open more from the sidebar.

**Media** — Native support for images (with zoom/pan), video (MP4, WebM, MOV), and audio (MP3, WAV, FLAC, OGG).

**Themes** — Dark and light modes. Follows your OS preference by default, or force with `--dark` / `--light`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+P` | Fuzzy file search |
| `Cmd+E` | Toggle editor |
| `Cmd+F` | Find & replace (in editor) |
| `Cmd+;` | Switch project |
| `Cmd+W` | Close tab |
| `Cmd+Tab` | Next tab |
| `Cmd+=` / `Cmd+-` | Zoom in / out |
| `Cmd+0` | Reset zoom |
| `Cmd+/` | Show all shortcuts |

## CLI

```
attn [OPTIONS] [PATH]
```

`PATH` defaults to the current directory.

| Flag | Description |
|---|---|
| `--dark` / `--light` | Force theme |
| `--no-fork` | Run in foreground (for development) |
| `--status` | Print task progress and exit |
| `--json` | Output document structure as JSON and exit |
| `--check` | Validate file references and exit |

## Architecture

```
src/
  main.rs        CLI, event loop, native keyboard shortcuts
  daemon.rs      Unix socket IPC, single-instance, fork-to-background
  watcher.rs     File system monitoring (notify) with debouncing
  markdown.rs    Structure extraction (phases, tasks, file refs)
  ipc.rs         Webview ↔ Rust message handling
  files.rs       File tree building, media type detection
  projects.rs    Project registry (remembers recent workspaces)

web/
  src/           Svelte 5 frontend (embedded into the binary at compile time)
  styles/        Tailwind CSS
```

The Svelte frontend is compiled by Vite and embedded into the Rust binary via `build.rs`. No runtime web server — it's a single self-contained executable.

## Development

```bash
task dev                              # Vite HMR + Rust in foreground
task dev ATTN_PATH=path/to/file.md    # Open a specific file
```

```bash
scripts/build.sh            # Debug build
scripts/build.sh release    # Release build
scripts/build.sh prod       # Production (strips devtools)
```

## License

[MIT](LICENSE)
