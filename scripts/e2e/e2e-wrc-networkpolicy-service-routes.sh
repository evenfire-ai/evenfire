#!/usr/bin/env bash
# PR #580 E2E for correctly configured WRC NetworkPolicy service routes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"

raw_run_id="${E2E_RUN_ID:-$(date +%H%M%S)-$$}"
RUN_ID="$(printf '%s' "$raw_run_id" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' | cut -c1-16)"
[ -n "$RUN_ID" ] || RUN_ID="run-$$"

RECIPE_NAME="${E2E_RECIPE_NAME:-e2e-wrc-routes-${RUN_ID}}"
SANDBOX_UI_NS="${SANDBOX_UI_NS:-sandbox-ui}"
UI_ID="ui"
API_ID="api"
DB_ID="db"
DB_PORT=8081
CONNECT_TIMEOUT="${E2E_CONNECT_TIMEOUT:-6}"
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"
ROGUE_UI_POD="${RECIPE_NAME}-rogue-ui"
ROGUE_WORKLOAD_POD="${RECIPE_NAME}-rogue-wl"
CREATED=0
HELD_POLICY_FINALIZER=0

UI_DEPLOYMENT=""
API_DEPLOYMENT=""
DB_DEPLOYMENT=""

UI_INGRESS_POLICY="ui-ingress-${RECIPE_NAME}-${API_ID}"
WL_EGRESS_POLICY="wl-egress-${RECIPE_NAME}-${API_ID}"
WL_INGRESS_POLICY="wl-ingress-${RECIPE_NAME}-${DB_ID}"

cleanup() {
  local status=0 namespace
  kctl delete pod "$ROGUE_UI_POD" -n "$SANDBOX_UI_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  kctl delete pod "$ROGUE_WORKLOAD_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  if [ "$HELD_POLICY_FINALIZER" = "1" ] &&
     kctl get networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    kctl patch networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --type=merge \
      -p '{"metadata":{"finalizers":[]}}' >/dev/null 2>&1 || status=1
    HELD_POLICY_FINALIZER=0
  fi
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" >/dev/null 2>&1 || status=1
  for namespace in "$SANDBOX_NS" "$SANDBOX_UI_NS"; do
    kctl delete networkpolicy -n "$namespace" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found >/dev/null 2>&1 || status=1
  done
  return "$status"
}

on_exit() {
  local status=$?
  if [ "$CREATED" = "1" ] && [ "${E2E_KEEP_RESOURCES:-0}" != "1" ]; then
    cleanup >/dev/null 2>&1 || {
      [ "$status" -ne 0 ] && warn "WRC service-route E2E cleanup left resources behind"
      [ "$status" -eq 0 ] && fail "WRC service-route E2E cleanup left resources behind" && status=1
    }
  fi
  exit "$status"
}
trap on_exit EXIT

wait_for_workload_instance() {
  local workload_id=$1 timeout=${2:-$TIMEOUT_POD} elapsed=0 instance
  while [ "$elapsed" -lt "$timeout" ]; do
    instance="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o "jsonpath={.status.workloadInstances.${workload_id}}" 2>/dev/null || true)"
    if [ -n "$instance" ]; then
      printf '%s\n' "$instance"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_recipe_active() {
  local timeout=${1:-180} elapsed=0 phase
  while [ "$elapsed" -lt "$timeout" ]; do
    phase="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      active) return 0 ;;
      failed|rollback-failed|deprecated)
        fail "WorkflowRecipe entered terminal phase ${phase}"
        return 1
        ;;
    esac
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "WorkflowRecipe did not reach active"
  return 1
}

wait_for_recipe_message() {
  local expected=$1 timeout=${2:-120} elapsed=0 message
  while [ "$elapsed" -lt "$timeout" ]; do
    message="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
      -o jsonpath='{.status.message}' 2>/dev/null || true)"
    if [[ "$message" == *"$expected"* ]]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "WorkflowRecipe did not report retryable state containing: ${expected}"
  return 1
}

assert_http_body() {
  local description=$1 namespace=$2 deployment=$3 host=$4 port=$5 expected=$6 body
  # shellcheck disable=SC2016
  body="$(kctl exec "deploy/${deployment}" -n "$namespace" -- sh -c 'printf "GET / HTTP/1.0\r\nHost: e2e\r\nConnection: close\r\n\r\n" | nc -w "$1" "$2" "$3"' -- "$CONNECT_TIMEOUT" "$host" "$port" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -Fq "$expected"; then
    ok "$description"
    return 0
  fi
  fail "${description} (unexpected response)"
  return 1
}

assert_pod_blocked() {
  local description=$1 namespace=$2 pod=$3 host=$4 port=$5
  # shellcheck disable=SC2016
  if kctl exec "$pod" -n "$namespace" -- sh -c 'printf "GET / HTTP/1.0\r\n\r\n" | nc -w "$1" "$2" "$3"' -- "$CONNECT_TIMEOUT" "$host" "$port" >/dev/null 2>&1; then
    fail "${description}: unexpected connection succeeded"
    return 1
  fi
  ok "$description"
}

apply_rogue_pod() {
  local namespace=$1 name=$2
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    e2e.clerum.io/suite: wrc-networkpolicy-service-routes
    e2e.clerum.io/probe: ${name}
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: probe
      image: busybox:1.36.1
      command: ["sh", "-c", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
YAML
  wait_for_pod "$namespace" "e2e.clerum.io/probe=${name}" 60
}

assert_all_stable() {
  local ui_before wl_egress_before wl_ingress_before
  local ui_after wl_egress_after wl_ingress_after
  ui_before="$(wrc_np_resource_version "$SANDBOX_NS" "$UI_INGRESS_POLICY")"
  wl_egress_before="$(wrc_np_resource_version "$SANDBOX_NS" "$WL_EGRESS_POLICY")"
  wl_ingress_before="$(wrc_np_resource_version "$SANDBOX_NS" "$WL_INGRESS_POLICY")"

  # Intentional no-churn observation window after all readiness assertions.
  sleep "$STABILITY_SECONDS"

  ui_after="$(wrc_np_resource_version "$SANDBOX_NS" "$UI_INGRESS_POLICY")"
  wl_egress_after="$(wrc_np_resource_version "$SANDBOX_NS" "$WL_EGRESS_POLICY")"
  wl_ingress_after="$(wrc_np_resource_version "$SANDBOX_NS" "$WL_INGRESS_POLICY")"

  [ "$ui_after" = "$ui_before" ] || fail "${UI_INGRESS_POLICY} churned"
  [ "$wl_egress_after" = "$wl_egress_before" ] || fail "${WL_EGRESS_POLICY} churned"
  [ "$wl_ingress_after" = "$wl_ingress_before" ] || fail "${WL_INGRESS_POLICY} churned"
  ok "All three converged NetworkPolicies stayed resourceVersion-stable"
}

header "WRC NetworkPolicy correctly-configured service routes"
require_safe_kube_context
kctl cluster-info >/dev/null 2>&1 || {
  fail "Kubernetes cluster is not reachable"
  exit 1
}
kctl -n "$CONTROL_NS" rollout status deploy/workflow-recipes --timeout=120s >/dev/null

header "Phase 1 — isolated fixture"
cleanup >/dev/null 2>&1 || true
cat <<YAML | kctl apply -f - >/dev/null
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    e2e.clerum.io/suite: wrc-networkpolicy-service-routes
spec:
  description: "PR 580 service-route and live-convergence fixture."
  workloads:
    - id: ${UI_ID}
      type: deployment
      image: busybox:1.36.1
      port: 8080
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'ui-ok\n' > /www/index.html && exec httpd -f -p 8080 -h /www"
    - id: ${API_ID}
      type: deployment
      image: busybox:1.36.1
      port: 8080
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'api-ok\n' > /www/index.html && exec httpd -f -p 8080 -h /www"
      egressBindings:
        - dns: "${DB_ID}.${SANDBOX_NS}.svc.cluster.local"
          port: ${DB_PORT}
          protocol: TCP
    - id: ${DB_ID}
      type: deployment
      image: busybox:1.36.1
      port: ${DB_PORT}
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'db-ok\n' > /www/index.html && exec httpd -f -p ${DB_PORT} -h /www"
  ui:
    workloadRef: ${UI_ID}
    port: 8080
    title: "NetworkPolicy route fixture"
    defaultPath: "/"
    egress:
      internal:
        - workloadRef: ${API_ID}
          port: 8080
YAML
CREATED=1
wait_for_recipe_active 180

UI_DEPLOYMENT="$(wait_for_workload_instance "$UI_ID" 120)"
API_DEPLOYMENT="$(wait_for_workload_instance "$API_ID" 120)"
DB_DEPLOYMENT="$(wait_for_workload_instance "$DB_ID" 120)"
[ -n "$UI_DEPLOYMENT" ] && [ -n "$API_DEPLOYMENT" ] && [ -n "$DB_DEPLOYMENT" ] || {
  fail "One or more workload instance names are missing"
  exit 1
}

wait_for_deployment "$SANDBOX_UI_NS" "$UI_DEPLOYMENT" 180
wait_for_deployment "$SANDBOX_NS" "$API_DEPLOYMENT" 180
wait_for_deployment "$SANDBOX_NS" "$DB_DEPLOYMENT" 180

for policy in "$UI_INGRESS_POLICY" "$WL_EGRESS_POLICY" "$WL_INGRESS_POLICY"; do
  wrc_wait_for_np "$SANDBOX_NS" "$policy" 120
done
ok "ui-ingress, workload-egress and workload-ingress materialized"

API_CLUSTER_IP="$(kctl get service "$API_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
DB_CLUSTER_IP="$(kctl get service "$DB_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$API_CLUSTER_IP" ] && [ -n "$DB_CLUSTER_IP" ] || {
  fail "Fixture Service ClusterIP discovery failed"
  exit 1
}

header "Phase 2 — correctly configured positive routes"
assert_http_body "sandbox UI reaches declared API backend" "$SANDBOX_UI_NS" "$UI_DEPLOYMENT" "$API_CLUSTER_IP" 8080 "api-ok"
assert_http_body "API workload reaches declared sibling DB" "$SANDBOX_NS" "$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 3 — negative controls"
apply_rogue_pod "$SANDBOX_UI_NS" "$ROGUE_UI_POD"
apply_rogue_pod "$SANDBOX_NS" "$ROGUE_WORKLOAD_POD"
assert_pod_blocked "unlabelled sandbox-ui pod cannot reach recipe API" "$SANDBOX_UI_NS" "$ROGUE_UI_POD" "$API_CLUSTER_IP" 8080
assert_pod_blocked "unlabelled sandbox workload cannot reach recipe DB" "$SANDBOX_NS" "$ROGUE_WORKLOAD_POD" "$DB_CLUSTER_IP" "$DB_PORT"

header "Phase 4 — live drift repair"
ui_hash="$(wrc_np_spec_hash "$SANDBOX_NS" "$UI_INGRESS_POLICY")"
wl_egress_hash="$(wrc_np_spec_hash "$SANDBOX_NS" "$WL_EGRESS_POLICY")"
wl_ingress_hash="$(wrc_np_spec_hash "$SANDBOX_NS" "$WL_INGRESS_POLICY")"

wrc_inject_selector_drift "$SANDBOX_NS" "$UI_INGRESS_POLICY"
wrc_inject_selector_drift "$SANDBOX_NS" "$WL_EGRESS_POLICY"
wrc_inject_selector_drift "$SANDBOX_NS" "$WL_INGRESS_POLICY"
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120

wrc_wait_for_np_spec_hash "$SANDBOX_NS" "$UI_INGRESS_POLICY" "$ui_hash" 120
wrc_wait_for_np_spec_hash "$SANDBOX_NS" "$WL_EGRESS_POLICY" "$wl_egress_hash" 120
wrc_wait_for_np_spec_hash "$SANDBOX_NS" "$WL_INGRESS_POLICY" "$wl_ingress_hash" 120
ok "WRC repaired live spec drift for all three families"

assert_http_body "sandbox UI route recovered after NetworkPolicy repair" "$SANDBOX_UI_NS" "$UI_DEPLOYMENT" "$API_CLUSTER_IP" 8080 "api-ok"
assert_http_body "workload sibling route recovered after NetworkPolicy repair" "$SANDBOX_NS" "$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 5 — terminating race self-heals without another parent event"
terminating_uid="$(wrc_np_uid "$SANDBOX_NS" "$WL_INGRESS_POLICY")"
terminating_generation="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.metadata.generation}')"
kctl patch networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --type=merge \
  -p '{"metadata":{"finalizers":["e2e.evenfire.ai/hold-deletion"]}}' >/dev/null
HELD_POLICY_FINALIZER=1
kctl delete networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --wait=false >/dev/null
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wait_for_recipe_message 'is terminating; retrying after deletion' 120
kctl patch networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --type=merge \
  -p '{"metadata":{"finalizers":[]}}' >/dev/null
HELD_POLICY_FINALIZER=0
wrc_wait_for_np_recreated "$SANDBOX_NS" "$WL_INGRESS_POLICY" "$terminating_uid" "$wl_ingress_hash" 120
[ "$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.metadata.generation}')" = "$((terminating_generation + 1))" ] || {
  fail "NetworkPolicy recovery depended on an unexpected second parent spec event"
  exit 1
}
wait_for_recipe_active 120
assert_http_body "workload sibling route recovered after scheduled NetworkPolicy retry" "$SANDBOX_NS" "$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 6 — steady-state no-churn"
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wrc_wait_for_np_noop_witness "$SANDBOX_NS" "$UI_INGRESS_POLICY" ui-ingress apply 120
wrc_wait_for_np_noop_witness "$SANDBOX_NS" "$WL_EGRESS_POLICY" workload-egress workload-egress-prefilter 120
wrc_wait_for_np_noop_witness "$SANDBOX_NS" "$WL_INGRESS_POLICY" workload-ingress apply 120
assert_all_stable

header "Phase 7 — cleanup"
cleanup
CREATED=0
for policy in "$UI_INGRESS_POLICY" "$WL_EGRESS_POLICY" "$WL_INGRESS_POLICY"; do
  if kctl get networkpolicy "$policy" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    fail "NetworkPolicy ${SANDBOX_NS}/${policy} survived cleanup"
    exit 1
  fi
done
ok "WorkflowRecipe and WRC NetworkPolicies were removed"

print_results
