#!/usr/bin/env bash
# Issue #485 E2E: WRC must infer {{workload:host}} dependencies and create
# wr-intdep NetworkPolicies without spec.workloads[].egressBindings[].

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"

raw_run_id="${E2E_RUN_ID:-$(date +%H%M%S)-$$}"
RUN_ID="$(printf "%s" "$raw_run_id" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' | cut -c1-20)"
[ -n "$RUN_ID" ] || RUN_ID="run-$$"

RECIPE_NAME="${E2E_RECIPE_NAME:-e2e-wrc-intdep-${RUN_ID}}"
SOURCE_ID="${E2E_SOURCE_ID:-src-${RUN_ID}}"
BACKEND_ID="${E2E_BACKEND_ID:-be-${RUN_ID}}"
DENIED_POD="${E2E_DENIED_POD:-deny-${RUN_ID}}"
BACKEND_PORT="${E2E_BACKEND_PORT:-8080}"
CONNECT_TIMEOUT="${E2E_CONNECT_TIMEOUT:-6}"
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"
SOURCE_DEPLOYMENT="$SOURCE_ID"
BACKEND_DEPLOYMENT="$BACKEND_ID"
CREATED=0

cleanup() {
  local status=0
  kctl delete pod "$DENIED_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false \
    >/dev/null 2>&1 || status=1
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" \
    >/dev/null 2>&1 || status=1
  kctl delete deployment "$SOURCE_DEPLOYMENT" "$BACKEND_DEPLOYMENT" -n "$SANDBOX_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  kctl delete service "$SOURCE_DEPLOYMENT" "$BACKEND_DEPLOYMENT" -n "$SANDBOX_NS" \
    --ignore-not-found >/dev/null 2>&1 || status=1
  kctl delete networkpolicy -n "$SANDBOX_NS" \
    -l "clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME}" \
    --ignore-not-found >/dev/null 2>&1 || status=1
  return "$status"
}

on_exit() {
  local status=$?
  if [ "$CREATED" = "1" ] && [ "${E2E_KEEP_RESOURCES:-0}" != "1" ]; then
    cleanup >/dev/null 2>&1 || {
      [ "$status" -ne 0 ] && warn "issue #485 E2E cleanup left resources behind"
      [ "$status" -eq 0 ] && fail "issue #485 E2E cleanup left resources behind" && status=1
    }
  fi
  exit "$status"
}
trap on_exit EXIT

if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup
  exit $?
fi

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
kctl cluster-info >/dev/null 2>&1 && ok "Kubernetes cluster reachable" || {
  fail "Kubernetes cluster not reachable"
  exit 1
}
for ns in "$WORKFLOW_RECIPE_NS" "$SANDBOX_NS" "$CONTROL_NS"; do
  kctl get ns "$ns" >/dev/null 2>&1 && ok "Namespace ${ns} exists" || {
    fail "Namespace ${ns} not found"
    exit 1
  }
done
kctl get crd workflowrecipes.clerum.io >/dev/null 2>&1 && ok "WorkflowRecipe CRD installed" || {
  fail "WorkflowRecipe CRD not installed"
  exit 1
}
kctl -n "$CONTROL_NS" rollout status deploy/workflow-recipes --timeout=120s >/dev/null 2>&1 \
  && ok "workflow-recipes rolled out" || {
    fail "workflow-recipes deployment is not ready"
    exit 1
  }

header "Phase 1 - Apply isolated fixture"
cleanup >/dev/null 2>&1 || true
cat <<YAML | kctl apply -f -
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
CREATED=1
ok "WorkflowRecipe fixture applied"

if kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.workloads[*].egressBindings}' | grep -q .; then
  fail "Fixture contains egressBindings; that would hide the behavior under test"
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
wait_for_deployment "$SANDBOX_NS" "$SOURCE_DEPLOYMENT" "$TIMEOUT_POD" && ok "Source deployment ready" || {
  fail "Source deployment not ready"
  exit 1
}
wait_for_deployment "$SANDBOX_NS" "$BACKEND_DEPLOYMENT" "$TIMEOUT_POD" && ok "Backend deployment ready" || {
  fail "Backend deployment not ready"
  exit 1
}
wait_internal_ready "$TIMEOUT_POD"

resolved_target="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- printenv TARGET_URL 2>/dev/null || true)"
expected_target="http://${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local:${BACKEND_PORT}/"
[ "$resolved_target" = "$expected_target" ] && ok "TARGET_URL resolved to ${resolved_target}" || {
  fail "TARGET_URL resolved to '${resolved_target}', expected '${expected_target}'"
  exit 1
}

header "Phase 3 - wr-intdep policy shape"
egress_selector="clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME},clerum.io/source-workload=${SOURCE_ID}"
ingress_selector="clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME},clerum.io/target-workload=${BACKEND_ID}"
egress_ref="$(one_policy_ref "$egress_selector" "egress")"
ingress_ref="$(one_policy_ref "$ingress_selector" "ingress")"
assert_policy "$egress_ref" "egress" "$SOURCE_ID" "$BACKEND_ID"
assert_policy "$ingress_ref" "ingress" "$BACKEND_ID" "$SOURCE_ID"

header "Phase 4 - Positive packet flow"
# shellcheck disable=SC2016
positive_output="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- \
  sh -c 'wget -qO- --timeout='"$CONNECT_TIMEOUT"' --tries=1 "$TARGET_URL"' 2>/dev/null || true)"
printf "%s" "$positive_output" | grep -Fq "issue485-ok" && \
  ok "WRC source reached backend through inferred internal dependency" || {
    fail "WRC source could not reach backend (output: ${positive_output})"
    exit 1
  }

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

# shellcheck disable=SC2016
repaired_output="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- \
  sh -c 'wget -qO- --timeout='"$CONNECT_TIMEOUT"' --tries=1 "$TARGET_URL"' 2>/dev/null || true)"
printf "%s" "$repaired_output" | grep -Fq "issue485-ok" && \
  ok "Internal dependency traffic recovered after live policy repair" || {
    fail "Internal dependency traffic did not recover after policy repair"
    exit 1
  }

egress_rv="$(wrc_np_resource_version "$egress_ns" "$egress_name")"
ingress_rv="$(wrc_np_resource_version "$ingress_ns" "$ingress_name")"
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" 120
sleep "$STABILITY_SECONDS"
[ "$(wrc_np_resource_version "$egress_ns" "$egress_name")" = "$egress_rv" ] || {
  fail "${egress_ref} churned after convergence"
  exit 1
}
[ "$(wrc_np_resource_version "$ingress_ns" "$ingress_name")" = "$ingress_rv" ] || {
  fail "${ingress_ref} churned after convergence"
  exit 1
}
ok "Both internal-dependency policies stayed resourceVersion-stable"

header "Phase 6 - Negative packet flow"
kctl delete pod "$DENIED_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${DENIED_POD}
  namespace: ${SANDBOX_NS}
  labels:
    run: ${DENIED_POD}
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
wait_for_pod "$SANDBOX_NS" "run=${DENIED_POD}" 60 && ok "Unlabeled negative pod ready" || {
  fail "Unlabeled negative pod not ready"
  exit 1
}
if kctl exec "$DENIED_POD" -n "$SANDBOX_NS" -- wget -qO- \
  --timeout="$CONNECT_TIMEOUT" --tries=1 \
  "http://${BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local:${BACKEND_PORT}/" >/dev/null 2>&1; then
  fail "Unlabeled pod reached backend; policy is too broad or NetworkPolicy is not enforced"
  exit 1
fi
ok "Unlabeled pod cannot reach backend"

header "Phase 7 - Cleanup"
cleanup
CREATED=0
kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" >/dev/null 2>&1 \
  && fail "WorkflowRecipe still exists after cleanup" || ok "WorkflowRecipe removed"
policy_refs "clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME}" \
  | grep -q . && fail "wr-intdep policies still exist after cleanup" || ok "wr-intdep policies removed"

print_results
