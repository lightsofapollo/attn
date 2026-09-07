# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Development (HMR)

For local UI development, use `task dev` to start the app. This runs Vite + Rust together and enables HMR inside the wry window.

```bash
task dev
task dev ATTN_PATH=tests/fixtures/basic.md
```

For the marketing site (`site/`), use `task dev:site` — same HMR workflow against `site/src`.

For the hosted browser app (desk, `/open` import page, review rooms), use `task dev:app` and visit `/open` — it proxies to the staging relay by default, so no local relay is needed.

Optional overrides:

* `DEV_HOST` (default `127.0.0.1`)
* `DEV_PORT` (default `auto`, set explicit port like `5173` to force one)
* `ATTN_PATH` (default `.`)

## Acting on attn feedback

When a user routes margin comments to a coding agent, read them directly from
the source project:

```bash
attn feedback             # one readable snapshot
attn feedback --json      # structured snapshot
attn feedback --watch     # flushed NDJSON change stream; keep it running
```

Treat `roomId:threadId` plus `feedbackRevision` as the request identity. Source
changes have their own `sourceRevision` and do not create a new human request.
Verify the quoted/anchored context against the current source, edit the original
file, and report the feedback IDs you handled. Reading or acting does not
resolve the thread. Watch mode requires the attn daemon; reconnect after an
unexpected EOF and consume the new complete snapshot.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up

2. **Run quality gates** (if code changed) - Tests, linters, builds

3. **Update issue status** - Close finished work, update in-progress items

4. **PUSH TO REMOTE** - This is MANDATORY:

   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```

5. **Clean up** - Clear stashes, prune remote branches

6. **Verify** - All changes committed AND pushed

7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

* Work is NOT complete until `git push` succeeds
* NEVER stop before pushing - that leaves work stranded locally
* NEVER say "ready to push when you are" - YOU must push
* If push fails, resolve and retry until it succeeds
