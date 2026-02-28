---
name: plan-to-beads
description: |
  Convert a planning folder into well-structured Beads issues optimized for parallel agent execution via implement-bd.

  Use when asked to:
  - Import/convert a planning folder to Beads
  - Create issues/beads from planning docs
  - Bootstrap Beads from markdown plans
  - Set up work tracking for a planning folder
  - "Turn this plan into beads" or "create beads for planning/my-feature"
  - Break down a plan into parallelizable work items

  Reads planning folders (README.md, architecture.md, XX-*.md), extracts dependency graphs,
  and creates epics/features/tasks with correct parent-child relationships and dependency edges.
  Produces issues that implement-bd can pick up and execute, potentially in parallel.
---

# Plan to Beads

Convert a planning folder into Beads issues structured for parallel agent execution.

## Goal

Read a planning folder, understand the work and its dependencies, and produce a minimal set of well-scoped Beads issues that:
- Can be picked up by `implement-bd` agents
- Maximize parallelism (only add deps where truly required)
- Include plan references so agents have full context
- Include inline verification in every implementation task so broken code is caught immediately
- Include feature-level validation tasks for integration/E2E testing before dependents start

## Step 1: Read the Planning Folder

Read **every file** in the folder. Planning folders vary in structure:

```
planning/<topic>/
├── README.md              # Overview, order, success criteria, deps
├── architecture.md        # Design (optional)
├── 00-infrastructure.md   # Phase files (numbered, may or may not have -impl suffix)
├── 01-foundation.md
├── 02-feature-a-impl.md
└── ...
```

Variations to handle:
- Files may be `XX-name.md` or `XX-name-impl.md`
- Some folders have `architecture.md`, some don't
- Some folders are a single standalone `.md` file (no subfolder)
- Phase numbering may start at 00 or 01

**Read all files.** Extract from each:

| File | Extract |
|------|---------|
| README.md | Title, overview, phase list with deps, success criteria, key decisions |
| architecture.md | Design context (pass through to epic description) |
| XX-*.md | Phase title, purpose, steps (### Step N or ### sections), pre-conditions, validation/testing section, acceptance criteria |

## Step 2: Build the Dependency Graph

**Do not assume linear ordering.** Read the README's dependency section (often a mermaid diagram or text list) and each phase's "Depends on" lines. Build the actual graph:

```
# Example from company-agent-tui-v2:
# Phase 0 → Phase 1 → Phase 2 (needs Phase 0 too)
#                    → Phase 3 (parallel with 2)
#                    → Phase 4 (parallel with 2, 3)
# Phase 2,3,4 → Phase 5
```

Rules:
- If README says "Phase 3 and 4 can run in parallel" - no dep between them
- If a phase says "Depends on: Phase 1" - add that single dep, not all prior phases
- If no dependency info exists, fall back to sequential ordering by number
- Tasks within a phase are parallel by default unless a step says "after Step N"

## Step 3: Check for Duplicates

```bash
bd list --status=all 2>/dev/null
```

If issues with matching titles already exist, skip creating them. Warn the user about skipped duplicates.

## Step 4: Design the Issue Hierarchy

Before creating anything, plan the full hierarchy. Use this mapping:

| Planning Element | Beads Type | When |
|-----------------|------------|------|
| Planning folder | `epic` | Always 1 per folder (rarely 2+ if truly independent workstreams) |
| Phase file (XX-*.md) | `feature` | 1 per phase file |
| Step within phase | `task` | 1 per `### Step` or meaningful section |
| Feature validation | `task` | 1 per feature, always the last child — integration/E2E testing |

### Task Scoping Guidelines

Each task should be **completable in a single implement-bd session** (~30-60 min of agent work). If a step in the plan is too large:
- Split into sub-tasks with clear boundaries
- Each sub-task should modify a bounded set of files
- Each sub-task should be independently testable

If a step is trivial (< 5 min), merge it with an adjacent step into one task.

### Inline Verification (Every Implementation Task)

**Every implementation task MUST include a `## Verification` section** with specific checks the agent runs after writing code. This catches broken work immediately rather than deferring all testing to the end.

The verification section should include:
- **Build check**: Does it compile / pass typecheck? (`cargo build -p <crate>`, `bun run check`)
- **Unit tests**: Run existing + newly written tests for the code touched (`cargo nextest run -p <crate>`, `bun test <file>`)
- **Smoke test**: A quick sanity check that the feature actually works (run the binary, call the endpoint, render the component)

The agent should NOT mark the task complete if verification fails. Fix it first.

Example verification section for a task:
```
## Verification
- `cd crates && cargo build -p game-engine` (compiles without errors)
- `cd crates && cargo nextest run -p game-engine -E 'test(map::)'` (map unit tests pass)
- Create a 10x10 map, place 3 entities, verify they appear at correct coordinates
```

### Feature Validation Task (Integration/E2E)

Every feature gets a validation task as its last child. Unlike inline verification (which tests individual pieces), this task tests the **feature as a whole** — integration between the pieces, E2E workflows, and edge cases.

The validation task:
- Depends on all other tasks in that feature
- Tests cross-task integration (do the pieces work together?)
- Runs E2E scenarios from the plan's validation section
- Verifies acceptance criteria for the feature, not individual steps

## Step 5: Create Issues

Create in this order: epic first, then features (capturing IDs), then tasks under each feature.

### Epic

```bash
bd create \
  --title="<Title from README>" \
  --type=epic \
  --priority=2 \
  --description="$(cat <<'EOF'
<Overview from README, 2-4 sentences>

## Success Criteria
<Checklist from README>

## Architecture
<Key decisions summary, 2-3 bullets - or "See architecture.md">

## Plan Reference
- planning/<folder>/README.md
- planning/<folder>/architecture.md
EOF
)"
```

Capture the epic ID from output.

### Features (one per phase)

```bash
bd create \
  --title="<Phase Title>" \
  --type=feature \
  --parent=<epic-id> \
  --priority=2 \
  --description="$(cat <<'EOF'
<Phase overview, 1-2 sentences>

## Scope
<What this phase delivers>

## Pre-conditions
<From phase file, if any>

## Plan Reference
- planning/<folder>/XX-phase.md
EOF
)"
```

Capture each feature ID. Title should be descriptive (not "Phase 1: Foundation" but "Zoom Navigation Foundation" or "Daemon Core with IPC").

### Tasks (one per step)

```bash
bd create \
  --title="<Descriptive action title>" \
  --type=task \
  --parent=<feature-id> \
  --priority=2 \
  --description="$(cat <<'EOF'
<What to implement and why, 1-3 sentences>

## Files
<Files to create/modify, from the plan>

## Approach
<Key implementation notes from the plan>

## Verification
<Specific checks to run after implementing — build, tests, smoke test>
<Agent must pass these before marking the task complete>

## Plan Reference
- planning/<folder>/XX-phase.md (Step N)
EOF
)"
```

Task titles should be action-oriented: "Implement ZoomLevel state machine", "Add BeadStore trait to agent-db", "Wire daemon to ActivityTracker".

**The Verification section is mandatory.** Tailor it to the task:

| Task type | Verification example |
|-----------|---------------------|
| Rust module | `cargo build -p <crate>` + `cargo nextest run -p <crate> -E 'test(module::)'` + smoke test |
| TypeScript module | `bun run check` + `bun test <file>` + import and call from REPL |
| React component | `bun run check` + `bun test` + render in browser via Playwright |
| API endpoint | `cargo build -p <crate>` + `cargo nextest run` + curl the endpoint |
| Config/schema | Validate parsing + round-trip test |

### Feature Validation Task (Integration/E2E)

```bash
bd create \
  --title="Validate: <Feature Name>" \
  --type=task \
  --parent=<feature-id> \
  --priority=2 \
  --description="$(cat <<'EOF'
Integration and E2E validation for <feature>. Individual tasks have already verified their own
pieces — this validates they work together as a complete feature.

## Integration Scenarios
<Cross-task workflows, e.g. "Create map → place entities → save → reload → verify positions">

## E2E Test Commands
<Commands that exercise the full feature path>

## Acceptance Criteria
<Feature-level pass/fail from the plan>

## Plan Reference
- planning/<folder>/XX-phase.md (Validation section)
EOF
)"
```

Integration testing approach by component type:

| Component | Method | Notes |
|-----------|--------|-------|
| Rust library | `cargo nextest run -p <crate>` (integration tests) | Cross-module integration tests |
| Rust CLI/TUI | tmux-cli-test skill | Full user workflow tests |
| TypeScript | `bun test` (integration suites) | Cross-module integration |
| React/Next.js | Playwright MCP | Full user journey E2E tests |
| API endpoints | Multi-step curl sequences | Workflow validation (create → read → update → delete) |
| gRPC | Stream lifecycle tests | Connect → stream → reconnect → verify state |

## Step 6: Set Up Dependencies

Apply the dependency graph from Step 2 using **feature-level deps** (not task-level across features):

```bash
# Feature-level: Phase 2 depends on Phase 1
bd dep add <phase-2-feature-id> <phase-1-feature-id>

# Within a feature: validation depends on all impl tasks
bd dep add <validate-task-id> <impl-task-1-id>
bd dep add <validate-task-id> <impl-task-2-id>
```

**Dependency rules:**
- Feature deps follow the graph from Step 2 (NOT always linear)
- Validation task depends on all sibling tasks in its feature
- Tasks within a feature are parallel unless plan says otherwise
- Do NOT create cross-feature task-level deps (use feature-level deps instead)

**Parallel features** (no dep between them) let multiple implement-bd agents work simultaneously.

## Step 7: Verify and Sync

```bash
# Check structure
bd show <epic-id> --children

# Verify parallel work exists
bd ready

# Check nothing is incorrectly blocked
bd blocked

# Sync to git
bd sync
```

**Verify:**
- `bd ready` shows tasks from independent features (parallel work available)
- `bd blocked` shows only tasks that genuinely need prior work
- Every feature has a validation task
- Epic has all features as children

## Step 8: Report

Print a summary:

```
Created Beads for: <planning folder>

Epic: <title> (<id>)
  Feature: <title> (<id>) - N tasks
  Feature: <title> (<id>) - N tasks [parallel with above]
  Feature: <title> (<id>) - N tasks [depends on <id>]
  ...

Parallelism: <N> features can start immediately
Total tasks: <N> (including <N> validation tasks)

Next: Run `bd ready` to see what's actionable, or use implement-bd to start working.
```

## Playwright MCP for Frontend Validation

For any task or feature validation involving a web UI (React, Next.js, dashboard), use **Playwright MCP** for verification. This applies to both inline verification in implementation tasks and feature-level validation tasks.

Inline verification example (implementation task):
```
## Verification
- `bun run check` (typecheck passes)
- `bun test` (unit tests pass)
- Use Playwright MCP to navigate to the map editor, create a 10x10 map, verify grid renders correctly
```

Feature validation example:
```
## Integration Scenarios
- Use Playwright MCP: open dashboard → navigate to maps → create map → add entities → save → reload → verify state persisted
- Use Playwright MCP: test responsive layout at 1024px and 1440px widths
```

Always prefer Playwright MCP over manual `curl` or screenshot-based testing for anything rendered in a browser.

## Example

For `planning/company-agent-tui-v2/` with its dependency graph:

```
Epic: TUI v2 Zoom Interface
├── Feature: BeadStore Infrastructure        ← ready immediately
│   ├── Task: Add BeadsIssue type to agent-db        [verify: cargo build + unit tests]
│   ├── Task: Implement BeadStore trait               [verify: cargo build + trait tests]
│   └── Task: Validate: BeadStore Infrastructure      [integration: full CRUD round-trip]
├── Feature: Zoom Navigation Foundation      ← depends on Infrastructure
│   ├── Task: Implement ZoomLevel state machine       [verify: build + state transition tests]
│   ├── Task: Rewrite app.rs with zoom shell          [verify: build + renders without panic]
│   ├── Task: Implement global + per-zoom keybindings [verify: build + keybinding unit tests]
│   └── Task: Validate: Zoom Navigation               [integration: tmux full nav workflow]
├── Feature: Fleet View                      ← depends on Infrastructure + Foundation
│   ├── Task: Implement beads tree widget             [verify: build + widget render test]
│   ├── Task: Add fleet command dispatch              [verify: build + dispatch unit tests]
│   └── Task: Validate: Fleet View                    [integration: tmux tree nav + commands]
├── Feature: Agents View                     ← depends on Foundation only (PARALLEL with Fleet)
│   ├── Task: Implement session list from SessionStore [verify: build + list render test]
│   ├── Task: Add quick actions via factory_command    [verify: build + action unit tests]
│   └── Task: Validate: Agents View                    [integration: tmux session workflow]
├── Feature: Session View                    ← depends on Foundation only (PARALLEL with Fleet, Agents)
│   ├── Task: Implement conversation renderer          [verify: build + render test]
│   ├── Task: Add input via ChatBackend                [verify: build + input unit tests]
│   └── Task: Validate: Session View                   [integration: tmux chat E2E]
└── Feature: Gates Overlay                   ← depends on ALL above
    ├── Task: Filter beads_issue by gate type          [verify: build + filter tests]
    ├── Task: Handle OpenCode permission requests      [verify: build + handler tests]
    └── Task: Validate: Gates Overlay                  [integration: full gate approve/reject flow]
```

Parallelism: After Foundation completes, Fleet/Agents/Session can all run simultaneously with 3 agents.
