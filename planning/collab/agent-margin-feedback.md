# For agent: notes where the agent can read them

**Agreed direction · 7 September 2026 · Implementation epic: attn-aysu**

[Interactive HTML artifact](agent-margin-feedback.html#agent-workflow) · [Still preview](agent-margin-feedback-preview.png) · [Implementation evidence](agent-feedback-implementation-evidence.md). The implementation is available on `angus/agentic-enhancements` for review.

**Outcome.** Mark a margin thread **For agent**. An agent reads the note, the file to edit and the passage it refers to directly from attn. It edits the original file with its usual tools; attn refreshes the document. No additional feedback Markdown file to maintain.

## Two commands, one source of notes

```sh
attn feedback          # Read current feedback and exit
attn feedback --watch  # Keep streaming feedback changes
```

Run from the source project, or pass a file/project path. Resolve scope through local workspace bindings; never silently include unrelated projects. `attn feedback` prints readable text; `--json` returns a versioned structured snapshot. A mapped project with no feedback is a successful empty result. An ambiguous or unmapped project gets an actionable error.

`--watch` emits newline-delimited JSON: a complete initial snapshot, then `upsert` and `remove` records as comments or marks change. It stays running, including when there are no notes. **Watch, not wait.** The agent host keeps the command alive and consumes its output; the host chooses the provider/model and when to act. Immediate interruption of an active model call depends on that host.

## What the agent receives

Each marked, unresolved thread includes stable feedback/room/thread/file IDs, the human author and ordered conversation, feedback revision, source path and local availability, original snapshot/hash, quoted passage, Markdown heading/ranges or HTML selector context, and current anchor confidence/source revision. Native bindings identify the actual file; browser names alone cannot establish a local path. HTML rendered-text offsets must never be presented as source-code offsets.

The agent checks the quote against the current file, makes changes under its existing permissions, and reports by feedback ID in its dialogue. Missing or ambiguous source references remain explicit. Reading, copying and watching do not resolve a thread or claim an agent has acted. External file changes refresh attn while preserving any dirty editor buffer.

## Keep manual copying immediate

- **For agent** is a durable personal mark in attn's storage. The human remains the author; room visibility stays the same.
- **Copy** (per comment, next to the time badge) and **Copy all** (the bar pinned to the rail bottom) write directly to the clipboard with the same contextual records. Document/workspace scope determines the batch; there is no per-comment selection ("Copy selected" was dropped 2026-09-10). Success is shown by the icon turning into a check, never by text.
- Exclude resolved/unmarked threads. Show a selectable-text fallback only when clipboard access fails. Never silently truncate a batch.

## Implementation and boundaries

Use the existing [room store](../../src/review/store.rs), snapshots and owner-private [file bindings/anchors](../../src/review/model.rs). Add local routing metadata and a common feedback projection. Snapshot reads use persisted local state; the watch command subscribes through the existing [native daemon](../../src/daemon.rs) and local Unix socket. No public HTTP API, required MCP adapter, agent registration, model runner or automatic reply API is needed for this workflow.

Snapshot reads work with the daemon stopped and report persisted-local freshness. Watch requires the daemon. Capture the initial snapshot and subscription without a gap; flush each output record. Human follow-ups advance a durable feedback revision. Source reloads and agent replies update context without becoming new human requests. Consumers deduplicate by scoped feedback ID and revision. Lost continuity or buffer overflow produces `reset` plus a fresh snapshot; daemon loss exits with an error so the host can restart. Every restart begins with a snapshot. No saved cursor file, acknowledgement command or resume flag is required. Ctrl-C stops watching.

V1 covers existing room-backed Markdown and HTML comments. Native marks are visible to the same machine's CLI. Hosted owner/reviewer marks persist in that browser and support direct copy; browser-only marks do not silently reach the native store. A shared comment must be imported and marked natively to reach this CLI. Cross-device mark sync, browser-to-local pairing and private comments on unshared documents remain outside this epic.

## Implementation hierarchy

| Epic | Workstream | Tasks |
| --- | --- | ---: |
| `attn-aysu.1` | Durable personal marks and contract | 4 |
| `attn-aysu.2` | Thread projection, file mapping and Markdown/HTML references | 4 |
| `attn-aysu.3` | Marking and direct copy across native/hosted/reviewer | 4 |
| `attn-aysu.4` | Snapshot CLI and isolated subprocess tests | 3 |
| `attn-aysu.5` | Continuous watch, recovery and stream tests | 4 |
| `attn-aysu.6` | Original-file refresh, agent recipes and release evidence | 5 |

`bd show attn-aysu` opens the root epic. Its 24 implementation tasks have explicit dependencies and acceptance criteria. The branch contains the shared projection, native/browser routing, direct copy UI, snapshot CLI, daemon watch stream, process tests, and agent recipe. The linked evidence records complete Rust/web gates and live original-file edits through Codex CLI and Claude Code.
