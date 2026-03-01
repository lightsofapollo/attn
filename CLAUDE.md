# attn

A native markdown viewer CLI built with Rust (wry/tao) and Svelte 5.

## Development (HMR)

Use the Taskfile dev command for frontend/native UI development:

```bash
task dev
```

By default, `task dev` auto-selects a free port (equivalent to `DEV_PORT=auto`).

This command starts Vite in `web/`, waits for it to be ready, then runs Rust with `ATTN_DEV_SERVER_URL` so the wry webview uses the Vite dev server with HMR.

Useful overrides:

```bash
task dev ATTN_PATH=tests/fixtures/basic.md
task dev DEV_PORT=5174
task dev DEV_PORT=auto
task dev DEV_HOST=0.0.0.0
```

## Build

```bash
scripts/build.sh           # debug (default) — devtools + screenshots enabled
scripts/build.sh release   # release — devtools + screenshots enabled
scripts/build.sh prod      # production release — devtools + screenshots stripped
```

Or directly with cargo:

```bash
cargo build                              # debug
cargo build --release                    # release (with devtools/screenshots)
cargo build --release --features production  # production (stripped)
```

The `production` feature flag strips devtools and `--screenshot` support. By default, ALL builds (debug + release) include them.

## macOS Packaging

```bash
# Generate temporary placeholder icon (replace before final release)
scripts/generate-placeholder-icon.sh

# Build app bundle
scripts/macos-build-bundle.sh prod aarch64-apple-darwin

# Sign app bundle (requires APPLE_SIGNING_IDENTITY)
scripts/macos-sign-app.sh target/aarch64-apple-darwin/release/bundle/osx/attn.app

# Create signed DMG (if APPLE_SIGNING_IDENTITY is set)
scripts/macos-create-dmg.sh target/aarch64-apple-darwin/release/bundle/osx/attn.app

# Notarize + staple (requires APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)
scripts/macos-notarize-dmg.sh target/aarch64-apple-darwin/release/bundle/osx/attn.dmg
```

GitHub Action setup is documented in `.github/RELEASE_SETUP.md`.

## Architecture

- `src/main.rs` — CLI entry, daemon event loop, webview setup
- `src/daemon.rs` — Unix socket IPC, fork, single-instance protocol
- `src/watcher.rs` — File change detection via notify
- `src/markdown.rs` — Markdown rendering (comrak + syntect)
- `src/ipc.rs` — Webview IPC message handling
- `src/screenshot.rs` — Native WKWebView screenshot (all non-production builds, macOS)
- `web/` — Svelte 5 frontend, built by Vite into `web/dist/index.html` (embedded at compile time). In dev, `task dev` serves Vite directly for HMR.
- `build.rs` — Runs Vite build, recursively watches `web/src/` and `web/styles/` for changes
- `scripts/build.sh` — Unified build script (web + Rust)
- `scripts/test-e2e.sh` — Automated E2E test runner

## Testing the daemon

attn runs as a single-instance daemon. The first invocation forks to background and opens a window. Subsequent invocations connect via unix socket at `~/.attn/attn.sock`.

Use `task dev` during development to keep the daemon in the foreground with HMR enabled:

```bash
task dev ATTN_PATH=path/to/file.md
```

If you only need Rust-side iteration (no frontend HMR), you can still run:

```bash
cargo run -- --no-fork path/to/file.md
```

### Daemon commands (talk to running daemon)

```bash
# Structured interaction commands (preferred for E2E tests)
attn --click 'text=Submit'              # click by text content
attn --click '.my-button'               # click by CSS selector
attn --wait-for 'h1'                    # wait for element to appear (default 5s)
attn --wait-for 'h1' --timeout 10000    # custom timeout in ms
attn --query 'h1'                       # JSON: {status, count, elements[{tag, text, visible, attributes}]}
attn --query '[data-sidebar]' | jq '.count'
attn --fill 'input.search' 'hello'      # fill a form field

# Evaluate JavaScript in the webview and print the result (escape hatch)
attn --eval "document.title"
attn --eval "document.querySelector('h1')?.textContent"
attn --eval "window.__attn__"  # access the Svelte app bridge

# Get daemon info (binary path, PID, window ID)
attn --info

# Take a screenshot (macOS, non-production builds)
attn --screenshot
```

Selectors support CSS selectors and a `text=` prefix for matching by element text content (like Playwright locators). Exit code 0 on success, 1 on not_found/timeout.

### E2E Tests

Run the automated E2E test suite:

```bash
scripts/test-e2e.sh
```

This builds attn, launches it with test fixtures, asserts DOM state via `--eval`, and captures screenshots to `/tmp/attn-e2e-screenshots/`.

Test fixtures are in `tests/fixtures/`:
- `basic.md` — headings, checkboxes, code block, table, blockquote
- `typography.md` — all heading levels, nested lists, text formatting
- `nested/child.md` — subdirectory file for tree/breadcrumb testing

### Manual testing workflow

1. Start the daemon with HMR: `task dev ATTN_PATH=some/file.md`
2. In another terminal, use `--eval` to inspect/interact with the webview:
   - Query DOM state: `cargo run -- --eval "document.querySelector('.task-list').children.length"`
   - Trigger actions: `cargo run -- --eval "document.querySelector('input[type=checkbox]').click()"`
   - Read app state: `cargo run -- --eval "JSON.stringify(window.__attn_init__)"`
3. Use `--info` to get PID/window ID for external tooling
4. Use `--screenshot` to capture visual state for comparison
