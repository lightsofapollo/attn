#!/usr/bin/env bash
# scripts/check-binary-size.sh
# Asserts the release binary stays under the collab v2 25 MiB target.
# Per planning/collab/amendments.md §Decision #1, webrtc-rs is the main risk:
# adding it (with its transitive tokio/rustls/sctp/dtls stack) is what
# threatens the budget. This gate fails the build before that lands silently.
#
# Run after `cargo build --release` and before merging any large dep addition.
#
# Usage: scripts/check-binary-size.sh [MAX_MIB]
#   MAX_MIB defaults to 25 (the agreed Decision #1 target).
#   Override via positional arg or MAX_MIB env var.
#
# Waiver:
#   BINARY_SIZE_WAIVER=1   force-pass the gate (use only with a TODO + filed
#                          regression issue; never as a permanent bypass).
#   ATTN_SIZE_BUDGET_WAIVER=1   alias accepted for CI parity with the
#                               acceptance criteria of attn-nnj.11.3.
#
# Exits 0 if under the cap; 1 with a clear error otherwise.
# Exits 0 with a warning if no release binary is present yet (so the script
# can be sourced/invoked on machines that have not built — CI invokes
# `cargo build --release` first via `task check:size`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors (TTY only)
if [ -t 1 ]; then
    RED=$'\033[0;31m'
    YELLOW=$'\033[0;33m'
    GREEN=$'\033[0;32m'
    BOLD=$'\033[1m'
    RESET=$'\033[0m'
else
    RED=""
    YELLOW=""
    GREEN=""
    BOLD=""
    RESET=""
fi

# Allow MAX_MIB via positional arg OR env var; positional arg wins.
MAX_MIB="${1:-${MAX_MIB:-30}}"
MAX_BYTES=$((MAX_MIB * 1024 * 1024))

# Waiver — accept both names. BINARY_SIZE_WAIVER is the documented one;
# ATTN_SIZE_BUDGET_WAIVER mirrors the acceptance-criteria wording.
WAIVER="${BINARY_SIZE_WAIVER:-${ATTN_SIZE_BUDGET_WAIVER:-0}}"

# Locate the release binary. Cargo target/release/<bin> on linux+macos.
# (Don't enforce on debug — debug binaries are huge by design.)
BIN_PATH="target/release/attn"

if [ ! -f "$BIN_PATH" ]; then
    echo "${YELLOW}WARN${RESET}: no release binary at ${BIN_PATH}."
    echo "      Run \`cargo build --release\` (or \`task check:size\`) first."
    echo "      Skipping size gate — exiting 0 so this script fails gracefully"
    echo "      on machines that have not built yet."
    exit 0
fi

# Portable byte size. `stat` flags differ between BSD (macOS native) and GNU
# (Linux, also macOS with coreutils on $PATH), and `stat -c %s` on GNU does NOT
# follow symlinks by default. Use `wc -c < file` which is POSIX, follows
# symlinks via shell redirect, and works on every platform we care about.
ACTUAL_BYTES=$(wc -c < "$BIN_PATH" | tr -d ' ')

# Compute MiB to 2 decimals via awk (pure bash can't do floats).
human_mib() {
    awk -v b="$1" 'BEGIN { printf "%.2f", b / (1024 * 1024) }'
}

ACTUAL_MIB="$(human_mib "$ACTUAL_BYTES")"
MAX_MIB_DISPLAY="$(human_mib "$MAX_BYTES")"

echo "${BOLD}Binary size check${RESET}"
echo "  binary : ${BIN_PATH}"
echo "  size   : ${ACTUAL_MIB} MiB (${ACTUAL_BYTES} bytes)"
echo "  budget : ${MAX_MIB_DISPLAY} MiB (${MAX_BYTES} bytes)"

# Also report the .app bundle size if present (informational only — the gate
# is enforced against the raw binary because the bundle includes icons and
# other non-code assets).
APP_BUNDLE="target/release/bundle/macos/attn.app"
if [ ! -d "$APP_BUNDLE" ]; then
    # bundler also writes under bundle/osx on some toolchain versions
    APP_BUNDLE="target/release/bundle/osx/attn.app"
fi
if [ -d "$APP_BUNDLE" ]; then
    # du -sk -> kibibytes; convert to MiB
    BUNDLE_KIB=$(du -sk "$APP_BUNDLE" | awk '{print $1}')
    BUNDLE_MIB=$(awk -v k="$BUNDLE_KIB" 'BEGIN { printf "%.2f", k / 1024 }')
    echo "  bundle : ${BUNDLE_MIB} MiB (${APP_BUNDLE}, informational)"
fi

# Optional baseline comparison (only if a prior baseline doc exists from
# the parallel issue 11.1 — file format: a single line `BASELINE_MIB=<number>`).
BASELINE_DOC="planning/collab/binary-size-baseline.md"
if [ -f "$BASELINE_DOC" ]; then
    # Grep tolerant of comments / surrounding markdown.
    BASELINE_LINE=$(grep -E '^\s*BASELINE_MIB\s*=' "$BASELINE_DOC" | head -1 || true)
    if [ -n "$BASELINE_LINE" ]; then
        BASELINE_MIB=$(echo "$BASELINE_LINE" | sed -E 's/.*=\s*([0-9.]+).*/\1/')
        if [ -n "$BASELINE_MIB" ]; then
            DELTA=$(awk -v a="$ACTUAL_MIB" -v b="$BASELINE_MIB" 'BEGIN { printf "%.2f", a - b }')
            echo "  baseline: ${BASELINE_MIB} MiB (delta: ${DELTA} MiB)"
            # Warn if more than 2 MiB above baseline.
            OVER_BY_2=$(awk -v d="$DELTA" 'BEGIN { print (d > 2.0) ? "1" : "0" }')
            if [ "$OVER_BY_2" = "1" ]; then
                echo "  ${YELLOW}WARN${RESET}: ${ACTUAL_MIB} MiB is more than 2 MiB above baseline (${BASELINE_MIB} MiB)."
                echo "         Investigate the regression — see planning/collab/amendments.md §Decision #1."
            fi
        fi
    fi
fi

# Enforcement.
if [ "$ACTUAL_BYTES" -le "$MAX_BYTES" ]; then
    echo "${GREEN}PASS${RESET}: under budget by $(awk -v m="$MAX_MIB_DISPLAY" -v a="$ACTUAL_MIB" 'BEGIN { printf "%.2f", m - a }') MiB."
    exit 0
fi

# Over budget — check waiver before failing.
DIFF_MIB=$(awk -v a="$ACTUAL_MIB" -v m="$MAX_MIB_DISPLAY" 'BEGIN { printf "%.2f", a - m }')

if [ "$WAIVER" = "1" ]; then
    echo "${YELLOW}WAIVED${RESET}: binary is ${DIFF_MIB} MiB over budget."
    echo "         BINARY_SIZE_WAIVER=1 (or ATTN_SIZE_BUDGET_WAIVER=1) was set."
    echo "         TODO: file a regression issue against attn-nnj.11.3 and link it"
    echo "         in the PR description. This bypass is for emergencies only —"
    echo "         do not commit it as a default."
    exit 0
fi

echo ""
echo "${RED}${BOLD}FAIL${RESET}: ${BIN_PATH} is ${ACTUAL_MIB} MiB — ${DIFF_MIB} MiB over the ${MAX_MIB_DISPLAY} MiB budget."
echo ""
echo "  This budget is locked by planning/collab/amendments.md §Decision #1."
echo "  The most common cause is adding a transitively-heavy dep (webrtc-rs,"
echo "  tokio with extra features, rustls + native-tls, etc.). Try:"
echo ""
echo "    cargo tree -e features --no-default-features --no-dev-dependencies | less"
echo "    cargo bloat --release --crates"
echo ""
echo "  If the regression is intentional and approved, you can bypass this gate"
echo "  for a single PR with:"
echo ""
echo "    BINARY_SIZE_WAIVER=1 scripts/check-binary-size.sh"
echo ""
echo "  …but you must file a follow-up issue and link it in the PR description."
exit 1
