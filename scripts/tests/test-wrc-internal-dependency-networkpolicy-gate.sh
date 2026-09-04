#!/usr/bin/env bash
# shellcheck disable=SC2016
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh"
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

function_body() {
  local name=$1
  awk -v signature="${name}() {" '
    inside && $0 ~ /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{$/ { exit }
    inside && $0 ~ /^header "/ { exit }
    $0 == signature { inside=1 }
    inside { print }
  ' "$GATE"
}

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
   grep -Fq 'KEEP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$KEEP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'DROP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$DROP_BACKEND_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$SOURCE_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$KEEP_BACKEND_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$DROP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'deploy/${SOURCE_DEPLOYMENT}' "$GATE" &&
   grep -Fq '${KEEP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local' "$GATE" &&
   grep -Fq '${DROP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local' "$GATE"; then
  pass "WRC gate resolves persisted workload instances before runtime assertions"
else
  fail "WRC gate assumes raw workload IDs are runtime resource names"
fi

# The live journey must begin with two routes, remove only DROP by re-applying
# the WorkflowRecipe, and prove KEEP still works after DROP is denied.
if grep -Fq 'apply_recipe "with-drop"' "$GATE" &&
   grep -Fq 'apply_recipe "without-drop"' "$GATE" &&
   grep -Fq 'name: KEEP_URL' "$GATE" &&
   grep -Fq 'name: DROP_URL' "$GATE" &&
   grep -Fq 'assert_http_allowed "$SOURCE_DEPLOYMENT" "$keep_target" "keep-route-ok"' "$GATE" &&
   grep -Fq 'assert_http_allowed "$SOURCE_DEPLOYMENT" "$drop_target" "drop-route-ok"' "$GATE" &&
   grep -Fq 'wait_http_denied "$SOURCE_DEPLOYMENT" "$drop_target"' "$GATE" &&
   grep -Fq 'assert_policy_excludes_peer "$updated_egress_ref" "$DROP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'wait_for_policy_absent "$drop_ingress_ref"' "$GATE"; then
  pass "WRC gate proves selective KEEP/DROP dependency convergence"
else
  fail "WRC gate does not prove the legitimate two-route update journey"
fi

# The recipe must survive the update and carry the durable clean reap signal.
if grep -Fq 'wait_for_recipe_generation_after' "$GATE" &&
   grep -Fq 'wait_for_deployment_generation_after' "$GATE" &&
   grep -Fq 'guard_recipe_nonterminal() {' "$GATE" &&
   grep -Fq 'failed|deprecated|rollback-failed)' "$GATE" &&
   grep -Fq 'NetworkPolicyReapFailed' "$GATE" &&
   grep -Fq 'False\|Reaped\|*' "$GATE" &&
   grep -Fq 'assert_reap_reaped' "$GATE"; then
  pass "WRC gate pins generation, non-terminal phase, and durable Reaped condition"
else
  fail "WRC gate can pass without proving generation/phase/Reaped state"
fi

normal_finalizer="$(function_body delete_recipe_and_verify_finalizer_order)"
emergency="$(function_body emergency_cleanup)"

# A retained child policy makes cleanup order observable: the recipe must stay
# Terminating until the held policy is released and disappears.
if grep -Fq 'FINALIZER_HOLD="e2e.clerum.io/hold-networkpolicy-delete"' "$GATE" &&
   printf '%s\n' "$normal_finalizer" | grep -Fq '${FINALIZER_HOLD}' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'go-template={{.metadata.deletionTimestamp}}' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'clerum.io/workload-cleanup' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'wait_for_policy_absent "$hold_ref"' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'wait_for_workflowrecipe_deleted' &&
   ! printf '%s\n' "$normal_finalizer" | grep -Fq 'delete networkpolicy'; then
  pass "WRC gate proves NetworkPolicy-before-WorkflowRecipe finalizer order"
else
  fail "WRC gate finalizer path can be satisfied by direct child cleanup"
fi

# Direct policy cleanup is recovery-only. The successful Phase 7 must use the
# finalizer-order helper, while --cleanup-only and the failure trap may use the
# scoped emergency function.
if printf '%s\n' "$emergency" | grep -Fq 'kctl delete networkpolicy' &&
   grep -Fq 'if [ "${1:-}" = "--cleanup-only" ]; then' "$GATE" &&
   grep -Fq 'delete_recipe_and_verify_finalizer_order "$updated_keep_ingress_ref"' "$GATE" &&
   [ "$(grep -Fc 'kctl delete networkpolicy' "$GATE")" = "1" ]; then
  pass "WRC gate isolates direct NetworkPolicy deletion to emergency cleanup"
else
  fail "WRC gate mixes direct NetworkPolicy cleanup into the success journey"
fi

# Every real kubectl invocation must go through e2e-lib's context-bound kctl.
if grep -Eq '(^|[[:space:]])kubectl([[:space:]]|$)' "$GATE"; then
  fail "WRC gate contains a kubectl invocation outside kctl"
else
  pass "WRC gate routes every Kubernetes call through kctl"
fi

exit "$FAIL"
