#!/usr/bin/env bash
# Relay v2 release acceptance suite (attn-nnj.5.15).
#
# Runs ONLY the spec-aligned acceptance checklist in
# `relay/test/integration/acceptance.test.ts` and reports a PASS/FAIL count.
# This is the release-blocking gate per planning/collab/relay-spec.md §Test Plan
# (14 scenarios, ~26 named tests including sub-cases).
#
# Why not just `npm test`?
# - The unit + integration + conformance suites are large and slow (~40s).
# - This suite is the canonical release sign-off: short, explicit, scenario-
#   labeled. Each test heading matches a spec line item so a release engineer
#   can read the output as a checklist.
#
# Exits 0 if every acceptance case passes, 1 otherwise.
#
# Usage:
#   scripts/test-relay-acceptance.sh
#   scripts/test-relay-acceptance.sh --reporter=verbose

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY_DIR="$REPO_ROOT/relay"

if [[ ! -d "$RELAY_DIR" ]]; then
  echo "error: $RELAY_DIR not found" >&2
  exit 2
fi

cd "$RELAY_DIR"

if [[ ! -d "node_modules" ]]; then
  echo "==> installing relay dependencies (no node_modules)…"
  npm install --prefer-offline --no-audit --silent
fi

REPORTER="${1:---reporter=basic}"

echo "==> running relay v2 release acceptance suite"
echo "    spec: planning/collab/relay-spec.md §Test Plan (14 scenarios)"
echo "    file: relay/test/integration/acceptance.test.ts"
echo

# Capture full vitest output so we can re-emit it AND derive the PASS/FAIL line.
LOG="$(mktemp -t attn-relay-acceptance-XXXXXX)"
trap 'rm -f "$LOG"' EXIT

if npx vitest run test/integration/acceptance.test.ts "$REPORTER" 2>&1 | tee "$LOG"; then
  VITEST_STATUS=0
else
  VITEST_STATUS=${PIPESTATUS[0]}
fi

# Vitest's summary line looks like "Tests  26 passed (26)" — extract counts.
# Strip ANSI colour codes before parsing.
SUMMARY="$(sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' "$LOG" | grep -E '^\s*Tests\s' | tail -1 || true)"
PASSED="$(echo "$SUMMARY"  | grep -oE '[0-9]+ passed'  | head -1 | awk '{print $1}' || true)"
FAILED="$(echo "$SUMMARY"  | grep -oE '[0-9]+ failed'  | head -1 | awk '{print $1}' || true)"
SKIPPED="$(echo "$SUMMARY" | grep -oE '[0-9]+ skipped' | head -1 | awk '{print $1}' || true)"

PASSED="${PASSED:-0}"
FAILED="${FAILED:-0}"
SKIPPED="${SKIPPED:-0}"

echo
echo "==> relay acceptance summary"
echo "    passed:  $PASSED"
echo "    failed:  $FAILED"
echo "    skipped: $SKIPPED"

if [[ "$VITEST_STATUS" -ne 0 || "$FAILED" != "0" ]]; then
  echo
  echo "FAIL — relay acceptance suite has failures. See vitest output above." >&2
  exit 1
fi

if [[ "$PASSED" -lt 20 ]]; then
  echo
  echo "FAIL — relay acceptance suite is below the 20-test minimum (got $PASSED)." >&2
  echo "       spec §Test Plan calls for 14 scenarios + sub-cases (~25 tests)." >&2
  exit 1
fi

echo
echo "PASS — all $PASSED acceptance tests green."
exit 0
