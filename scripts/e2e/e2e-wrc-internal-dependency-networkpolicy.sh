#!/usr/bin/env bash
# Issue #485 E2E: WRC must infer {{workload:host}} dependencies and create
# wr-intdep NetworkPolicies without spec.workloads[].egressBindings[].

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-fixtures.sh"

[ "$#" -eq 0 ] || {
  fail 'This suite accepts no arguments; cleanup is restricted to resources created by this invocation'
  exit 2
}
wrc_fixture_init

RECIPE_NAME="e2e-intdep-${E2E_RUN_ID}"
SOURCE_ID="src-${E2E_RUN_ID}"
BACKEND_ID="be-${E2E_RUN_ID}"
DENIED_POD="deny-${E2E_RUN_ID}"
PROBE_EGRESS_POLICY="intdep-probe-egress-${E2E_RUN_ID}"
PROBE_INGRESS_POLICY="intdep-probe-ingress-${E2E_RUN_ID}"
BACKEND_PORT="${E2E_BACKEND_PORT:-8080}"
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"
SOURCE_DEPLOYMENT="$SOURCE_ID"
BACKEND_DEPLOYMENT="$BACKEND_ID"
CLEANUP_DONE=0

cleanup() {
  wrc_cleanup_owned
}

on_exit() {
  local status=$?
  if [ "$CLEANUP_DONE" -ne 1 ] && ! cleanup; then
    if [ "$status" -ne 0 ]; then
      warn 'Internal dependency E2E cleanup also failed; original failure is preserved'
    else
      fail 'Internal dependency E2E cleanup failed'
      status=1
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

[[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] && [ "$BACKEND_PORT" -gt 0 ] &&
  [ "$BACKEND_PORT" -le 65535 ] || { fail 'Invalid E2E_BACKEND_PORT'; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 && ok "Command '$1' available" && return
  fail "Command '$1' not found"
  exit 1
}

condition_value() {
  kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="InternalDependenciesReady")]}{.status}{"|"}{.reason}{"|"}{.message}{end}' \
    2>/dev/null || true
}

wait_internal_ready() {
  local elapsed=0 timeout=${1:-120} phase condition
  while [ "$elapsed" -lt "$timeout" ]; do
    condition="$(condition_value)"
    case "$condition" in
      True\|Reconciled\|*) ok "InternalDependenciesReady=True (${condition})"; return 0 ;;
      False\|*) fail "InternalDependenciesReady=False (${condition})"; return 1 ;;
    esac
    phase="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
      -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    [ "$phase" = "failed" ] && fail "WorkflowRecipe failed before internal policies were ready" && return 1
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Timed out waiting for InternalDependenciesReady=True"
  return 1
}

wait_for_workload_instance() {
  local workload_id=$1 timeout=${2:-$TIMEOUT_POD} elapsed=0 instance
  while [ "$elapsed" -lt "$timeout" ]; do
    instance="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
      -o "jsonpath={.status.workloadInstances.${workload_id}}" 2>/dev/null || true)"
    if [ -n "$instance" ]; then
      printf '%s\n' "$instance"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

policy_refs() {
  kctl get networkpolicy -A -l "$1" \
    -o go-template='{{range .items}}{{.metadata.namespace}}/{{.metadata.name}}{{"\n"}}{{end}}' \
    2>/dev/null | sed '/^$/d' || true
}

one_policy_ref() {
  local selector=$1 description=$2 elapsed=0 timeout=${3:-90} refs count
  while [ "$elapsed" -lt "$timeout" ]; do
    refs="$(policy_refs "$selector")"
    count="$(printf "%s\n" "$refs" | sed '/^$/d' | wc -l | tr -d ' ')"
    [ "$count" = "1" ] && printf "%s\n" "$refs" && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Expected one ${description} wr-intdep policy for selector: ${selector}"
  return 1
}

netpol_go() {
  kctl get networkpolicy "$2" -n "$1" -o "$3" 2>/dev/null || true
}

assert_policy() {
  local ref=$1 direction=$2 selector_workload=$3 peer_workload=$4
  local ns="${ref%%/*}" name="${ref#*/}" policy_type policy_direction selected yaml

  case "$name" in
    wr-intdep-*) ok "${direction} policy uses wr-intdep lane: ${ref}" ;;
    *) fail "${direction} policy has wrong name: ${ref}"; return 1 ;;
  esac

  policy_type="$(netpol_go "$ns" "$name" 'go-template={{ index .metadata.labels "clerum.io/policy-type" }}')"
  policy_direction="$(netpol_go "$ns" "$name" 'go-template={{ index .metadata.labels "clerum.io/policy-direction" }}')"
  selected="$(netpol_go "$ns" "$name" 'go-template={{ index .spec.podSelector.matchLabels "clerum.io/workload" }}')"
  yaml="$(kctl get networkpolicy "$name" -n "$ns" -o yaml)"

  [ "$policy_type" = "internal-dependency" ] || { fail "${ref} missing policy-type"; return 1; }
  [ "$policy_direction" = "$direction" ] || { fail "${ref} has direction ${policy_direction}"; return 1; }
  [ "$selected" = "$selector_workload" ] || { fail "${ref} selects ${selected}, expected ${selector_workload}"; return 1; }
  printf "%s" "$yaml" | grep -Fq "clerum.io/workload: ${peer_workload}" || {
    fail "${ref} does not pin peer ${peer_workload}"
    return 1
  }
  printf "%s" "$yaml" | grep -Fq "port: ${BACKEND_PORT}" || {
    fail "${ref} does not pin port ${BACKEND_PORT}"
    return 1
  }
  if [ "$direction" = "ingress" ]; then
    printf "%s" "$yaml" | grep -Fq "from:" || {
      fail "${ref} has no Kubernetes ingress from selector"
      return 1
    }
    if printf "%s" "$yaml" | grep -Fq "_from:"; then
      fail "${ref} contains non-Kubernetes _from field"
      return 1
    fi
  fi
  ok "${ref} pins ${selector_workload} to ${peer_workload}:${BACKEND_PORT}"
}

header "WRC internal dependency NetworkPolicy E2E"
log "Recipe=${RECIPE_NAME} source=${SOURCE_ID} backend=${BACKEND_ID}"
log "Context=$(current_e2e_context || true)"

header "Phase 0 - Safety"
need_cmd "$KUBECTL_BIN"
require_safe_kube_context
if ! kctl cluster-info >/dev/null 2>&1; then
  fail "Kubernetes cluster not reachable"
  exit 1
fi
ok "Kubernetes cluster reachable"
for ns in "$WORKFLOW_RECIPE_NS" "$SANDBOX_NS" "$CONTROL_NS"; do
  if ! kctl get ns "$ns" >/dev/null 2>&1; then
    fail "Namespace ${ns} not found"
    exit 1
  fi
  ok "Namespace ${ns} exists"
done
if ! kctl get crd workflowrecipes.clerum.io >/dev/null 2>&1; then
  fail "WorkflowRecipe CRD not installed"
  exit 1
fi
ok "WorkflowRecipe CRD installed"
if ! kctl -n "$CONTROL_NS" rollout status deploy/workflow-recipes --timeout=120s >/dev/null 2>&1; then
    fail "workflow-recipes deployment is not ready"
    exit 1
fi
ok "workflow-recipes rolled out"

header "Phase 1 - Create isolated fixture"
cat <<YAML | kctl create --dry-run=client -f - -o json | wrc_create_owned
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    e2e.clerum.io/suite: wrc-internal-dependency-networkpolicy
spec:
  description: "Issue #485 E2E fixture for inferred WRC internal dependencies."
  workloads:
    - id: ${SOURCE_ID}
      type: deployment
      image: busybox:1.36.1
      command: ["sh", "-c"]
      args:
        - "trap 'exit 0' TERM INT; while true; do sleep 3600; done"
      env:
        - name: TARGET_URL
          value: "http://{{${BACKEND_ID}:host}}:{{${BACKEND_ID}:port}}/"
    - id: ${BACKEND_ID}
      type: deployment
      image: busybox:1.36.1
      port: ${BACKEND_PORT}
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'issue485-ok\n' > /www/index.html && exec httpd -f -p ${BACKEND_PORT} -h /www"
YAML
ok "Run-owned WorkflowRecipe fixture created"

if ! kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json \
  | jq -e 'all(.spec.workloads[]; ((.egressBindings // []) | length) == 0)' >/dev/null; then
  fail "Could not verify the live fixture has no egressBindings shortcut"
  exit 1
fi
ok "Fixture has no egressBindings shortcut"

header "Phase 2 - WRC reconciliation"
SOURCE_DEPLOYMENT="$(wait_for_workload_instance "$SOURCE_ID" "$TIMEOUT_POD")" || {
  fail "Source workload instance was not assigned"
  exit 1
}
BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$BACKEND_ID" "$TIMEOUT_POD")" || {
  fail "Backend workload instance was not assigned"
  exit 1
}
if ! wait_for_deployment "$SANDBOX_NS" "$SOURCE_DEPLOYMENT" "$TIMEOUT_POD"; then
  fail "Source deployment not ready"
  exit 1
fi
ok "Source deployment ready"
if ! wait_for_deployment "$SANDBOX_NS" "$BACKEND_DEPLOYMENT" "$TIMEOUT_POD"; then
  fail "Backend deployment not ready"
  exit 1
fi
ok "Backend deployment ready"
wait_internal_ready "$TIMEOUT_POD"

resolved_target="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- printenv TARGET_URL 2>/dev/null || true)"
expected_target="http://${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local:${BACKEND_PORT}/"
if [ "$resolved_target" != "$expected_target" ]; then
  fail "TARGET_URL resolved to '${resolved_target}', expected '${expected_target}'"
  exit 1
fi
ok "TARGET_URL resolved to ${resolved_target}"

header "Phase 3 - wr-intdep policy shape"
egress_selector="clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME},clerum.io/source-workload=${SOURCE_ID}"
ingress_selector="clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME},clerum.io/target-workload=${BACKEND_ID}"
egress_ref="$(one_policy_ref "$egress_selector" "egress")"
ingress_ref="$(one_policy_ref "$ingress_selector" "ingress")"
assert_policy "$egress_ref" "egress" "$SOURCE_ID" "$BACKEND_ID"
assert_policy "$ingress_ref" "ingress" "$BACKEND_ID" "$SOURCE_ID"

header "Phase 4 - Positive packet flow"
wrc_assert_http_allowed 'WRC source reached backend through inferred internal dependency' \
  "$SANDBOX_NS" "deploy/${SOURCE_DEPLOYMENT}" \
  "${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local" "$BACKEND_PORT" issue485-ok

header "Phase 5 - Live drift repair and steady no-churn"
egress_ns="${egress_ref%%/*}"
egress_name="${egress_ref#*/}"
ingress_ns="${ingress_ref%%/*}"
ingress_name="${ingress_ref#*/}"
egress_hash="$(wrc_np_spec_hash "$egress_ns" "$egress_name")"
ingress_hash="$(wrc_np_spec_hash "$ingress_ns" "$ingress_name")"

wrc_inject_selector_drift "$egress_ns" "$egress_name"
wrc_inject_selector_drift "$ingress_ns" "$ingress_name"
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wrc_wait_for_np_spec_hash "$egress_ns" "$egress_name" "$egress_hash" 120
wrc_wait_for_np_spec_hash "$ingress_ns" "$ingress_name" "$ingress_hash" 120

wrc_assert_http_allowed 'Internal dependency traffic recovered after live policy repair' \
  "$SANDBOX_NS" "deploy/${SOURCE_DEPLOYMENT}" \
  "${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local" "$BACKEND_PORT" issue485-ok

wrc_begin_np_observation
wrc_track_np "$egress_ns" "$egress_name" internal-dependency
wrc_track_np "$ingress_ns" "$ingress_name" internal-dependency
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
wrc_assert_np_observation_clean "$STABILITY_SECONDS" 120

header "Phase 6 - Negative packet flow"
cat <<YAML | kctl create --dry-run=client -f - -o json | wrc_create_owned
apiVersion: v1
kind: Pod
metadata:
  name: ${DENIED_POD}
  namespace: ${SANDBOX_NS}
  labels:
    e2e.clerum.io/probe: ${DENIED_POD}
    e2e.clerum.io/suite: wrc-internal-dependency-networkpolicy
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: denied
      image: busybox:1.36.1
      command: ["sh", "-c", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
YAML
if ! wait_for_pod "$SANDBOX_NS" "e2e.clerum.io/probe=${DENIED_POD}" 60; then
  fail "Rogue probe pod not ready"
  exit 1
fi
ok "Rogue probe pod ready"

# The rogue source must have a working egress path before testing backend
# ingress. Use the Service IP so denied DNS cannot masquerade as ingress denial.
backend_ip="$(kctl get service "$BACKEND_DEPLOYMENT" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')"
[[ "$backend_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  fail 'Backend Service has no IPv4 ClusterIP for the isolated ingress control'
  exit 1
}
backend_pod_selector="$(kctl get deployment "$BACKEND_DEPLOYMENT" -n "$SANDBOX_NS" -o json \
  | jq -ce '.spec.selector.matchLabels | select(type == "object" and length > 0)')"
probe_pod_selector="$(jq -cn --arg probe "$DENIED_POD" '{"e2e.clerum.io/probe":$probe}')"
wrc_create_connection_policy "$PROBE_EGRESS_POLICY" Egress \
  "$SANDBOX_NS" "$probe_pod_selector" "$SANDBOX_NS" "$backend_pod_selector" "$BACKEND_PORT"
wrc_create_connection_policy "$PROBE_INGRESS_POLICY" Ingress \
  "$SANDBOX_NS" "$backend_pod_selector" "$SANDBOX_NS" "$probe_pod_selector" "$BACKEND_PORT"
wrc_assert_http_allowed 'Same rogue source reaches healthy backend with temporary ingress' \
  "$SANDBOX_NS" "$DENIED_POD" "$backend_ip" "$BACKEND_PORT" issue485-ok
wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "$PROBE_INGRESS_POLICY"
wrc_assert_http_blocked 'Internal dependency ingress rejects a source outside its workload selector' \
  "$SANDBOX_NS" "$DENIED_POD" "$backend_ip" "$BACKEND_PORT"
wrc_create_connection_policy "$PROBE_INGRESS_POLICY" Ingress \
  "$SANDBOX_NS" "$backend_pod_selector" "$SANDBOX_NS" "$probe_pod_selector" "$BACKEND_PORT"
wrc_assert_http_allowed 'Same rogue source and backend remain healthy after the negative control' \
  "$SANDBOX_NS" "$DENIED_POD" "$backend_ip" "$BACKEND_PORT" issue485-ok
wrc_delete_owned "$SANDBOX_NS" NetworkPolicy "$PROBE_INGRESS_POLICY"

header "Phase 7 - Cleanup"
cleanup
CLEANUP_DONE=1
ok 'Run-owned fixture resources removed with UID-checked cleanup'

print_results
