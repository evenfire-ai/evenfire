#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh"
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

if bash -n "$GATE"; then
  pass "WRC internal-dependency gate has valid bash syntax"
else
  fail "WRC internal-dependency gate has invalid bash syntax"
fi

# WRC persists its generated workload resource names in status before
# materializing workloads. The gate must use that public CRD contract rather
# than assuming a workload ID is also a Deployment or Service name.
# shellcheck disable=SC2016
if grep -Fq 'wait_for_workload_instance() {' "$GATE" &&
   grep -Fq 'SOURCE_DEPLOYMENT="$(wait_for_workload_instance "$SOURCE_ID"' "$GATE" &&
   grep -Fq 'BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$BACKEND_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$SOURCE_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$BACKEND_ID"' "$GATE" &&
   grep -Fq 'deploy/${SOURCE_DEPLOYMENT}' "$GATE" &&
   grep -Fq '${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local' "$GATE"; then
  pass "WRC gate resolves persisted workload instances before runtime assertions"
else
  fail "WRC gate assumes raw workload IDs are runtime resource names"
fi

exit "$FAIL"
