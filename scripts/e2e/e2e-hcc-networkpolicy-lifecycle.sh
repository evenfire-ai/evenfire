#!/usr/bin/env bash
set -euo pipefail
# #604 runtime proof. The underlying gate enforces branch/profile provenance,
# holds its fault-injection lock and restores HCC before returning a verdict.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${MINIKUBE_PROFILE:?explicit branch-owned profile required}"
: "${CONTROL_API_REAL_PG_CONTEXT:?explicit branch-owned context required}"
[[ "$MINIKUBE_PROFILE" = "$CONTROL_API_REAL_PG_CONTEXT" ]] || {
  echo 'FAIL: profile and context must match' >&2
  exit 2
}
export KUBECONTEXT="$CONTROL_API_REAL_PG_CONTEXT"
export E2E_HCC_WATCH_FAULT_INJECTION=1
export E2E_HCC_POLICY_LIFECYCLE=1
export E2E_EXPECTED_PRE_GATE_GATE=minikube-t2
# The two real MCP workloads in the lifecycle fixture provide the business
# witness. Other synthetic McpServers would add unrelated crashing workloads.
export FLEET_CONTEXTS=1 FLEET_MCPSERVERS=0 FLEET_HOSTS=1
export CHURN_MIN_CUTS=3 CHURN_OBSERVE_SEC=45
exec bash "$SCRIPT_DIR/e2e-hcc-watch-churn-readiness.sh"
