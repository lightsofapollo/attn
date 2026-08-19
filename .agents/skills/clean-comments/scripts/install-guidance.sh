#!/usr/bin/env bash
# Writes the comment rules into a project's agent instruction files.
#
# Usage:
#   install-guidance.sh                  show what would change (default)
#   install-guidance.sh --write          apply it
#   install-guidance.sh --file <path>    target one file instead of detecting
#   install-guidance.sh --list           list detected agent files and exit
#
# Idempotent: the block is fenced by markers, so a second run replaces the
# block instead of appending a copy. Dry run is the default because these are
# the user's files, not the skill's.

set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

GUIDE="$SELF_DIR/../assets/agent-guidance.md"
BEGIN='<!-- BEGIN clean-comments v1 -->'
END='<!-- END clean-comments v1 -->'
MARKER_RE='<!-- BEGIN clean-comments'
END_RE='<!-- END clean-comments'

CANDIDATES=(
  CLAUDE.md AGENTS.md GEMINI.md CONVENTIONS.md
  .cursorrules .clinerules .windsurfrules
  .github/copilot-instructions.md .claude/CLAUDE.md docs/AGENTS.md
)

write=0
list=0
targets=()

while [ $# -gt 0 ]; do
  case "$1" in
    --write) write=1 ;;
    --list) list=1 ;;
    --file) shift; targets+=("${1:?--file needs a path}") ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) cc_die "unknown option: $1" ;;
  esac
  shift
done

[ -f "$GUIDE" ] || cc_die "missing guidance asset: $GUIDE"
cc_require_repo
root=$(git rev-parse --show-toplevel)

if [ ${#targets[@]} -eq 0 ]; then
  for c in "${CANDIDATES[@]}"; do
    [ -f "$root/$c" ] && targets+=("$root/$c")
  done
fi

if [ ${#targets[@]} -eq 0 ]; then
  echo "clean-comments: no agent instruction file found."
  echo "Looked for: ${CANDIDATES[*]}"
  echo "Create one, then rerun, or pass --file <path>."
  exit 0
fi

if [ "$list" -eq 1 ]; then
  printf '%s\n' "${targets[@]}"
  exit 0
fi

block=$(printf '%s\n%s\n%s\n' "$BEGIN" "$(cat "$GUIDE")" "$END")

for f in "${targets[@]}"; do
  [ -f "$f" ] || { echo "clean-comments: no such file: $f" >&2; continue; }
  rel=${f#"$root"/}

  # A marker inside a code fence is documentation of the marker, not the
  # marker: replacing "the block" there corrupts the user's example. Only a
  # marker outside any fence counts.
  find_marker() {
    awk -v pat="$1" '
      /^(```|~~~)/ { fence = !fence; next }
      !fence && index($0, pat) == 1 { print NR; exit }
    ' "$2"
  }
  begin_ln=$(find_marker "$MARKER_RE" "$f")
  end_ln=$(find_marker "$END_RE" "$f")

  if [ -n "$begin_ln" ] && [ -n "$end_ln" ] && [ "$end_ln" -lt "$begin_ln" ]; then
    echo "clean-comments: $rel has its markers reversed (END before BEGIN); fix it by hand." >&2
    continue
  fi
  if [ -n "$begin_ln" ] && [ -n "$end_ln" ] && [ "$end_ln" -gt "$begin_ln" ]; then
    action="update"
    tmp=$(mktemp)
    head -n "$((begin_ln - 1))" "$f" > "$tmp"
    printf '%s\n' "$block" >> "$tmp"
    tail -n +"$((end_ln + 1))" "$f" >> "$tmp"
  elif [ -n "$begin_ln" ] || [ -n "$end_ln" ]; then
    echo "clean-comments: $rel has one marker but not the other; fix it by hand." >&2
    continue
  else
    action="append"
    tmp=$(mktemp)
    cat "$f" > "$tmp"
    [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && printf '\n' >> "$tmp"
    printf '\n%s\n' "$block" >> "$tmp"
  fi

  if cmp -s "$f" "$tmp"; then
    echo "clean-comments: $rel already current."
    rm -f "$tmp"
    continue
  fi

  if [ "$write" -eq 1 ]; then
    cat "$tmp" > "$f"
    rm -f "$tmp"
    [ "$action" = append ] && done_verb=appended || done_verb=updated
    echo "clean-comments: $done_verb $rel."
  else
    echo "clean-comments: would $action $rel:"
    diff -u "$f" "$tmp" | sed 's/^/    /' || true
    rm -f "$tmp"
  fi
done

[ "$write" -eq 1 ] || echo $'\nNothing written. Rerun with --write to apply.'
