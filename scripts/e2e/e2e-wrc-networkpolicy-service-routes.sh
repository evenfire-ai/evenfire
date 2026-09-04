#!/usr/bin/env bash
# PR #580 E2E for correctly configured WRC NetworkPolicy service routes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-fixtures.sh"
wrc_fixture_init

RECIPE_NAME="e2e-routes-${E2E_RUN_ID}"
SANDBOX_UI_NS="${SANDBOX_UI_NS:-sandbox-ui}"
UI_ID="ui"
API_ID="api"
DB_ID="db"
OTHER_DB_ID="other-db"
DB_PORT=8081
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"
ROGUE_UI_POD="${RECIPE_NAME}-rogue-ui"
ROGUE_WORKLOAD_POD="${RECIPE_NAME}-rogue-wl"
CREATED=0
HELD_POLICY_FINALIZER=0
HELD_POLICY_UID=""

UI_DEPLOYMENT=""
API_DEPLOYMENT=""
DB_DEPLOYMENT=""
OTHER_DB_DEPLOYMENT=""

UI_INGRESS_POLICY="ui-ingress-${RECIPE_NAME}-${API_ID}"
WL_EGRESS_POLICY="wl-egress-${RECIPE_NAME}-${API_ID}"
WL_INGRESS_POLICY="wl-ingress-${RECIPE_NAME}-${DB_ID}"

cleanup() {
  local status=0
  if [ "$HELD_POLICY_FINALIZER" = "1" ]; then release_policy_hold || status=1; fi
  wrc_cleanup_owned || status=1
  return "$status"
}

release_policy_hold() {
  local policy patch
  policy="$(kctl get networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --ignore-not-found -o json)" || return 1
  [ -n "$policy" ] || { HELD_POLICY_FINALIZER=0; return 0; }
  patch="$(printf '%s' "$policy" | jq -ce --arg uid "$HELD_POLICY_UID" '
    select(.metadata.uid == $uid)
    | [{op:"test",path:"/metadata/uid",value:$uid},
       {op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
       {op:"replace",path:"/metadata/finalizers",value:[.metadata.finalizers[] | select(. != "e2e.invalid/hold-deletion")]}]')" || return 1
  kctl patch networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --type=json -p "$patch" >/dev/null || return 1
  HELD_POLICY_FINALIZER=0
}

on_exit() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [ "$CREATED" = "1" ] && [ "${E2E_KEEP_RESOURCES:-0}" != "1" ]; then
    cleanup || cleanup_status=$?
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    warn 'WRC service-route E2E cleanup did not complete'
    if [ "$status" -eq 0 ]; then status=1; fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

apply_rogue_pod() {
  local namespace=$1 name=$2
  cat <<YAML | kctl create --dry-run=client -f - -o json | wrc_create_owned
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

header "WRC NetworkPolicy correctly-configured service routes"
require_safe_kube_context
kctl cluster-info >/dev/null 2>&1 || {
  fail "Kubernetes cluster is not reachable"
  exit 1
}
kctl -n "$CONTROL_NS" rollout status deploy/workflow-recipes --timeout=120s >/dev/null

header "Phase 1 — isolated fixture"
CREATED=1
cat <<YAML | kctl create --dry-run=client -f - -o json | wrc_create_owned
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
    - id: ${OTHER_DB_ID}
      type: deployment
      image: busybox:1.36.1
      port: ${DB_PORT}
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'other-db-ok\n' > /www/index.html && exec httpd -f -p ${DB_PORT} -h /www"
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
wait_for_recipe_active 180

UI_DEPLOYMENT="$(wait_for_workload_instance "$UI_ID" 120)"
API_DEPLOYMENT="$(wait_for_workload_instance "$API_ID" 120)"
DB_DEPLOYMENT="$(wait_for_workload_instance "$DB_ID" 120)"
OTHER_DB_DEPLOYMENT="$(wait_for_workload_instance "$OTHER_DB_ID" 120)"
[ -n "$UI_DEPLOYMENT" ] && [ -n "$API_DEPLOYMENT" ] && [ -n "$DB_DEPLOYMENT" ] || {
  fail "One or more workload instance names are missing"
  exit 1
}

wait_for_deployment "$SANDBOX_UI_NS" "$UI_DEPLOYMENT" 180
wait_for_deployment "$SANDBOX_NS" "$API_DEPLOYMENT" 180
wait_for_deployment "$SANDBOX_NS" "$DB_DEPLOYMENT" 180
wait_for_deployment "$SANDBOX_NS" "$OTHER_DB_DEPLOYMENT" 180

for policy in "$UI_INGRESS_POLICY" "$WL_EGRESS_POLICY" "$WL_INGRESS_POLICY"; do
  wrc_wait_for_np "$SANDBOX_NS" "$policy" 120
done
ok "ui-ingress, workload-egress and workload-ingress materialized"

API_CLUSTER_IP="$(kctl get service "$API_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
DB_CLUSTER_IP="$(kctl get service "$DB_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
OTHER_DB_CLUSTER_IP="$(kctl get service "$OTHER_DB_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$API_CLUSTER_IP" ] && [ -n "$DB_CLUSTER_IP" ] || {
  fail "Fixture Service ClusterIP discovery failed"
  exit 1
}

header "Phase 2 — correctly configured positive routes"
wrc_assert_http_allowed "sandbox UI reaches declared API backend" "$SANDBOX_UI_NS" "deploy/$UI_DEPLOYMENT" "$API_CLUSTER_IP" 8080 "api-ok"
wrc_assert_http_allowed "API workload reaches declared sibling DB" "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 3 — negative controls"
apply_rogue_pod "$SANDBOX_UI_NS" "$ROGUE_UI_POD"
apply_rogue_pod "$SANDBOX_NS" "$ROGUE_WORKLOAD_POD"
api_selector="$(kctl get deployment "$API_DEPLOYMENT" -n "$SANDBOX_NS" -o json | jq -ce '.spec.selector.matchLabels')"
db_selector="$(kctl get deployment "$DB_DEPLOYMENT" -n "$SANDBOX_NS" -o json | jq -ce '.spec.selector.matchLabels')"
other_db_selector="$(kctl get deployment "$OTHER_DB_DEPLOYMENT" -n "$SANDBOX_NS" -o json | jq -ce '.spec.selector.matchLabels')"
ui_probe_selector="$(jq -cn --arg probe "$ROGUE_UI_POD" '{"e2e.clerum.io/probe":$probe}')"
wl_probe_selector="$(jq -cn --arg probe "$ROGUE_WORKLOAD_POD" '{"e2e.clerum.io/probe":$probe}')"

# Leave only the ingress under test as the rejecting boundary. The same rogue
# must first prove it can execute and reach the healthy backend with a narrow
# temporary ingress permission, and must lose access when that permission goes.
wrc_create_connection_policy "${RECIPE_NAME}-ui-source" Egress "$SANDBOX_UI_NS" "$ui_probe_selector" "$SANDBOX_NS" "$api_selector" 8080
wrc_create_connection_policy "${RECIPE_NAME}-wl-source" Egress "$SANDBOX_NS" "$wl_probe_selector" "$SANDBOX_NS" "$db_selector" "$DB_PORT"
for lane in ui wl; do
  if [ "$lane" = ui ]; then
    probe_ns=$SANDBOX_UI_NS; probe=$ROGUE_UI_POD; probe_selector=$ui_probe_selector
    target_selector=$api_selector; target_ip=$API_CLUSTER_IP; target_port=8080; expected=api-ok
  else
    probe_ns=$SANDBOX_NS; probe=$ROGUE_WORKLOAD_POD; probe_selector=$wl_probe_selector
    target_selector=$db_selector; target_ip=$DB_CLUSTER_IP; target_port=$DB_PORT; expected=db-ok
  fi
  control="${RECIPE_NAME}-${lane}-target"
  wrc_create_connection_policy "$control" Ingress "$SANDBOX_NS" "$target_selector" "$probe_ns" "$probe_selector" "$target_port"
  wrc_assert_http_allowed "$lane negative probe reaches the healthy target with its control permission" "$probe_ns" "$probe" "$target_ip" "$target_port" "$expected"
  wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "$control"
  wrc_assert_http_blocked "$lane ingress rejects the rogue when only its target permission is removed" "$probe_ns" "$probe" "$target_ip" "$target_port"
  wrc_create_connection_policy "$control" Ingress "$SANDBOX_NS" "$target_selector" "$probe_ns" "$probe_selector" "$target_port"
  wrc_assert_http_allowed "$lane negative control remains healthy after the denial" "$probe_ns" "$probe" "$target_ip" "$target_port" "$expected"
  wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "$control"
done

# For workload egress, allow only the complementary destination ingress. An
# undeclared sibling must remain unreachable from the actual API workload.
wrc_create_connection_policy "${RECIPE_NAME}-other-target" Ingress "$SANDBOX_NS" "$other_db_selector" "$SANDBOX_NS" "$api_selector" "$DB_PORT"
wrc_create_connection_policy "${RECIPE_NAME}-other-source" Egress "$SANDBOX_NS" "$api_selector" "$SANDBOX_NS" "$other_db_selector" "$DB_PORT"
wrc_assert_http_allowed 'API probe reaches undeclared sibling with temporary egress permission' "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$OTHER_DB_CLUSTER_IP" "$DB_PORT" 'other-db-ok'
wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "${RECIPE_NAME}-other-source"
wrc_assert_http_blocked 'Workload egress rejects the undeclared sibling with destination ingress allowed' "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$OTHER_DB_CLUSTER_IP" "$DB_PORT"
wrc_create_connection_policy "${RECIPE_NAME}-other-source" Egress "$SANDBOX_NS" "$api_selector" "$SANDBOX_NS" "$other_db_selector" "$DB_PORT"
wrc_assert_http_allowed 'Undeclared sibling remains healthy after egress denial' "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$OTHER_DB_CLUSTER_IP" "$DB_PORT" 'other-db-ok'
wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "${RECIPE_NAME}-other-source"

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

wrc_assert_http_allowed "sandbox UI route recovered after NetworkPolicy repair" "$SANDBOX_UI_NS" "deploy/$UI_DEPLOYMENT" "$API_CLUSTER_IP" 8080 "api-ok"
wrc_assert_http_allowed "workload sibling route recovered after NetworkPolicy repair" "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 5 — terminating race self-heals without another parent event"
terminating_uid="$(wrc_np_uid "$SANDBOX_NS" "$WL_INGRESS_POLICY")"
HELD_POLICY_UID=$terminating_uid
terminating_generation="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.metadata.generation}')"
held_policy="$(kctl get networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" -o json)"
printf '%s' "$held_policy" | wrc_record_owned
hold_patch="$(printf '%s' "$held_policy" | jq -c '[
  {op:"test",path:"/metadata/uid",value:.metadata.uid},
  {op:"test",path:"/metadata/resourceVersion",value:.metadata.resourceVersion},
  {op:"add",path:"/metadata/finalizers",value:((.metadata.finalizers // []) + ["e2e.invalid/hold-deletion"])}]')"
kctl patch networkpolicy "$WL_INGRESS_POLICY" -n "$SANDBOX_NS" --type=json -p "$hold_patch" >/dev/null
HELD_POLICY_FINALIZER=1
wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "$WL_INGRESS_POLICY" false
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wait_for_recipe_message 'is terminating; retrying after deletion' 120
release_policy_hold
wrc_wait_for_np_recreated "$SANDBOX_NS" "$WL_INGRESS_POLICY" "$terminating_uid" "$wl_ingress_hash" 120
[ "$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.metadata.generation}')" = "$((terminating_generation + 1))" ] || {
  fail "NetworkPolicy recovery depended on an unexpected second parent spec event"
  exit 1
}
wait_for_recipe_active 120
wrc_assert_http_allowed "workload sibling route recovered after scheduled NetworkPolicy retry" "$SANDBOX_NS" "deploy/$API_DEPLOYMENT" "$DB_CLUSTER_IP" "$DB_PORT" "db-ok"

header "Phase 6 — steady-state no-churn"
wrc_begin_np_observation
wrc_track_np "$SANDBOX_NS" "$UI_INGRESS_POLICY" ui-ingress
wrc_track_np "$SANDBOX_NS" "$WL_EGRESS_POLICY" workload-egress workload-egress-prefilter
wrc_track_np "$SANDBOX_NS" "$WL_INGRESS_POLICY" workload-ingress
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wrc_assert_np_observation_clean "$STABILITY_SECONDS" 120

header "Phase 7 — cleanup"
cleanup
CREATED=0
for policy in "$UI_INGRESS_POLICY" "$WL_EGRESS_POLICY" "$WL_INGRESS_POLICY"; do
  remaining="$(kctl get networkpolicy "$policy" -n "$SANDBOX_NS" --ignore-not-found -o name)"
  if [ -n "$remaining" ]; then
    fail "NetworkPolicy ${SANDBOX_NS}/${policy} survived cleanup"
    exit 1
  fi
done
ok "WorkflowRecipe and WRC NetworkPolicies were removed"

print_results
