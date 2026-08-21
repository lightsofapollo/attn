---
name: clean-comments
description: "Deletes agent commentary and rewrites what survives as one plain line. Use when cleaning comments in a diff or repo."
---

# Clean Comments

Agents comment too much. They restate the code, narrate their own edits, carry
issue IDs no reader can resolve, and spend three lines where none were needed.
This skill removes that layer and rewrites what survives as one plain line.

**Edit comment text only. Never change executable code.** If a comment can only
be fixed by changing the code, report it instead — see
[references/rules.md](references/rules.md).

```text
/clean-comments [command | path]
```

| Command | Use for | Read |
| --- | --- | --- |
| `[path]` | Clean the current diff, or a file or directory when given a path | [references/cleanup.md](references/cleanup.md) |
| `all` | Clean every source file in the repository | [references/cleanup.md](references/cleanup.md) |
| `check [scope]` | Report violations without editing, for CI or PR review | [references/check.md](references/check.md) |
| `install` | Write the comment rules into the project's agent files | [references/install.md](references/install.md) |

With no argument, clean the current diff. Treat an unrecognized argument as a
path. Never widen the scope the user asked for.

## Triage

Judge every comment in scope against this ladder and stop at the first match.
[references/rules.md](references/rules.md) holds the full test and examples for
each rung.

| # | The comment… | Do |
|---|---|---|
| 1 | Is a **directive** the toolchain reads — `eslint-disable`, `# noqa`, `//go:generate`, `# type: ignore` — or a license header, shebang, or generated-file marker | **Keep exactly as written** |
| 2 | Is a **doc comment on a public interface** stating a contract | **Keep the contract**, drop padding that repeats the signature. The one-line rule does not apply |
| 3 | Is **commented-out code** | **Delete** — version control already has it |
| 4 | **Restates the code** the next line or the function name already says | **Delete** |
| 5 | **Narrates an edit** — "added", "updated", "now handles", "refactored", "as requested" | **Delete**, keeping any reason it carried |
| 6 | **Names the agent or session** — "I've", "as an AI", "Claude", "per your request" | **Delete the reference**, keep the technical content |
| 7 | **Cites an unshared tracker** a reader of this repo cannot resolve | **Delete the ID**, keep the substance |
| 8 | **Marks unfinished work** | **Rewrite** to `TODO:`, `FIXME:`, `HACK:`, or `XXX:` so tooling can find it |
| 9 | **Explains** a constraint, bug fix, unidiomatic code, or business rule | **Keep**, rewritten to one line in the style of [references/ste.md](references/ste.md) |
| 10 | **You cannot tell what it means** | **Flag it, do not delete it.** An unclear comment usually marks unclear code, which is the human's call |

## Rules of thumb

- One line, almost always. A comment that needs a paragraph is usually a sign
  the code needs work — report that rather than writing the paragraph.
- Say why, never what. The code already says what.
- Delete freely when the code is self-evident, and never when you are unsure.

## Validation

Run `bash tests/selftest.sh` after changing the bundled scripts. After any
cleanup, run `node scripts/verify.mjs`: it checks that only comment text
changed. Its failure is authoritative; its pass is strong evidence, not proof.
