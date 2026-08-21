#!/usr/bin/env bash
# Resolves a cleanup scope to source files, one path per line.
#
# Usage:
#   scope.sh                 changed files (staged, unstaged, untracked)
#   scope.sh --branch        files this branch changed vs. its base
#   scope.sh --all           every source file in the repository
#   scope.sh <path>...       the given files or directories
#
# Requires: git. Prints nothing and exits 0 when the scope is empty.

set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

mode=changed
paths=()

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) mode=branch ;;
    --all) mode=all ;;
    --base) [ $# -ge 2 ] || cc_die "--base needs a ref"; shift; CC_BASE_REF="$1" ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) cc_die "unknown option: $1" ;;
    *) mode=paths; paths+=("$1") ;;
  esac
  shift
done

cc_require_repo

# quotepath=off keeps non-ASCII names literal; octal-escaped quoting would
# make every downstream file test fail and silently drop the file.
GIT="git -c core.quotepath=off"

case "$mode" in
  changed)
    { $GIT diff --name-only --diff-filter=d HEAD 2>/dev/null || true
      $GIT ls-files --others --exclude-standard; } ;;
  branch)
    base=$(cc_base_ref "${CC_BASE_REF:-}")
    [ -z "$base" ] && cc_die "cannot resolve a base ref; pass --base <ref>"
    $GIT diff --name-only --diff-filter=d "$base"...HEAD
    $GIT diff --name-only --diff-filter=d HEAD
    $GIT ls-files --others --exclude-standard ;;
  all)
    $GIT ls-files --cached --others --exclude-standard ;;
  paths)
    for p in "${paths[@]}"; do
      [ -e "$p" ] || cc_die "no such path: $p"
      if [ -d "$p" ]; then
        $GIT ls-files --cached --others --exclude-standard "$p"
      else
        printf '%s\n' "$p"
      fi
    done ;;
esac | sort -u | cc_filter_paths
