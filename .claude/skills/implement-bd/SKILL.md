---
name: implement-bd
description: Implement a Beads issue by working through its tasks with specialized agents. Use when user wants to implement, work on, or complete a Beads issue (bd show, bd ready).
disable-model-invocation: false
user-invocable: true
argument-hint: "[issue-id]"
---

Implement the Beads issue `$ARGUMENTS` by creating a Claude Code team, delegating work to teammates, and tracking progress via both Beads and the team task list.

**Core Rule**: Exit codes determine success, not agent self-assessment. Use `bd close` only when validation passes.

## Scope Enforcement (Read This First)

**You MUST NOT modify, fix, or touch code in crates you are not implementing.**

- Only run `cargo check`/`clippy`/`nextest` on the **exact crates where you modified source files**
- Do NOT run checks on "dependent" or "downstream" crates — their compilation is not your problem
- When `cargo clippy -p mycrate` compiles dependency crates (this is normal), **IGNORE all warnings
  from other crates that appear during compilation** — they are not yours to fix
- If clippy or tests fail in a crate you did NOT modify, that is a **pre-existing issue — skip it**
- NEVER run `--workspace`, `task test:rust`, `task clippy`, or `task fmt` — they compile everything

**How to determine your crates**: `git diff --name-only | grep '^crates/' | sed 's|crates/\([^/]*\)/.*|\1|' | sort -u`

Only those crates. Nothing else. No exceptions.

## Beads Integration

### Reading Issues
```bash
bd show <id>              # Full issue details + dependencies
bd show <id> --children   # List child tasks
bd ready                  # What's unblocked and ready
bd blocked                # What's waiting on dependencies
```

### Updating Status
```bash
bd update <id> --status=in_progress   # Claim work
bd close <id> --reason="..."          # Mark complete
bd update <id> --notes="..."          # Add progress notes
```

### Creating Follow-up Work
```bash
bd create --title="..." --type=task --parent=<id>  # Add subtask
bd create --type=gate --title="Review needed"       # Create approval gate
```

## Workflow

### 1. Initialize

```bash
# Get the issue and understand scope
bd show $ARGUMENTS
bd show $ARGUMENTS --children

# Check what's ready to work on
bd ready
```

**Extract from the issue:**
- Title and description (the "what")
- Referenced planning docs (if any - look for paths like `planning/...`)
- Child tasks (if parent issue)
- Dependencies (what's blocking)

**If the issue references a planning doc**, read it to understand implementation details.

**Run pre-flight baseline on crates you'll touch** (do NOT fix pre-existing issues):
```bash
# For Rust projects — only check crates relevant to this epic
# Identify which crates you'll modify, then baseline those:
cd crates && cargo check -p <crate-name> 2>&1; echo "exit: $?"
cd crates && cargo nextest run -p <crate-name> 2>&1; echo "exit: $?"

# For TypeScript projects
bun run typecheck 2>&1; echo "exit: $?"
bun test 2>&1; echo "exit: $?"
```

**CRITICAL**: Pre-existing failures do NOT block starting work. The baseline is used later
to distinguish regressions (your fault) from pre-existing issues (not your problem).
Note which crates/tests are already failing — you'll ignore these during validation.

**Scope rule**: Only baseline and validate crates you actually edit or that depend on crates you edit.
Never run `--workspace` checks — that catches unrelated issues and wastes time.

### 2. Claim the Work

```bash
bd update <id> --status=in_progress
```

### 3. Create Team & Execute

#### 3a. Create a Claude Code Team

For ANY issue with multiple children (epic/feature), create a team:

```
TeamCreate(team_name="bd-<issue-id>", description="Implementing <issue-title>")
```

This creates:
- A shared task list all teammates can access
- A coordination hub for messaging between agents

#### 3b. For Parent Issues (epic/feature)

Work through ready children using the team for parallel execution:

```
1. bd ready --parent <id>                    # Find ready child tasks
2. For EACH ready child, create a team task:
   → TaskCreate(subject="Implement <child-id>: <title>",
                description="<full context from bd show + research>",
                activeForm="Implementing <child-id>")
3. Spawn one teammate per ready child (all in a single message):
   → Task(subagent_type="general-purpose",
          team_name="bd-<issue-id>",
          name="worker-<child-id>",
          mode="bypassPermissions",
          prompt="You are a teammate on team bd-<issue-id>. ...")
4. Assign tasks to teammates:
   → TaskUpdate(taskId="<task-id>", owner="worker-<child-id>", status="in_progress")
5. Monitor progress via incoming messages (auto-delivered)
6. When teammates complete:
   → Verify their work (check task status, run spot validation)
   → Close the corresponding Beads issue: bd close <child-id> --reason="..."
7. Check if more children unblocked: bd ready --parent <id>
8. Repeat until all children done
9. Final validation across all affected crates
10. bd close <id> --reason="All tasks complete"
11. Shutdown teammates and delete team
```

**Spawning teammates — full example (3 independent features ready):**

In a **single message**, spawn all teammates at once:

```
Task(
  subagent_type="general-purpose",
  team_name="bd-<issue-id>",
  name="worker-1",
  mode="bypassPermissions",
  prompt="You are teammate 'worker-1' on team 'bd-<issue-id>'.

Your assignment:
- Implement Beads issue <child-id-1>: <title>
- Check TaskList for your assigned task, then work on it

Workflow:
1. Call TaskList to find your task, then TaskGet to read full details
2. Mark your task in_progress: TaskUpdate(taskId=..., status='in_progress')
3. RESEARCH: Explore codebase to understand approach (use Explore agent or Grep/Glob)
4. IMPLEMENT: Write the code changes
5. VALIDATE: Run checks ONLY on crates you modified (cargo check/clippy/nextest -p <crate>)
6. Mark task completed: TaskUpdate(taskId=..., status='completed')
7. Send completion message to team lead: SendMessage(type='message', recipient='<lead-name>', content='Done: <summary>', summary='Completed <child-id>')
8. Close the Beads issue: bd close <child-id> --reason='...'

SCOPE RULES:
- Only cargo check/clippy/nextest on crates where YOU modified .rs files
- IGNORE warnings from dependency crates during compilation
- NEVER run --workspace, task test:rust, task clippy, or task fmt
- NEVER fix code in crates you didn't modify
- Use cargo nextest run (not cargo test)
- All cargo commands from crates/ directory
"
)

Task(
  subagent_type="general-purpose",
  team_name="bd-<issue-id>",
  name="worker-2",
  mode="bypassPermissions",
  prompt="You are teammate 'worker-2' on team 'bd-<issue-id>'. ..."
)

Task(
  subagent_type="general-purpose",
  team_name="bd-<issue-id>",
  name="worker-3",
  mode="bypassPermissions",
  prompt="You are teammate 'worker-3' on team 'bd-<issue-id>'. ..."
)
```

**After spawning, assign their tasks:**
```
TaskUpdate(taskId="1", owner="worker-1", status="in_progress")
TaskUpdate(taskId="2", owner="worker-2", status="in_progress")
TaskUpdate(taskId="3", owner="worker-3", status="in_progress")
```

**Teammate coordination:**
- Messages from teammates are **automatically delivered** to you — no polling needed
- Teammates go idle after each turn — this is normal. Send them a message to wake them up
- Use `SendMessage(type="message", recipient="worker-1", ...)` to communicate
- Use `SendMessage(type="broadcast", ...)` only for critical team-wide announcements
- Use `TaskList` to check overall progress

**When a teammate finishes a wave:**
```
1. Verify: check git diff, run spot validation on their crates
2. Close Beads issue: bd close <child-id> --reason="..."
3. Check for newly unblocked work: bd ready --parent <id>
4. If more work:
   → Create new team tasks via TaskCreate
   → Either assign to existing idle teammates (SendMessage to wake them)
     or spawn new teammates for new work
5. If all work done:
   → Send shutdown requests: SendMessage(type="shutdown_request", recipient="worker-1", ...)
   → TeamDelete()
```

#### 3c. For Leaf Tasks (task/bug) — No Team Needed

For single leaf tasks, work directly without creating a team:

```
1. Read the task description
2. Find referenced planning doc (if any)
3. RESEARCH phase (see Section 4)
4. IMPLEMENT phase (see Section 5)
5. VALIDATE phase (see Section 6)
6. bd close <id> --reason="..."
```

---

## 4. RESEARCH Phase (Before Each Subtask)

**CRITICAL**: Before writing ANY code, understand HOW to solve the problem.

### 4.1 Explore the Codebase

Use the Task tool with `subagent_type=Explore` to answer:

```
1. Where does similar functionality already exist?
2. What patterns does this codebase use for this type of work?
3. What modules/files will I need to modify?
4. What interfaces/types already exist that I should use?
5. Are there existing tests I can follow as examples?
```

**Example exploration prompt:**
```
Explore the codebase to understand how to implement: [task description]

Find:
1. Similar existing implementations (patterns to follow)
2. Relevant types, traits, interfaces I need to use
3. Files that will need modification
4. Existing test patterns for this area
5. Dependencies and imports I'll need

Return: file paths with line numbers, code snippets, and a recommended approach.
```

### 4.2 Read Referenced Documentation

If planning docs exist, read them:
```bash
# Look for paths like:
# - planning/...
# - docs/...
# - README.md references
```

### 4.3 Identify Test Strategy

**Determine what testing is needed BEFORE implementation:**

| Code Type | Required Tests | Validation Method |
|-----------|----------------|-------------------|
| Rust library/core | Unit tests (`#[test]`), integration tests | `cargo test` |
| Rust CLI handlers | Unit tests + TUI validation | `cargo test` + `/tmux-cli-test` skill |
| TypeScript library | Jest/Vitest unit tests | `bun test` |
| React components | Component tests + E2E | `bun test` + Playwright MCP |
| API endpoints | Integration tests | `bun test` |
| TUI/Dashboard | Visual/interaction tests | `/tmux-cli-test` skill |

### 4.4 Create Mini-Plan

Before implementation, document:

```markdown
## Task: [title]

### Approach
[1-3 sentences on HOW to solve it]

### Files to Modify
- path/to/file.rs:NN - [what change]
- path/to/other.ts:NN - [what change]

### New Files (if any)
- path/to/new.rs - [purpose]

### Test Plan
- [ ] Unit test: [what to test]
- [ ] Integration test: [what to test]
- [ ] TUI test: [if TUI changes - use /tmux-cli-test]
- [ ] E2E test: [if frontend changes - use Playwright MCP]

### Patterns to Follow
- See: path/to/example.rs:NN for similar pattern
```

**Add the mini-plan to the issue notes:**
```bash
bd update <id> --notes="Approach: [summary]. Files: [list]. Test plan: [list]."
```

---

## 5. IMPLEMENT Phase

### 5.1 For Team Teammates

When you are a teammate on a team, your implementation context comes from the team task assigned to you. The task description should contain everything you need (mini-plan, file paths, patterns).

Workflow:
1. `TaskGet(taskId=...)` — read your full task details
2. Implement the changes
3. Validate (Section 6)
4. `TaskUpdate(taskId=..., status="completed")` — mark done
5. `SendMessage(type="message", recipient="<lead>", content="...", summary="...")` — report results
6. `bd close <child-id> --reason="..."` — close the Beads issue

### 5.2 For Direct Implementation (No Team)

Implement directly or delegate to a sub-agent with full context:

Include in the delegation prompt:
- Task description from Beads issue
- Mini-plan from research phase
- Specific file paths and line numbers to modify
- Patterns/examples to follow (with file:line refs)
- Expected tests to write
- Validation commands to run

**Example delegation:**
```
Implement: [task title]

Context:
- Issue: [bd show output]
- Planning doc: [if any]

Approach (from research):
[mini-plan]

Files to modify:
- [path:line - change]

Follow patterns from:
- [path:line - example]

Write tests:
- Unit test in [path] testing [behavior]
- Integration test in [path] testing [flow]

SCOPE RULES (critical):
- Only run cargo check/clippy/nextest on crates where YOU modified .rs files
- Do NOT run checks on downstream/dependent crates — not your problem
- When cargo compiles dependency crates, IGNORE any warnings from other crates
- NEVER use `task test:rust`, `task clippy`, or --workspace
- NEVER fix clippy warnings or test failures in crates you didn't modify

After implementation, validate from crates/ dir:
cd crates && cargo check -p <affected-crate> && cargo nextest run -p <affected-crate>
```

---

## 6. VALIDATE Phase (After Each Subtask)

**CRITICAL**: Never close a task without thorough validation.
**EQUALLY CRITICAL**: Only validate crates you edited or affected. Do NOT fix unrelated issues.

### 6.1 Determine Affected Crates

Before running any checks, identify what you changed:

```bash
# List modified crates (run from crates/ dir)
git diff --name-only | grep '^crates/' | sed 's|crates/\([^/]*\)/.*|\1|' | sort -u
```

This gives you the **exact** list of `<crate-name>` values for all commands below.
Do NOT add downstream/dependent crates — only validate crates where you changed source files.

### 6.2 Basic Validation (Scoped to Affected Crates)

```bash
# Rust — run ONLY on affected crates, ALWAYS from crates/ directory
cd crates && cargo fmt --check -p <crate1> -p <crate2>
cd crates && cargo clippy -p <crate1> -p <crate2> -- -D warnings
cd crates && cargo check -p <crate1> -p <crate2>
cd crates && cargo nextest run -p <crate1> -p <crate2>

# TypeScript
bun run format --check
bun run lint
bun run typecheck
bun test
```

**Exit 0 required for affected crates only.** If a failure is in an unrelated crate you didn't
touch, ignore it — do NOT attempt to fix it. If unsure whether a failure is yours, compare
against the pre-flight baseline from Section 1.

### 6.3 Test Coverage Validation

**Verify tests were actually written:**

```bash
# Check for new test files or test functions
git diff --name-only | grep -E '(_test\.rs|\.test\.ts|\.spec\.ts|tests/)'

# For Rust, check test count in affected crates
cargo nextest run -p <crate-name> 2>&1 | tail -5
```

**If no new tests and the task required them**: FAIL validation.

### 6.4 TUI/Dashboard Validation

**For changes affecting TUI, CLI interactive prompts, or terminal rendering:**

Use the `/tmux-cli-test` skill to validate.

### 6.5 Frontend/UI Validation

**For React/Next.js component or page changes:**

Use Playwright MCP for E2E testing:
- Component renders correctly
- User interactions work
- Accessibility requirements met
- Responsive behavior correct

### 6.6 Validation Checklist

Before closing any task, verify **for affected crates only**:

```
[ ] Tests pass in affected crates (cargo nextest run -p <crate>)
[ ] New tests written for new functionality
[ ] No NEW clippy warnings in affected crates (compare against baseline)
[ ] Code formatted in affected crates (cargo fmt -p <crate>)
[ ] cargo check passes for affected crates
[ ] If TUI: /tmux-cli-test validation passed
[ ] If frontend: Playwright validation passed
[ ] Manual spot-check of changed behavior (if applicable)
```

**NOT required:**
- Fixing pre-existing test failures in unrelated crates
- Fixing pre-existing clippy warnings in unrelated crates
- Making `--workspace` commands exit 0 when they didn't before you started

---

## 7. On Validation Failure

**First: classify the failure.**

| Failure Type | How to Identify | Action |
|---|---|---|
| **Regression** (you caused it) | New failure not in pre-flight baseline, in a crate you modified | Fix it |
| **Pre-existing** (not your fault) | Was in pre-flight baseline, or in an unrelated crate | **Ignore it** — do NOT fix |
| **Unclear** | Can't tell if it's new or old | Compare against baseline logs |

**For regressions only:**

1. **Stop** - don't proceed to next task
2. **Report** with file:line errors and exit codes
3. **Attempt ONE fix**, then re-validate the affected crate
4. **If still failing**: Ask user (or notify team lead if you're a teammate):
   - Continue fixing
   - Skip this task (add note to issue)
   - Pause for manual debugging

**For pre-existing failures:**

- **Do NOT fix them** — they are out of scope
- Optionally note them: `bd create --type=bug --title="Pre-existing: [description]" --priority=4`
- Proceed with your work — pre-existing failures do not block closing your task

---

## 8. Task Completion

**If validation passes:**
```bash
bd close <id> --reason="Implemented and validated. [summary of changes]. Tests: [N new tests added]."
```

**If you're a teammate, also:**
```
TaskUpdate(taskId=..., status="completed")
SendMessage(type="message", recipient="<lead>", content="Completed <id>: <summary>", summary="Done: <id>")
```

**Check if more work unblocked:**
```bash
bd ready  # See what's now available
```

---

## 9. Phase/Feature Completion & Team Shutdown

When all children of a parent are done:

```bash
# Verify all children closed
bd show <parent-id> --children  # All should be closed

# Run tests one more time on all affected crates
cargo nextest run -p <crate1> -p <crate2>  # or bun test

# Close the parent
bd close <parent-id> --reason="All tasks complete. Affected crate tests passing."
```

**Shut down the team:**
```
# Send shutdown requests to all teammates
SendMessage(type="shutdown_request", recipient="worker-1", content="All work complete")
SendMessage(type="shutdown_request", recipient="worker-2", content="All work complete")
SendMessage(type="shutdown_request", recipient="worker-3", content="All work complete")

# After all teammates confirm shutdown:
TeamDelete()
```

---

## 10. Review & Commit

After completing the requested scope:

1. **Review changes** using git-changes-reviewer agent
2. **Run security audit** if security-sensitive code was touched
3. **Commit** if requested: `Skill(skill: "commit-push")`

Note: Beads syncing is handled automatically by git hooks.

---

## 11. Final Report

```
Implementation Complete: <issue-id> - <title>

Team: bd-<issue-id>
Teammates spawned: [N]
Tasks completed: [N/M]

Research:
- Explored: [N files/modules]
- Patterns followed: [list key patterns used]

Implementation:
- Files modified: [N]
- Lines changed: +X/-Y

Validation:
- Unit tests: [N new, M total passing]
- Integration tests: [status]
- TUI tests: [status - via /tmux-cli-test]
- E2E tests: [status - via Playwright]
- All checks: PASSING

Remaining Work:
- [list any blocked or deferred tasks]
```

---

## Security Gates

Create gates when implementation requires human action or review:

**When to create a gate:**
- Security-sensitive code (encryption, keys, auth)
- Secrets or .env vars that need to be added (agent doesn't have access)
- API keys, tokens, or credentials that must be configured
- Infrastructure changes requiring manual approval

**How to create:**
```bash
bd create --type=gate --title="Action needed: [description]" --parent=<id>
bd update <gate-id> --notes="Requires: [specific action needed, e.g., 'Add STRIPE_SECRET_KEY to .env']"
```

---

## Issue Type Handling

| Type | Approach |
|------|----------|
| `epic` | Create team, spawn teammates for child features/tasks, close when all done |
| `feature` | Create team if multiple children, spawn teammates, close when all done |
| `task` | Implement directly (no team needed for single tasks) |
| `bug` | Research root cause, fix, add regression test, validate, close |
| `gate` | Cannot implement - needs human approval, skip |

---

## Planning Doc Detection

Look for patterns in issue description/notes:
- `planning/...`
- `See: planning/...`
- `Reference: docs/...`
- Markdown links to `.md` files

If found, read the planning doc before the research phase.

---

## Creating Work During Implementation

**At any point during implementation**, create new Beads issues for:
- **Bugs discovered** - `bd create --type=bug --title="..." --parent=<current-id>`
- **Subtasks identified** - `bd create --type=task --title="..." --parent=<current-id>`
- **Technical debt** - `bd create --type=task --title="Refactor: ..." --priority=3`
- **Follow-up features** - `bd create --type=feature --title="..."`
- **Blocking issues** - `bd create --type=gate --title="Needs: ..."`

Don't try to fix everything in one pass. Create issues for out-of-scope discoveries.

---

## Team Communication Patterns

### Team Lead (you) to Teammate
```
SendMessage(type="message", recipient="worker-1", content="Additional context: ...", summary="Extra context for task")
```

### Teammate to Team Lead
```
SendMessage(type="message", recipient="<lead-name>", content="Completed: ...", summary="Task done")
SendMessage(type="message", recipient="<lead-name>", content="Blocked: ...", summary="Need help with X")
```

### Broadcast (use sparingly — expensive)
```
SendMessage(type="broadcast", content="Stop work: critical issue found", summary="Blocking issue found")
```

### Reassigning Work
```
# If a teammate is stuck, reassign their task
TaskUpdate(taskId="3", owner="worker-2")  # Reassign to different teammate
SendMessage(type="message", recipient="worker-2", content="Taking over task 3, see TaskGet for details", summary="Reassigned task 3")
```

### Handling Idle Teammates
Teammates go idle after every turn — this is **normal**. To assign new work:
```
# Create new task
TaskCreate(subject="Implement next child", description="...", activeForm="Implementing next child")
# Assign and wake the idle teammate
TaskUpdate(taskId="4", owner="worker-1")
SendMessage(type="message", recipient="worker-1", content="New task assigned: see TaskList", summary="New work available")
```

---

## Key Principles

1. **Research before code** - understand HOW before implementing
2. **Beads is the source of truth** - always update Beads status (bd close/update)
3. **Team tasks for coordination** - use TaskCreate/TaskUpdate for intra-team work tracking
4. **Stay in scope** - only fix code related to your epic, never chase unrelated failures
5. **Regressions are your problem, pre-existing issues are not** - compare against baseline
6. **Scope validation to affected crates** - use `-p <crate>`, never `--workspace`
7. **Never use `task` commands for validation** - `task test:rust` etc. run `--workspace`, use direct `cargo` with `-p`
8. **Use `cargo nextest run`** - not `cargo test` — faster and better output
9. **Tests are mandatory** - no close without validation of YOUR changes
10. **Use proper test tools** - `/tmux-cli-test` for TUI, Playwright for frontend
11. **Respect dependencies** - only work on unblocked tasks
12. **Report honestly** - partial success = still open
13. **Create gates for blockers** - when you need human action, don't get stuck
14. **Shut down your team** - always send shutdown requests and TeamDelete when done

---

## Example Invocations

```
/implement-bd cli-k1a.1.1
# Single leaf task — implements directly, no team needed

/implement-bd cli-k1a.1
# Feature with children — creates team "bd-cli-k1a.1", spawns teammates for ready children

/implement-bd cli-k1a
# Epic — creates team "bd-cli-k1a", spawns teammates for ready features/tasks, manages waves
```

---

## Error Recovery

If the agent crashes or session ends:
```bash
bd list --status=in_progress  # Find orphaned Beads work
bd update <id> --status=open  # Reset to open if not done
```

Team state is ephemeral — if the session dies, the team is gone. Beads persists across sessions.

---

## Testing Tools Quick Reference

### Unit/Integration Tests
```bash
# Rust — always scope to affected crates, never --workspace
cargo nextest run -p <crate-name>
cargo nextest run -p <crate-name> -- test_name

# TypeScript
bun test
bun test --grep "pattern"
```

### TUI Testing
Use the `/tmux-cli-test` skill which provides:
- `tmux_start`, `tmux_wait_for`, `tmux_send`, `tmux_assert_contains`
- Condition-based waiting (never sleeps)
- Full keyboard interaction support
- Frame capture for assertions

### Frontend E2E Testing
Use Playwright MCP or:
```bash
bunx playwright test
bunx playwright test --grep "pattern"
bunx playwright test --ui  # Interactive mode
```
