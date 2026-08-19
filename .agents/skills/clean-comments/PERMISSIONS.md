# Permissions

What `clean-comments` touches, and what it never touches.

## Filesystem

**Reads**

- Source files inside the scope the user asked for, to find and judge comments.
- `.beads/config.yaml`, for the local issue prefix, so tracker IDs can be
  recognised. Read only, never written.
- Agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and the
  rest of the list in `references/install.md`), during `install` only.

**Writes**

- Comment text in files inside the requested scope. Executable code is never
  changed, and `scripts/verify.mjs` exists to check it.
- The fenced guidance block in agent instruction files — only under
  `install-guidance.sh --write`, which is never the default. A dry run prints a
  diff and writes nothing.
- Temporary files from `mktemp`, removed on the same run.

**Never**

- Files outside the requested scope, including vendored trees, build output,
  and any file carrying a generated-code banner.
- `~/.ssh`, `~/.aws`, `~/.config`, keychains, environment files, or any path
  outside the repository other than `mktemp` output.
- Its own files. The skill does not modify itself.

## Network

None. No script makes a network call, and none is needed: every check is local
and static. The GitHub Actions snippet in `references/check.md` runs in the
user's CI under their own credentials and is not invoked by the skill.

## Subprocesses

`git`, always through `execFileSync` with an argument array or a quoted shell
call, so no user value reaches a shell for interpretation; plus standard POSIX
text utilities (`grep`, `sed`, `awk`, `head`, `diff`, `cmp`, `mktemp`) in the
bash helpers.

Git commands used: `rev-parse`, `ls-files`, `diff`, `show`, `cat-file`,
`symbolic-ref`. All are read-only. The skill never commits, stages, pushes,
checks out, or resets, and it does not install hooks.

## Secrets

None read, none written, none needed.

## Tools required

`git` and `node` (18 or newer). Both are used locally.

## Blast radius

Worst case is a bad comment edit inside the scope the user asked for, which
`git diff` shows and `git checkout` reverts. The skill takes no action that
leaves the working tree, so nothing it does can reach a remote, a registry, or
another machine.
