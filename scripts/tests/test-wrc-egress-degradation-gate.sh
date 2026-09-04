#!/usr/bin/env bash
# Literal source-contract patterns intentionally contain shell-looking text.
# shellcheck disable=SC2016
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-egress-degradation.sh"
FIXTURE="${ROOT}/tests/e2e/fixtures/wrc-egress-dns-proxy/server.cjs"
MAKEFILE="${ROOT}/Makefile"

fail() { echo "FAIL: $*" >&2; exit 1; }
contains() {
  local file=$1 pattern=$2 description=$3
  grep -Fq -- "$pattern" "$file" || fail "$description"
}

bash -n "$GATE"
node --check "$FIXTURE" >/dev/null

contains "$GATE" 'is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"' \
  'gate must refuse non-branch Kubernetes contexts'
contains "$GATE" 'E2E_WRC_EGRESS_FAULT_INJECTION' \
  'gate must require explicit fault-injection acknowledgement'
contains "$GATE" 'require_branch_owned_hcc_gate "$WRC_NS"' \
  'gate must verify exact HEAD, worktree, profile, fingerprint, and pre-gate marker'
contains "$GATE" 'acquire_lock' 'gate must acquire exclusive WRC fault-injection ownership'
contains "$GATE" 'wrc_restore_verified' 'gate must prove WRC DNS configuration restoration'
contains "$GATE" 'lock retained' 'failed restoration must retain the coordination lock'

contains "$GATE" 'id: frontend' 'fixture must exercise the sandbox UI workload'
contains "$GATE" 'id: worker' 'fixture must exercise a non-UI workload'
contains "$GATE" 'port: 8443' 'fixture must begin with a permission that will be removed'
contains "$GATE" 'set_dns_mode hold' 'gate must create a real DNS latency window'
contains "$GATE" 'pre-DNS UI contraction' 'gate must assert UI contraction before DNS completes'
contains "$GATE" 'pre-DNS workload contraction' \
  'gate must assert workload contraction before DNS completes'
contains "$GATE" 'append_policy_port "$UI_NS" "$UI_POLICY" 9443' \
  'gate must inject live UI drift during DNS latency'
contains "$GATE" 'append_policy_port "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" 9443' \
  'gate must inject live workload drift during DNS latency'
contains "$GATE" 'set_dns_mode servfail' 'gate must produce a real retryable resolver response'
contains "$GATE" 'post-DNS UI re-contraction' \
  'gate must assert the UI fresh-read contraction after DNS failure'
contains "$GATE" 'post-DNS workload re-contraction' \
  'gate must assert the workload fresh-read contraction after DNS failure'

contains "$GATE" 'workload_health "$UI_NS" frontend' \
  'gate must prove the UI workload still serves its health endpoint'
contains "$GATE" 'workload_health "$RECIPE_NAMESPACE" worker' \
  'gate must prove the workload still serves its health endpoint'
contains "$GATE" 'deployment_ready "$WRC_NS" control-api' \
  'gate must assert an unrelated production service remains Ready'
contains "$GATE" 'deployment_ready "$WRC_NS" host-context-controller' \
  'gate must assert HCC remains Ready'
contains "$GATE" 'set_dns_mode ok' 'gate must restore successful DNS'
contains "$GATE" 'WRC_EGRESS_DEGRADATION_E2E_PASS' \
  'gate must emit an unambiguous terminal success marker'

contains "$FIXTURE" 'match(/^\/mode\/(ok|hold|servfail)$/)' \
  'DNS fixture must expose exactly the required deterministic modes'
contains "$FIXTURE" '0x8180 | rcode' 'DNS fixture must emit an actual SERVFAIL response'
contains "$FIXTURE" 'forwardUdp' 'DNS fixture must forward unrelated UDP queries'
contains "$FIXTURE" 'forwardTcp' 'DNS fixture must forward unrelated TCP queries'

contains "$MAKEFILE" '.PHONY: test-e2e-wrc-egress-degradation' \
  'Makefile must expose the WRC egress degradation gate'
contains "$MAKEFILE" 'MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-wrc-egress-degradation.sh' \
  'Make target must bind the mutation to the explicit profile/context'
contains "$MAKEFILE" '.PHONY: test-e2e-pr567-egress-resilience' \
  'Makefile must expose the complete PR #567 resilience gate'
contains "$MAKEFILE" '$(MAKE) test-e2e-hcc-mcp-context-readiness' \
  'complete PR gate must run the existing real HCC DNS/runtime journey'
contains "$MAKEFILE" '$(MAKE) test-e2e-wrc-egress-degradation' \
  'complete PR gate must run the WRC UI/workload degradation journey'

if grep -Eq 'kubectl[[:space:]]+(get|apply|patch|delete|exec|logs)' "$GATE"; then
  fail 'raw kubectl operations must use kctl or an explicit --context cleanup probe'
fi
if grep -Fq -- '--force' "$GATE"; then
  fail 'gate must not force Kubernetes mutations'
fi

echo 'PASS: WRC egress degradation E2E guard contract'
