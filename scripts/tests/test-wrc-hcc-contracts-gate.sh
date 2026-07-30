#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-hcc-contracts.sh"
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

if bash -n "$GATE"; then
  pass "WRC-HCC contracts gate has valid bash syntax"
else
  fail "WRC-HCC contracts gate has invalid bash syntax"
fi

# The Phase 2 fixture has steps, so the admission policy requires an explicit
# trigger. Keep this immediately alongside the fixture's agent/steps contract
# so the E2E cannot regress into an admission-only false negative.
phase_two_fixture="$(sed -n '/^header "Phase 2 - WRC toolsCalled args status contract"$/,/^YAML$/p' "$GATE")"
if [[ "$phase_two_fixture" == *$'  triggers:\n    onDemand: {}'* ]] &&
   [[ "$phase_two_fixture" == *$'  steps:'* ]]; then
  pass "WRC-HCC Phase 2 fixture declares its required on-demand trigger"
else
  fail "WRC-HCC Phase 2 fixture can be rejected before its status contract runs"
fi

exit "$FAIL"
