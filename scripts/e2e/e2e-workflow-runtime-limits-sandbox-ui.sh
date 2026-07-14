#!/usr/bin/env bash
# E2E: WRC runtime limits with sandbox-ui.
#
# Temporarily lowers the shared WorkflowRecipe runtime limits below the CRD
# ceiling, restarts control-api and workflow-recipes, then proves one exact-limit
# sandbox-ui recipe is deployed and two CRD-valid-but-runtime-invalid recipes
# are rejected before workload resources are created.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

SANDBOX_UI_NS="${SANDBOX_UI_NS:-sandbox-ui}"
LIMIT_CONFIGMAP="${LIMIT_CONFIGMAP:-control-api-config}"
WORKLOAD_LIMIT_KEY="CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE"
UI_INTERNAL_LIMIT_KEY="CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS"
WORKLOAD_LIMIT="${E2E_WORKFLOW_MAX_WORKLOADS_PER_RECIPE:-3}"
UI_INTERNAL_LIMIT="${E2E_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS:-1}"
TIMEOUT_RECIPE_PHASE="${TIMEOUT_RECIPE_PHASE:-180}"
LIMIT_CONSUMERS=("control-api" "workflow-recipes")
WORKLOAD_LIMIT_OVER=""
UI_INTERNAL_LIMIT_OVER=""

OK_RECIPE="limits-runtime-ok"
WORKLOAD_FAIL_RECIPE="limits-too-many-workloads"
UI_EGRESS_FAIL_RECIPE="limits-too-many-ui-egress"
ORIGINAL_WORKLOAD_LIMIT=""
ORIGINAL_UI_INTERNAL_LIMIT=""
RESTORE_LIMITS=0

wait_for_recipe_phase() {
  local name=$1 want=$2 elapsed=0 phase
  while [ "$elapsed" -lt "$TIMEOUT_RECIPE_PHASE" ]; do
    phase=$(kctl get workflowrecipe "$name" -n "$WORKFLOW_RECIPE_NS" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [ "$phase" = "$want" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

recipe_message() {
  kctl get workflowrecipe "$1" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.status.message}' 2>/dev/null || true
}

patch_limits() {
  kctl patch configmap "$LIMIT_CONFIGMAP" -n "$CONTROL_NS" --type merge \
    -p "{\"data\":{\"${WORKLOAD_LIMIT_KEY}\":\"$1\",\"${UI_INTERNAL_LIMIT_KEY}\":\"$2\"}}" \
    >/dev/null
}

roll_limit_consumers() {
  local label=$1 deploy
  header "${label} limit consumers"
  for deploy in "${LIMIT_CONSUMERS[@]}"; do
    kctl rollout restart "deployment/${deploy}" -n "$CONTROL_NS" >/dev/null
    ok "Restart requested for ${CONTROL_NS}/${deploy}"
  done
  for deploy in "${LIMIT_CONSUMERS[@]}"; do
    if kctl rollout status "deployment/${deploy}" -n "$CONTROL_NS" --timeout=180s >/dev/null; then
      ok "Deployment ${CONTROL_NS}/${deploy} rolled out"
    else
      fail "Deployment ${CONTROL_NS}/${deploy} rollout timed out"
      return 1
    fi
  done
}

cleanup_recipes() {
  kctl delete workflowrecipe "$OK_RECIPE" "$WORKLOAD_FAIL_RECIPE" "$UI_EGRESS_FAIL_RECIPE" \
    -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kctl delete deployment limits-ui over-ui egress-ui -n "$SANDBOX_UI_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  kctl delete svc limits-ui over-ui egress-ui -n "$SANDBOX_UI_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  kctl delete networkpolicy "ui-egress-${OK_RECIPE}" "ui-egress-${WORKLOAD_FAIL_RECIPE}" \
    "ui-egress-${UI_EGRESS_FAIL_RECIPE}" -n "$SANDBOX_UI_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  local cleanup_workload_count="${WORKLOAD_LIMIT_OVER:-26}"
  local names=(limits-api over-api over-worker over-extra egress-api egress-cache) i
  for i in $(seq 1 "$cleanup_workload_count"); do
    names+=("limits-api-${i}" "over-api-${i}" "egress-api-${i}")
  done
  kctl delete deployment "${names[@]}" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  kctl delete svc "${names[@]}" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
}

restore_limits() {
  [ "$RESTORE_LIMITS" -eq 1 ] || return 0
  header "Restore original runtime limits"
  patch_limits "$ORIGINAL_WORKLOAD_LIMIT" "$ORIGINAL_UI_INTERNAL_LIMIT" || {
    fail "Could not restore ${CONTROL_NS}/${LIMIT_CONFIGMAP}"
    return 1
  }
  roll_limit_consumers "Restore"
}

on_exit() {
  local status=$? cleanup_status=0 restore_status=0
  set +e
  cleanup_recipes || cleanup_status=$?
  restore_limits || restore_status=$?
  if [ "$status" -eq 0 ] && { [ "$cleanup_status" -ne 0 ] || [ "$restore_status" -ne 0 ]; }; then
    exit 1
  fi
  exit "$status"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

validate_test_limit_inputs() {
  if ! is_positive_integer "$WORKLOAD_LIMIT"; then
    echo "E2E_WORKFLOW_MAX_WORKLOADS_PER_RECIPE must be a positive integer" >&2
    exit 1
  fi
  if ! is_positive_integer "$UI_INTERNAL_LIMIT"; then
    echo "E2E_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS must be a positive integer" >&2
    exit 1
  fi
  if [ "$WORKLOAD_LIMIT" -lt 2 ]; then
    echo "E2E_WORKFLOW_MAX_WORKLOADS_PER_RECIPE must be at least 2 for this sandbox-ui fixture" >&2
    exit 1
  fi
  if [ "$UI_INTERNAL_LIMIT" -lt 1 ]; then
    echo "E2E_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS must be at least 1 for this sandbox-ui fixture" >&2
    exit 1
  fi
  if [ "$WORKLOAD_LIMIT" -lt $((UI_INTERNAL_LIMIT + 1)) ]; then
    echo "workload limit must be at least ui.egress.internal limit + 1 for this fixture" >&2
    exit 1
  fi
  WORKLOAD_LIMIT_OVER=$((WORKLOAD_LIMIT + 1))
  UI_INTERNAL_LIMIT_OVER=$((UI_INTERNAL_LIMIT + 1))
}

derive_cleanup_limit_inputs() {
  if is_positive_integer "$WORKLOAD_LIMIT"; then
    WORKLOAD_LIMIT_OVER=$((WORKLOAD_LIMIT + 1))
  fi
  if is_positive_integer "$UI_INTERNAL_LIMIT"; then
    UI_INTERNAL_LIMIT_OVER=$((UI_INTERNAL_LIMIT + 1))
  fi
}

print_workload() {
  local id=$1
  printf '  - id: %s\n    type: deployment\n    image: nginxinc/nginx-unprivileged:1.27-alpine\n    port: 8080\n' "$id"
}

print_internal_ref() {
  local workload_ref=$1
  printf '      - workloadRef: %s\n        port: 8080\n' "$workload_ref"
}

apply_ok_recipe() {
  kctl apply -f - <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${OK_RECIPE}
  namespace: ${WORKFLOW_RECIPE_NS}
spec:
  description: Runtime-limit positive fixture for sandbox-ui.
  contextRef: ${CONTEXT_NAME}
  workloads:
$(print_workload limits-ui)
$(for i in $(seq 1 $((WORKLOAD_LIMIT - 1))); do print_workload "limits-api-${i}"; done)
  ui:
    workloadRef: limits-ui
    port: 8080
    title: Runtime Limits UI
    defaultPath: /
    egress:
      internal:
$(for i in $(seq 1 "$UI_INTERNAL_LIMIT"); do print_internal_ref "limits-api-${i}"; done)
  security:
    isolationLevel: minimal
EOF
}

apply_workload_fail_recipe() {
  kctl apply -f - <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WORKLOAD_FAIL_RECIPE}
  namespace: ${WORKFLOW_RECIPE_NS}
spec:
  description: Runtime-limit negative fixture for workload count.
  contextRef: ${CONTEXT_NAME}
  workloads:
$(print_workload over-ui)
$(for i in $(seq 1 $((WORKLOAD_LIMIT_OVER - 1))); do print_workload "over-api-${i}"; done)
  ui:
    workloadRef: over-ui
    port: 8080
    title: Over Workload Limit UI
    defaultPath: /
  security:
    isolationLevel: minimal
EOF
}

apply_ui_egress_fail_recipe() {
  kctl apply -f - <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${UI_EGRESS_FAIL_RECIPE}
  namespace: ${WORKFLOW_RECIPE_NS}
spec:
  description: Runtime-limit negative fixture for UI internal egress.
  contextRef: ${CONTEXT_NAME}
  workloads:
$(print_workload egress-ui)
$(for i in $(seq 1 "$UI_INTERNAL_LIMIT_OVER"); do print_workload "egress-api-${i}"; done)
  ui:
    workloadRef: egress-ui
    port: 8080
    title: Over UI Egress Limit
    defaultPath: /
    egress:
      internal:
$(for i in $(seq 1 "$UI_INTERNAL_LIMIT_OVER"); do print_internal_ref "egress-api-${i}"; done)
  security:
    isolationLevel: minimal
EOF
}

assert_failed_recipe() {
  local recipe=$1 expected=$2 message
  if wait_for_recipe_phase "$recipe" failed; then
    ok "WorkflowRecipe ${recipe} reached phase=failed"
  else
    fail "WorkflowRecipe ${recipe} did not reach phase=failed"
    kctl describe workflowrecipe "$recipe" -n "$WORKFLOW_RECIPE_NS" || true
    return
  fi
  message="$(recipe_message "$recipe")"
  if printf "%s" "$message" | grep -Fq "$expected"; then
    ok "WorkflowRecipe ${recipe} failure message includes '${expected}'"
  else
    fail "WorkflowRecipe ${recipe} failure message was '${message}', expected '${expected}'"
  fi
}

assert_no_deploy() {
  local ns=$1 name=$2
  if kctl get deployment "$name" -n "$ns" >/dev/null 2>&1; then
    fail "Deployment ${ns}/${name} exists after runtime-limit rejection"
  else
    ok "Deployment ${ns}/${name} was not created"
  fi
}

if [[ "${1:-}" == "--cleanup-only" ]]; then
  derive_cleanup_limit_inputs
  cleanup_recipes
  exit 0
fi

validate_test_limit_inputs

header "Phase 0 - Prerequisites"
require_safe_kube_context
check_prerequisites
for ns in "$SANDBOX_UI_NS"; do
  kctl get ns "$ns" >/dev/null && ok "Namespace '${ns}' exists" || fail "Namespace '${ns}' not found"
done
kctl get configmap "$LIMIT_CONFIGMAP" -n "$CONTROL_NS" >/dev/null &&
  ok "ConfigMap ${CONTROL_NS}/${LIMIT_CONFIGMAP} exists" ||
  fail "ConfigMap ${CONTROL_NS}/${LIMIT_CONFIGMAP} not found"
for deploy in "${LIMIT_CONSUMERS[@]}"; do
  kctl get deployment "$deploy" -n "$CONTROL_NS" >/dev/null &&
    ok "Deployment '${deploy}' in ${CONTROL_NS}" ||
    fail "Deployment '${deploy}' not found"
done
[ "$e2e_fail" -eq 0 ] || exit 1

ORIGINAL_WORKLOAD_LIMIT="$(kctl get configmap "$LIMIT_CONFIGMAP" -n "$CONTROL_NS" \
  -o "jsonpath={.data.${WORKLOAD_LIMIT_KEY}}" 2>/dev/null || true)"
ORIGINAL_UI_INTERNAL_LIMIT="$(kctl get configmap "$LIMIT_CONFIGMAP" -n "$CONTROL_NS" \
  -o "jsonpath={.data.${UI_INTERNAL_LIMIT_KEY}}" 2>/dev/null || true)"
if [ -z "$ORIGINAL_WORKLOAD_LIMIT" ] || [ -z "$ORIGINAL_UI_INTERNAL_LIMIT" ]; then
  fail "ConfigMap ${CONTROL_NS}/${LIMIT_CONFIGMAP} must define ${WORKLOAD_LIMIT_KEY} and ${UI_INTERNAL_LIMIT_KEY}"
  exit 1
fi
RESTORE_LIMITS=1
trap on_exit EXIT

header "Phase 1 - Clean slate"
cleanup_recipes
ok "Runtime-limit fixtures cleaned"

header "Phase 2 - Lower runtime limits below CRD ceiling"
patch_limits "$WORKLOAD_LIMIT" "$UI_INTERNAL_LIMIT"
ok "${WORKLOAD_LIMIT_KEY} set to ${WORKLOAD_LIMIT}"
ok "${UI_INTERNAL_LIMIT_KEY} set to ${UI_INTERNAL_LIMIT}"
roll_limit_consumers "Apply lowered"

header "Phase 3 - Positive sandbox-ui recipe inside lowered limits"
apply_ok_recipe
wait_for_recipe_phase "$OK_RECIPE" active &&
  ok "WorkflowRecipe ${OK_RECIPE} reached phase=active" ||
  fail "WorkflowRecipe ${OK_RECIPE} did not reach phase=active"
wait_for_deployment "$SANDBOX_UI_NS" limits-ui "$TIMEOUT_POD" &&
  ok "UI deployment ${SANDBOX_UI_NS}/limits-ui reached Ready" ||
  fail "UI deployment ${SANDBOX_UI_NS}/limits-ui did not reach Ready"
for i in $(seq 1 $((WORKLOAD_LIMIT - 1))); do
  wait_for_deployment "$WORKFLOW_RECIPE_NS" "limits-api-${i}" "$TIMEOUT_POD" &&
    ok "Backend deployment ${WORKFLOW_RECIPE_NS}/limits-api-${i} reached Ready" ||
    fail "Backend deployment ${WORKFLOW_RECIPE_NS}/limits-api-${i} did not reach Ready"
done
kctl get networkpolicy "ui-egress-${OK_RECIPE}" -n "$SANDBOX_UI_NS" >/dev/null &&
  ok "NetworkPolicy ${SANDBOX_UI_NS}/ui-egress-${OK_RECIPE} exists" ||
  fail "NetworkPolicy ${SANDBOX_UI_NS}/ui-egress-${OK_RECIPE} missing"

header "Phase 4 - Negative recipe above lowered workload limit"
apply_workload_fail_recipe
assert_failed_recipe "$WORKLOAD_FAIL_RECIPE" "spec.workloads must contain at most ${WORKLOAD_LIMIT} items"
assert_no_deploy "$SANDBOX_UI_NS" over-ui
for i in $(seq 1 $((WORKLOAD_LIMIT_OVER - 1))); do
  assert_no_deploy "$WORKFLOW_RECIPE_NS" "over-api-${i}"
done

header "Phase 5 - Negative recipe above lowered ui.egress.internal limit"
apply_ui_egress_fail_recipe
assert_failed_recipe "$UI_EGRESS_FAIL_RECIPE" "spec.ui.egress.internal must contain at most ${UI_INTERNAL_LIMIT} items"
assert_no_deploy "$SANDBOX_UI_NS" egress-ui
for i in $(seq 1 "$UI_INTERNAL_LIMIT_OVER"); do
  assert_no_deploy "$WORKFLOW_RECIPE_NS" "egress-api-${i}"
done

header "Summary"
echo "  Passed: ${e2e_pass}"
echo "  Failed: ${e2e_fail}"
echo "  Total: ${e2e_total}"
[ "$e2e_fail" -eq 0 ]
echo "E2E workflow-runtime-limits-sandbox-ui PASSED"
