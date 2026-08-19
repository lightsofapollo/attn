# Cleaning comments

The workflow behind `/clean-comments [path]` and `/clean-comments all`.

## 1. Resolve the scope

```bash
bash scripts/scope.sh              # changed files: staged, unstaged, untracked
bash scripts/scope.sh --branch     # everything this branch changed vs. its base
bash scripts/scope.sh src/api      # a path, file or directory
bash scripts/scope.sh --all        # every source file in the repository
```

The script prints one path per line. It excludes vendored trees, build output,
minified bundles, lockfiles, and files carrying a generated-code banner.

Default to the changed-files scope. Widen only when the user asked for it. In
the changed-files scope, judge only comments the diff touched — a comment that
was already in the file and is untouched by the diff is out of scope, however
bad it looks. Report the worst of those in Flagged rather than editing them.

If the scope resolves to nothing, say so and stop.

## 2. Find candidates

```bash
node scripts/scan.mjs <file>...            # TSV findings on stdout
node scripts/scan.mjs --json <file>...
node scripts/scan.mjs --diff-only <file>...  # only lines the working diff touched
```

Each finding is `file<TAB>line<TAB>rule<TAB>text`. The rules it detects
mechanically are `commented-code`, `agent-reference`, `edit-history`,
`tracker-reference`, `long-comment`, `comment-block`, and `restates-name`.

The scan is a filter, not a verdict. It finds high-signal patterns cheaply so
you read less; it cannot judge whether a comment explains something real. Two
consequences:

- Every finding still needs the triage ladder applied by reading the code.
- A comment the scan missed is still in scope. Read the diff or the file, not
  just the scan output.

## 3. Read before editing

For each candidate, read enough surrounding code to answer one question: does
this comment tell the reader something the code does not? You cannot answer it
from the comment alone. Do not skip this for comments that look obviously
disposable — a line that reads like narration sometimes carries the only record
of a constraint.

## 4. Apply the ladder

Walk each comment down the triage ladder in `SKILL.md` and stop at the first
rung that matches. [rules.md](rules.md) has the full test for each rung, and
[ste.md](ste.md) has the style for anything you keep or rewrite.

Edit comment text only. Never change executable code, even to fix something
obvious that you notice on the way — note it in Flagged instead.

Delete a whole comment by deleting its lines, including the now-blank line if
one is left behind. Never leave an empty `//` or a bare `#` where a comment
was.

## 5. Verify

```bash
node scripts/verify.mjs               # working tree vs. HEAD
node scripts/verify.mjs --base <ref>  # vs. another ref
```

It strips comments from both versions of every changed file and compares what
is left. Identical means only comment text moved.

A failure means an edit changed code. Revert that file and redo it. Never
report a cleanup whose verification failed. Files the check could not compare
are listed as unchecked — say so in the report rather than folding them into
the pass.

The comment stripper is quote-aware but heuristic; it is a backstop against a
slipped edit, not a proof. A clean run does not excuse careless editing, and an
unexpected failure in a language with unusual comment syntax is worth reading
before you dismiss it.

## 6. Report

Show the user what changed before they commit. Group by outcome, not by file,
so the ratio is legible at a glance.

```markdown
## clean-comments — <scope>

Deleted 14 · Rewrote 6 · Kept 31 · Flagged 2

### Deleted
| Location | Comment | Rung |
| --- | --- | --- |
| `src/api/user.ts:42` | `// Loop through the users` | 4 restates the code |

### Rewritten
| Location | Before | After |
| --- | --- | --- |
| `src/cache.py:88` | `# We use a lock here to make sure...` | `# Lock: concurrent writers corrupt the cache.` |

### Flagged
| Location | Finding |
| --- | --- |
| `src/parse.go:19` | Comment contradicts the code: says "returns nil", returns an error. |
| `src/report.rs:204` | Needs four lines of comment to follow; consider splitting the function. |
```

Keep Flagged short and specific. It is the part a human must act on, and it is
where rules 2, 3, and 4 land: comments that excuse unclear code, comments you
could not make clear, and comments that confuse or contradict.

State the counts even when nothing changed. "Reviewed 31 comments in 8 files,
changed none" is a useful result and a common one in a well-kept repository.

## Scope reminders

- Cleaning `all` in a repository nobody has cleaned before produces a large
  diff. Say so up front, and offer to go directory by directory instead.
- Never combine a cleanup with any other edit in the same commit. A
  comment-only diff is reviewable at a glance; a mixed one is not.
