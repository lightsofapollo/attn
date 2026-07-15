# attn

A native markdown viewer CLI built with Rust (wry/tao) and Svelte 5.

## Design Context

Strategic design context lives in [`PRODUCT.md`](PRODUCT.md) at the repo root — read it before design/UI work. In short: register is **product** (the reviewer tool is the thing; design serves the task), platform **web** (Svelte in a wry webview + a hosted browser build). Positioning: *the reviewer for agent-authored docs* — human comments and AI suggestions in one end-to-end-encrypted thread over files that never leave your machine. The guiding principle is **warm surface, sharp behavior**: an editorial paper/ink/rust identity you can see, power-tool (Linear/Raycast-grade) precision you can feel. The visual system is captured in `DESIGN.md`.

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
ATTN_HOME=/tmp/attn-owner task dev    # honor ATTN_HOME for multi-instance dev (optional)
```

## Local collab testing

The fastest way to bring up the full local stack (Miniflare relay + owner +
reviewer) in one terminal:

```bash
task dev:collab
# or directly:
scripts/dev-collab.sh
```

This boots three processes:

1. Miniflare relay — `wrangler dev --local --port 8787` (waits for `/health`).
2. Owner daemon — `ATTN_HOME=/tmp/attn-collab-owner` opening
   `tests/fixtures/basic.md`.
3. Reviewer daemon — `ATTN_HOME=/tmp/attn-collab-reviewer`, idle until the
   user provides an invite.

Interactive flow: click **[Share]** in the owner window, copy the invite URL,
paste it at the script's prompt — it runs `attn review join <invite>` routed
to the reviewer daemon (deliberately NOT `--as-agent`, which forks a separate
headless agent process and leaves the reviewer window idle; the daemon-routed
join flips the reviewer's own window onto the shared document). Ctrl+C cleans
up all three processes.

Env overrides:

```bash
ATTN_RELAY_URL=http://localhost:8787   # default
FIXTURE_PATH=tests/fixtures/basic.md   # default
ATTN_BIN=target/debug/attn             # default; built on demand
REVIEWER_AGENT=reviewer                # agent name passed to `review join`
ATTN_COLLAB_NONINTERACTIVE=1           # skip the invite prompt (boot-only CI)
```

For manually running two daemons without the relay/join harness:

```bash
ATTN_HOME=/tmp/attn-owner    task dev ATTN_PATH=plan.md
ATTN_HOME=/tmp/attn-reviewer attn ...
```

Each instance gets its own socket, identity, log, and (future) review store.
Default behavior is unchanged when `ATTN_HOME` is unset.

For automated test scripts, source the dual-instance library:

```bash
source scripts/lib/dual-instance.sh
trap stop_dual EXIT
start_dual
wait_for_dual 'h1'
attn_owner    --click 'text=Suggest'
attn_reviewer --fill '.composer textarea' 'fix the typo'
count=$(attn_owner --query '.review-thread' | jq '.count')
```

Each helper prefixes the right `ATTN_HOME` automatically — instances stay isolated.
Smoke-test via `task test:dual`.

## Local hosted share loop

The full browser share flow (owner → invite link → joiner) runs entirely on
localhost — dev builds allow the app's own origin as a share host (production
bundles keep the strict attn.sh/staging.attn.sh allowlist):

```bash
# Terminal 1 — local relay with dev vars (same flags as `npm run dev` in relay/)
cd relay && npm run dev            # port 8787

# Terminal 2 — hosted app with same-origin relay proxy
cd web && npm run dev:browser:shares   # port 5173, proxies /v3 → 8787
```

Open http://localhost:5173/app#new, write, click **Share for review** — the
sheet mints `http://localhost:5173/s/<id>#key=…` links; open one in another
tab/profile for the joiner UX. To mint links against a deployed origin
instead (once its relay runs the current protocol), set
`VITE_ATTN_SHARE_ORIGIN=https://staging.attn.sh` and point
`VITE_ATTN_RELAY_URL` at that environment's relay.

## Build

```bash
scripts/build.sh           # debug (default) — automation + devtools enabled
scripts/build.sh release   # release — automation + devtools stripped
scripts/build.sh prod      # alias for release
```

Or directly with cargo:

```bash
cargo build                # debug (automation, devtools, screenshots, dev server)
cargo build --release      # release (stripped — clean for distribution)
```

Debug builds (`debug_assertions` on) include automation CLI flags (`--screenshot`, `--eval`, `--click`, `--wait-for`, `--query`, `--fill`), devtools, and dev server support. Release builds strip all of these automatically — no feature flags needed.

## Binary-size gate

The release binary must stay under **32 MiB** (locked by `planning/collab/amendments.md` §Decision #1 — the WebRTC transport is owned by Rust via `webrtc-rs`, which is the main risk to this budget; raised 25 → 30 MiB once webrtc-rs landed, then 30 → 32 MiB once the `tracing`/`time` daemon-logging stack landed).

```bash
task check:size              # builds release + runs the gate
scripts/check-binary-size.sh # gate only (assumes target/release/attn exists)
scripts/check-binary-size.sh 30  # override budget (positional MAX_MIB)
```

Run the gate locally before merging any PR that touches `Cargo.toml`, `src/**`, or adds a transitively-heavy dep (tokio features, rustls, etc.). The script also reports the `.app` bundle size for context, and warns if it sees a regression > 2 MiB above an optional `planning/collab/binary-size-baseline.md`.

Emergency bypass: `BINARY_SIZE_WAIVER=1 scripts/check-binary-size.sh` (or the CI alias `ATTN_SIZE_BUDGET_WAIVER=1`). Bypasses must include a follow-up issue filed against `attn-nnj.11.3` linked in the PR — never commit the waiver as a default.

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

## Release Process

To bump the version (e.g., to 0.3.6):

1. Update `version` in `Cargo.toml` and `package.json` (root)
2. Run `cargo check` to update `Cargo.lock`
3. Commit: `git commit -m "Bump version to 0.3.6"`
4. Tag: `git tag v0.3.6`
5. Push: `git push && git push origin v0.3.6`

## Architecture

- `src/main.rs` — CLI entry, daemon event loop, webview setup
- `src/daemon.rs` — Unix socket IPC, fork, single-instance protocol
- `src/watcher.rs` — File change detection via notify
- `src/markdown.rs` — Markdown rendering (comrak + syntect)
- `src/ipc.rs` — Webview IPC message handling
- `src/screenshot.rs` — Native WKWebView screenshot (debug builds, macOS)
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

# Take a screenshot (macOS, debug builds only)
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
- `review/scenario-comment-survives-edit.{md,json}` — canvas + scripted mock-IPC scenario consumed by the review E2E suite

Run the review-surface E2E suite (shape-only assertions today; isolated `ATTN_HOME`):

```bash
task test:review
# or directly:
scripts/test-review-e2e.sh
```

This runs under `ATTN_HOME=/tmp/attn-review-e2e` so it does not touch the user's normal daemon state, loads a scripted scenario from `tests/fixtures/review/`, and asserts the shape of the review surfaces (right-rail slot, `window.__attn__` review callbacks). Assertions that depend on not-yet-merged Phase 0c work print `PEND` instead of `FAIL` and flip to hard asserts as those issues land.

Run the apply-flow E2E suite (attn-nnj.8.6 — Rust cargo tests + optional daemon-layer probes):

```bash
task test:apply
# or directly:
scripts/test-apply-e2e.sh
```

Drives the full owner-side accept/reject pipeline end-to-end: snapshot + UserEdit drift forces the suggestion to REMAP, `apply_ready_verdict` writes the file, the `LocalRevision` journal lands UserEdit + AcceptedSuggestion in order, and a `SuggestionAccepted` (or `SuggestionRejected`) envelope round-trips through the outbox with `resulting_hash` matching the on-disk hash. The Rust E2E cases live in `src/review/apply.rs` as `e2e_*` tests; the bash wrapper also probes the running daemon for the same end-state via the `--eval` bridge (daemon-layer assertions print `PEND` until attn-nnj.8.5 wires the `AcceptSuggestion` command — flip via `ATTN_APPLY_E2E_REQUIRE_DAEMON=1`).

### WebRTC end-to-end test (attn-nnj.7.7)

Two surfaces:

```bash
task test:webrtc            # runs both the Rust test and the bash harness
# or directly:
cargo test --test webrtc_e2e -- --nocapture
scripts/test-webrtc-e2e.sh
```

- **Rust**: `tests/webrtc_e2e.rs` stands up two `WebRtcTransport` instances inside the same process, drives them through SDP offer/answer + trickle ICE via an in-process signaling relay, sends a comment envelope over the DataChannel, and verifies the owner's `InboundPipeline` persisted it to `events.jsonl`. Requires loopback UDP and (optionally) STUN reachability to `stun.l.google.com`.
- **Bash**: `scripts/test-webrtc-e2e.sh` boots two daemons via `scripts/lib/dual-instance.sh` and exercises the WebRTC handshake from the outside. Today it's primarily a daemon-shape scaffold — hard assertions on "the owner saw the reviewer's comment" PEND until attn-nnj.7.8 wires the ReviewManager IPC into `window.__attn__.review`.

Both surfaces honor `ATTN_SKIP_WEBRTC_E2E=1` as a CI escape hatch: WebRTC bring-up needs real UDP sockets and is flaky on some infrastructure (especially macOS GH Actions runners). Skip-on-CI is a clean exit, not a failure.

### Manual testing workflow

1. Start the daemon with HMR: `task dev ATTN_PATH=some/file.md`
2. In another terminal, use `--eval` to inspect/interact with the webview:
   - Query DOM state: `cargo run -- --eval "document.querySelector('.task-list').children.length"`
   - Trigger actions: `cargo run -- --eval "document.querySelector('input[type=checkbox]').click()"`
   - Read app state: `cargo run -- --eval "JSON.stringify(window.__attn_init__)"`
3. Use `--info` to get PID/window ID for external tooling
4. Use `--screenshot` to capture visual state for comparison
