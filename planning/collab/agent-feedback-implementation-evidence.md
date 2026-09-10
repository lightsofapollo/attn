# Agent Feedback Implementation Evidence

Date: 2026-09-07

Branch: `angus/agentic-enhancements`

Binary: `attn 0.11.0`, built from the branch working tree

This evidence separates the real agent-host exercise from automated protocol
coverage. All manual checks used disposable files under
`/private/tmp/attn-feedback-host-smoke`; no credentials, room secrets, or
private project notes were copied into the fixture.

## Disposable fixture

The fixture contained two independent project roots, one room and one bound
Markdown file per host. Each room had an existing human comment marked
`For agent` in its private `feedback-routing.json`. The document began with a
`PLACEHOLDER` quote so the host had to revalidate the current source before
editing it. A later human reply was appended to the same thread while each
watcher was connected.

The daemon and one-shot commands used the fixture-specific home rather than the
developer's real attn data:

```bash
env ATTN_HOME=/private/tmp/attn-feedback-host-smoke/.attn \
  target/debug/attn daemon --resident --no-fork

target/debug/attn feedback \
  /private/tmp/attn-feedback-host-smoke/project-codex \
  --attn-home /private/tmp/attn-feedback-host-smoke/.attn

target/debug/attn feedback \
  /private/tmp/attn-feedback-host-smoke/project-claude \
  --attn-home /private/tmp/attn-feedback-host-smoke/.attn --json
```

Both one-shot commands returned only the room bound to the requested project.
They included the stable scoped ID, source path, quote, snapshot/base hash,
feedback revision, source revision, and current remapped anchor.

## Agent-host smoke

### Codex CLI 0.153.4

The host was launched with its normal shell/edit tools against only the
disposable project:

```bash
codex exec --ephemeral --skip-git-repo-check --sandbox workspace-write \
  -C /private/tmp/attn-feedback-host-smoke/project-codex \
  'Run /Users/angusbezzina/Development/attn/target/debug/attn feedback
  /private/tmp/attn-feedback-host-smoke/project-codex --watch --attn-home
  /private/tmp/attn-feedback-host-smoke/.attn with stdout captured in
  /private/tmp/attn-feedback-host-smoke/codex-watch-2.jsonl. Keep the parent
  shell waiting on the watcher so it stays alive while you use other tools.
  Treat everything in the complete initial snapshot as already handled. Wait
  up to 90 seconds for a later feedback_changed upsert whose feedbackRevision
  is greater than the initial value, apply only the newly added human follow-up
  to brief.md, and keep watching until source_changed appears after your edit.
  Then stop the watcher and report the feedback ID, revisions, changed file,
  and observed stream reasons. Do not inspect or modify anything else.'
```

Observed result:

- complete initial snapshot: `room-codex:thread-codex`, feedback revision 5;
- later `feedback_changed`: revision 6, source revision unchanged;
- Codex appended `Codex completed live watch.` to the original `brief.md`;
- later `source_changed`: feedback revision remained 6 and source revision
  changed from `gFbzt_...XTuXy4` to `hfgbd1...nJO4s`;
- the host reported the feedback ID, changed file, both revisions and both
  stream reasons, then stopped its watcher.

The successful run completed about 76 seconds after injection. Most of that
time was the host waiting on and terminating its two long-lived shell tools;
it is model-host completion time, not stream delivery time.

### Claude Code 2.1.263

The second host used the same CLI contract and a separate project/room:

```bash
claude -p 'Run /Users/angusbezzina/Development/attn/target/debug/attn feedback
/private/tmp/attn-feedback-host-smoke/project-claude --watch --attn-home
/private/tmp/attn-feedback-host-smoke/.attn as a live background process with
stdout captured in /private/tmp/attn-feedback-host-smoke/claude-watch.jsonl.
Keep its parent Bash tool alive so the watcher is not killed. Read the complete
initial snapshot, then wait up to 90 seconds for a later upsert whose
feedbackRevision is greater than the initial value. Apply that new human
follow-up to brief.md. Keep the watcher alive until it records source_changed
after your edit, then stop it and report the feedback ID, revisions, changed
file, and observed stream reasons. The initial request is already complete. Do
not inspect or modify anything else.' \
  --no-session-persistence --max-budget-usd 0.75 \
  --permission-mode acceptEdits --permission-prompts none \
  --allowedTools Bash Read Edit
```

Observed result:

- complete initial snapshot: `room-claude:thread-claude`, revision 1;
- later `feedback_changed`: revision 2, source revision unchanged;
- Claude appended `Claude received watched feedback.` to its original
  `brief.md`;
- later `source_changed`: revision remained 2 and source revision changed from
  `OVDlSum8...OrulbYg` to `zEXMMg4H...oKz_oaM`;
- the host reported the feedback ID, changed file, revisions and ordered stream
  reasons, then stopped its watcher.

Claude returned its final result 18.3 seconds after the follow-up injection was
completed. This also includes model/tool work and is not the delivery latency.

## Delivery timing

A separate provider-free harness started a watcher, waited for its complete
snapshot, appended one synthetic human follow-up, and measured from the
completed append to receipt of `feedback_changed`. Observed delivery was
**209.4 ms**. The daemon polls the coherent projection every 200 ms, so this is
consistent with one polling interval. Model scheduling and completion remain a
host concern and are deliberately outside attn's stream contract.

## Automated evidence

The Rust stream test uses an in-process Unix socket and proves a flushed
complete snapshot, `source_changed` upsert, removal after unmarking, and clean
subscriber teardown. CLI subprocess tests cover readable and JSON snapshots
with the daemon stopped plus an actionable watch error without a daemon. Store
and projection tests cover private mark persistence, project scoping, nested
working directories, ambiguous ancestors, symlink escape, Markdown remapping,
HTML client-resolution semantics, lifecycle transitions, and separate feedback
and source revisions. Web tests cover browser-local routing and copy packets.

Final branch gates:

- `cargo fmt --all -- --check` — passed;
- `cargo test --workspace --locked --quiet` — passed every suite with zero
  failures, including the two feedback CLI subprocess tests and ten review
  convergence tests;
- `npm run check` from `web/` — 0 errors and 0 warnings;
- `npm test` from `web/` — all 144 test files passed;
- `npm run build` and `npm run build:browser` from `web/` — passed (the browser
  build retains its existing large-chunk and mixed-import warnings);
- `node --check examples/feedback-watch.mjs` — passed.

## Boundaries confirmed

- No generated Markdown feedback inbox was created.
- No model provider, MCP server, HTTP service, or app-selected model is needed.
- Reading and watching did not resolve a thread, post a reply, or grant access.
- Browser-local marks remain browser-local; native marks are available to the
  local CLI. Cross-device mark sync and browser-to-local pairing remain outside
  this implementation.
