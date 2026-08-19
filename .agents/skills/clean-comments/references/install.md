# Installing the guidance

`/clean-comments install` writes the comment rules into the project's agent
instruction files, so the next agent writes fewer comments worth deleting.

This is the highest-value part of the skill. Cleaning is repair; the guidance
stops the mess being made. Offer it the first time you clean a repository.

## Run it

```bash
bash scripts/install-guidance.sh --list    # which files were detected
bash scripts/install-guidance.sh           # dry run: prints the diff
bash scripts/install-guidance.sh --write   # apply
bash scripts/install-guidance.sh --write --file docs/AGENTS.md
```

It detects `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `CONVENTIONS.md`,
`.cursorrules`, `.clinerules`, `.windsurfrules`,
`.github/copilot-instructions.md`, `.claude/CLAUDE.md`, and `docs/AGENTS.md`.

## Show the diff first

Dry run is the default, and it stays that way. These files are the user's, and
they steer every future session, so:

1. Run without `--write` and show the diff.
2. Say which files it would touch.
3. Get agreement, then rerun with `--write`.

Do not create an agent file that does not exist without asking which one the
project wants. When none is found, the script says so and stops.

## Idempotence

The block is fenced:

```markdown
<!-- BEGIN clean-comments v1 -->
...
<!-- END clean-comments v1 -->
```

A rerun replaces what is between the markers, so the guidance updates in place
and never stacks up. Editing the text inside the markers is fine — the next
install overwrites it, so move anything you want to keep outside the fence.

If only one marker is present the script refuses to guess and asks for a manual
fix.

## The text

`assets/agent-guidance.md` holds the installed block. It is deliberately about
fifteen lines: an instruction file that nobody finishes reading changes no
behaviour. Keep edits to it short, and bump the version in the markers if the
shape changes.
