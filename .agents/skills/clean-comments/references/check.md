# Checking without editing

`/clean-comments check [scope]` reports violations and changes nothing. Use it
in CI, in PR review, or before deciding whether a cleanup is worth running.

```bash
# tr|xargs -0 keeps filenames with spaces as one argument
bash scripts/scope.sh --branch | tr '\n' '\0' | xargs -0 -r node scripts/scan.mjs
bash scripts/scope.sh --branch | tr '\n' '\0' | xargs -0 -r node scripts/scan.mjs --ci
node scripts/scan.mjs --diff-only --base origin/main src/api/user.ts
```

`--ci` exits 1 only for `commented-code`, `agent-reference`, `edit-history`,
and `tracker-reference` — the four highest-confidence rules. `long-comment`,
`comment-block`, and `restates-name` always report and never fail, because
judging them needs the code around them.

## Why this never rewrites

A check that edits code during a commit or a push is a bad trade, and the skill
does not offer one:

- It rewrites code the author already reviewed, at the moment they have
  stopped looking.
- A model in the loop makes it slow and non-deterministic, so the same commit
  can produce different files twice.
- A comment that reads as noise sometimes carries the only record of a
  constraint. That call needs a human, or at least a session where one is
  present.

Flag in CI. Fix with `/clean-comments` while the author is still reading.

## Precision over recall

The scan flags patterns, not judgements. A check nobody trusts gets disabled
within a week, so keep it quiet: prefer missing a bad comment to failing a
build over a good one. If a pattern produces a false positive on your codebase,
narrow it rather than adding an ignore list.

## GitHub Actions

```yaml
name: comments
on: pull_request

jobs:
  clean-comments:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Check comments on changed files
        env:
          SKILL: .claude/skills/clean-comments
        run: |
          bash "$SKILL/scripts/scope.sh" --base origin/${{ github.base_ref }} --branch \
            | tr '\n' '\0' | xargs -0 -r node "$SKILL/scripts/scan.mjs" --ci
```

Set `SKILL` to wherever `npx skills add gpu-cli/skills --skill clean-comments`
put the skill. Drop `--ci` to report without failing the build, which is the
right first step in a repository that has never been cleaned.

## Local pre-push hook

A pre-push hook is the one place a local check belongs: it runs after the
author is done, and it only reports.

```bash
#!/usr/bin/env bash
# .git/hooks/pre-push
SKILL=.claude/skills/clean-comments
bash "$SKILL/scripts/scope.sh" --branch \
  | tr '\n' '\0' | xargs -0 -r node "$SKILL/scripts/scan.mjs" || true
```

Leave the `|| true`. A comment finding is not a reason to block a push.
