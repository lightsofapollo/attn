<p align="center">
  <h1 align="center">attn</h1>
  <p align="center">
    A markdown viewer for people who live in the terminal.<br>
    One command. Native window. No Electron.
  </p>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="https://github.com/lightsofapollo/attn/issues">Issues</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

<!-- TODO: Add a GIF/screenshot here showing attn in action -->

```bash
attn .
```

That's it. A native window opens with your project's markdown rendered beautifully — with live reload, a file tree, tabs, and a built-in editor. No config, no browser, no 200MB runtime.

## Why attn?

Most markdown previewers are either browser tabs you have to manually refresh, or Electron apps that eat your RAM for breakfast.

attn is a **single ~8MB binary**. It forks to background as a daemon, opens a native macOS window, and watches your files. Edit in Vim, VS Code, whatever — attn reloads instantly. Open another file? It joins the same window as a tab.

**What you get:**

- **Live reload** — save a file, see the change. No refresh button.
- **Interactive checkboxes** — click a `- [ ]` task and it writes back to the file.
- **Built-in editor** — hit `Cmd+E` to toggle a full ProseMirror editor with syntax highlighting, math, and mermaid diagrams.
- **File tree + fuzzy search** — browse your project with `Cmd+P`. Lazy-loads folders so it's fast on huge repos.
- **Tabs + projects** — open multiple files, switch between projects with `Cmd+;`. attn remembers your workspaces.
- **Media support** — images (with zoom/pan), video, and audio play natively.
- **Dark/light mode** — follows your OS, or force with `--dark` / `--light`.
- **Single instance** — run `attn` from ten terminals. One daemon, one window, new tab each time.

## Install

### npm (macOS)

```bash
npm install -g attnmd
```

### From source

```bash
git clone https://github.com/lightsofapollo/attn.git
cd attn && cargo install --path .
```

Requires Rust 1.85+ and Node 18+.

## Usage

```bash
attn                     # open current directory
attn README.md           # open a file
attn ~/projects/myapp    # open a project
attn --dark              # force dark mode
attn --status todo.md    # print task progress: "3/5 tasks complete"
attn --json spec.md      # dump document structure as JSON
```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+P` | Fuzzy file search |
| `Cmd+E` | Toggle editor |
| `Cmd+F` | Find & replace |
| `Cmd+;` | Switch project |
| `Cmd+W` | Close tab |
| `Cmd+Tab` / `Cmd+Shift+Tab` | Navigate tabs |
| `Cmd+=` / `Cmd+-` | Zoom in / out |
| `Cmd+0` | Reset zoom |
| `Cmd+/` | Show all shortcuts |

## How it works

The Svelte 5 frontend is compiled by Vite and **embedded into the Rust binary** at build time. No bundled web server, no extracted assets — it's a single self-contained executable.

First launch forks a daemon to the background. The daemon opens a native window via [wry](https://github.com/tauri-apps/wry) (the same webview engine behind Tauri) and listens on a Unix socket. Subsequent `attn` calls connect to the socket and open new tabs in the existing window. If the binary changes (you rebuild), the old daemon is automatically replaced.

```
src/
  main.rs       CLI, native window, keyboard shortcuts
  daemon.rs     Unix socket IPC, single-instance daemon
  watcher.rs    File system monitoring with debouncing
  markdown.rs   Structure extraction (tasks, phases, file refs)
  ipc.rs        Webview ↔ Rust messaging
  files.rs      File tree, media type detection
  projects.rs   Project registry

web/src/        Svelte 5 frontend
web/styles/     Tailwind CSS
```

## Contributing

```bash
task dev                              # Vite HMR + Rust in foreground
task dev ATTN_PATH=path/to/file.md    # Open a specific file
```

The `task dev` command starts Vite for hot module replacement and runs the Rust binary in foreground mode, pointed at the Vite dev server.

```bash
scripts/build.sh            # Debug build
scripts/build.sh release    # Release build
scripts/build.sh prod       # Production build
```

## License

[MIT](LICENSE)
