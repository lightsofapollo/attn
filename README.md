<p align="center">
  <h1 align="center">attn</h1>
  <p align="center">
    Read markdown beautifully. Review it together.<br>
    Native window. End-to-end encrypted collaboration. No Electron.
  </p>
</p>

<p align="center">
  <a href="#collaboration">Collaboration</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="https://github.com/lightsofapollo/attn/issues">Issues</a>
</p>

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/static/screenshots/collab-dark.png">
    <img src="site/static/screenshots/collab-light.png" alt="attn showing a shared markdown review with comments, suggestions, and a collaborator cursor" width="860">
  </picture>
</p>

```bash
attn .
```

attn opens your markdown in a native desktop window with a file tree, tabs,
live reload, and a real editor. When a document needs feedback, hit Share and
send an invite link. Reviewers can comment, suggest edits, and co-edit from the
same markdown surface.

No account. No browser tab. No Electron runtime. The review relay only sees
encrypted bytes.

## Why attn?

Markdown usually lives in your repo, but review often moves somewhere else:
screenshots, pasted docs, stale exported PDFs, or a SaaS editor with a copy of
your source.

attn keeps the source of truth local and makes review a layer over the file you
already have. You get a focused reader, a capable editor, and an encrypted
review room without changing how your project is organized.

## Features

- **Beautiful markdown rendering** - readable line length, careful typography,
  syntax-highlighted code, tables, task lists, math, and Mermaid diagrams.
- **Live reload** - save in Vim, VS Code, Zed, or any editor and the native
  window updates immediately.
- **Built-in editor** - toggle a ProseMirror editor with `Cmd+E` when you want
  to edit in place.
- **Interactive checkboxes** - click a `- [ ]` task and attn writes the change
  back to the file.
- **Project file tree** - browse folders, lazy-load large repos, and jump to
  files with fuzzy search.
- **Tabs and project switching** - keep multiple files open and move between
  remembered workspaces.
- **Native media preview** - images, video, and audio open alongside markdown.
- **Light and dark themes** - paper-and-ink light mode plus a low-glare dark
  mode.
- **Single-instance CLI** - run `attn` from many terminals; one daemon receives
  new files as tabs.

## Collaboration

attn's review flow is built for markdown that should stay private and local.

- **Share in one click** - use the Share button, the breadcrumb/share menu, or
  `Cmd+Shift+S` to create a review room for the active markdown file.
- **Encrypted invite links** - send an `attn://review/...#key=...` link or the
  generated `npx attnmd ...` command. The room key is in the invite fragment,
  not on the relay.
- **Comments and suggestions** - reviewers anchor feedback to selected text;
  suggestions appear beside the document with Accept/Reject actions.
- **Live cursors and co-editing** - connected reviewers show up in the document
  and sidebar so you can see where people are reading or editing.
- **Hybrid transport** - attn uses direct peer-to-peer collaboration when it can
  and falls back to the encrypted relay when it cannot.
- **Folder share** - share a directory to publish snapshots for every markdown
  file under it; newly added markdown files are picked up by the watcher.

Owner flow:

```bash
attn path/to/docs
# In the app: Share, or Cmd+Shift+S
```

CLI share flow:

```bash
attn review share path/to/docs
```

Reviewer flow:

```bash
attn review join 'attn://review/<room-id>#key=<secret>'
```

For headless reviewers or agents:

```bash
attn review register-agent reviewer
attn review join 'attn://review/<room-id>#key=<secret>' --as-agent reviewer
```

## Install

### Homebrew

```bash
brew install lightsofapollo/attn/attn
```

### npm

```bash
npx attnmd
# or
npm install -g attnmd && attn
```

### From source

```bash
git clone https://github.com/lightsofapollo/attn.git
cd attn
cargo install --path .
```

Requires Rust 1.85+. npm installs require Node 18+.

## Usage

```bash
attn                     # open current directory
attn README.md           # open a file
attn ~/projects/myapp    # open a project
attn --dark              # force dark mode
attn --status todo.md    # print task progress, e.g. "3/5 tasks complete"
attn --json spec.md      # dump document structure as JSON
```

### Review CLI

```bash
attn review share docs/                         # share a file or folder
attn review join 'attn://review/...'            # join through the running app
attn review register-agent reviewer             # create a headless reviewer identity
attn review join 'attn://review/...' --as-agent reviewer
attn review list-agents
attn review whoami
```

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+P` | Fuzzy file search |
| `Cmd+E` | Toggle editor |
| `Cmd+F` | Find and replace |
| `Cmd+Shift+S` | Share for review |
| `Cmd+;` | Switch project |
| `Cmd+W` | Close tab |
| `Cmd+Tab` / `Cmd+Shift+Tab` | Navigate tabs |
| `Cmd+=` / `Cmd+-` | Zoom in / out |
| `Cmd+0` | Reset zoom |
| `Cmd+/` | Show all shortcuts |

## How it works

The Svelte 5 frontend is compiled by Vite and embedded into the Rust binary at
build time. There is no bundled web server and no extracted asset directory at
runtime.

On first launch, attn forks a daemon to the background. The daemon opens a
native window via [wry](https://github.com/tauri-apps/wry), watches your files,
and listens on a Unix socket. Later `attn` calls connect to that socket and
open new tabs in the existing window. If the binary changes after a rebuild,
the old daemon is replaced automatically.

Collaboration is layered on top of the local file model. The owner shares a
snapshot graph and review event log over an end-to-end encrypted room. The
relay handles discovery, mailbox fallback, and presence transport, but it does
not receive plaintext markdown or comments.

```
src/
  main.rs       CLI, native window, keyboard shortcuts
  daemon.rs     Unix socket IPC, single-instance daemon
  watcher.rs    File system monitoring with debouncing
  markdown.rs   Structure extraction
  ipc.rs        Webview <-> Rust messaging
  files.rs      File tree and media type detection
  projects.rs   Project registry
  review/       Encrypted review rooms, anchors, transport, apply flow

web/src/        Svelte 5 frontend
relay/          Cloudflare Worker relay for encrypted review traffic
site/           Public marketing site
```

## Development

```bash
task dev                              # Vite HMR + Rust in foreground
task dev ATTN_PATH=path/to/file.md    # open a specific file
```

Builds:

```bash
scripts/build.sh            # debug build
scripts/build.sh release    # release build with devtools/screenshots
scripts/build.sh prod       # production release build
```

Useful gates:

```bash
npm run check --prefix web
npm test --prefix web
cargo test
npm test --prefix relay
npm run build --prefix site
```

## License

[MIT](LICENSE)
