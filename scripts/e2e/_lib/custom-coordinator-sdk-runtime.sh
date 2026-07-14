#!/usr/bin/env bash
# Runtime helpers for scripts/e2e/e2e-custom-coordinator-sdk.sh.

CUSTOM_COORDINATOR_WRC_POLICY_PATCHED=false
CUSTOM_COORDINATOR_KUBECTL_CONTEXT=""
CUSTOM_COORDINATOR_KUBECTL_CONTEXT_READY=false
declare -Ag CUSTOM_COORDINATOR_ORIG_ENV_PRESENT=()
declare -Ag CUSTOM_COORDINATOR_ORIG_ENV_VALUE=()

custom_coordinator_init_kubectl_context() {
  [ "$CUSTOM_COORDINATOR_KUBECTL_CONTEXT_READY" = true ] && return 0

  local context="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-${KCTX:-}}}"
  if [ -z "$context" ]; then
    context="$(command kubectl config current-context 2>/dev/null || true)"
  fi

  case "$context" in
    *prod*|*production*)
      fail "refusing custom coordinator E2E on production-like Kubernetes context: ${context:-<empty>}"
      exit 1
      ;;
  esac

  if ! is_allowed_e2e_context "$context"; then
    fail "custom coordinator E2E requires an explicitly allowed local Kubernetes context; got ${context:-<empty>} (allowed: ${E2E_ALLOWED_CONTEXTS} or generated clerum-*-<8hex> profile)"
    exit 1
  fi

  CUSTOM_COORDINATOR_KUBECTL_CONTEXT="$context"
  CUSTOM_COORDINATOR_KUBECTL_CONTEXT_READY=true
}

kubectl() {
  if [ "${CUSTOM_COORDINATOR_KUBECTL_CONTEXT_READY:-false}" = true ]; then
    command kubectl --context="$CUSTOM_COORDINATOR_KUBECTL_CONTEXT" "$@"
  else
    command kubectl "$@"
  fi
}

custom_coordinator_wait_for_recipe_phase() {
  local recipe_name=$1 expected=$2 timeout=${3:-240} elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase=$(kubectl get workflowrecipe "$recipe_name" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
    [ "$phase" = "$expected" ] && return 0
    if [ "$phase" = failed ] && [ "$expected" != failed ]; then
      echo "last phase: ${phase}"
      return 1
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "last phase: ${phase:-<empty>}"
  return 1
}

custom_coordinator_wait_for_phase() {
  custom_coordinator_wait_for_recipe_phase "$RECIPE_NAME" "$@"
}

custom_coordinator_assert_prerequisites() {
  custom_coordinator_init_kubectl_context
  kubectl cluster-info >/dev/null
  kubectl get ns "$SANDBOX_NS" >/dev/null
  kubectl get crd workflowrecipes.clerum.io >/dev/null
  kubectl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
  ok "runtime prerequisites available on Kubernetes context ${CUSTOM_COORDINATOR_KUBECTL_CONTEXT}"
}

custom_coordinator_wait_completed() {
  local timeout=${1:-300}
  if custom_coordinator_wait_for_phase completed "$timeout"; then
    ok "custom coordinator workflow completed"
  else
    fail "custom coordinator workflow did not complete"
    kubectl logs "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
    kubectl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

custom_coordinator_wrc_env_names() {
  kubectl get deploy workflow-recipes -n "$CONTROL_NS" -o json 2>/dev/null | python3 -c '
import json
import sys
doc = json.load(sys.stdin)
containers = doc.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
container = next((c for c in containers if c.get("name") == "workflow-recipes"), {})
for env in container.get("env", []):
    name = env.get("name")
    if name:
        print(name)
' || true
}

custom_coordinator_wrc_env_value() {
  local name=$1
  kubectl get deploy workflow-recipes -n "$CONTROL_NS" -o json 2>/dev/null | WRC_ENV_NAME="$name" python3 -c '
import json
import os
import sys
target = os.environ["WRC_ENV_NAME"]
doc = json.load(sys.stdin)
containers = doc.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
container = next((c for c in containers if c.get("name") == "workflow-recipes"), {})
env = next((item for item in container.get("env", []) if item.get("name") == target), {})
print(env.get("value", ""), end="")
' || true
}

custom_coordinator_capture_wrc_env() {
  local name
  for name in WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST; do
    if custom_coordinator_wrc_env_names | grep -Fxq "$name"; then
      CUSTOM_COORDINATOR_ORIG_ENV_PRESENT["$name"]=true
      CUSTOM_COORDINATOR_ORIG_ENV_VALUE["$name"]="$(custom_coordinator_wrc_env_value "$name")"
    else
      CUSTOM_COORDINATOR_ORIG_ENV_PRESENT["$name"]=false
      CUSTOM_COORDINATOR_ORIG_ENV_VALUE["$name"]=""
    fi
  done
}

custom_coordinator_restore_wrc_env() {
  [ "$CUSTOM_COORDINATOR_WRC_POLICY_PATCHED" = true ] || return 0
  local args=()
  local name
  for name in WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST; do
    if [ "${CUSTOM_COORDINATOR_ORIG_ENV_PRESENT[$name]}" = true ]; then
      args+=("${name}=${CUSTOM_COORDINATOR_ORIG_ENV_VALUE[$name]}")
    else
      args+=("${name}-")
    fi
  done
  kubectl set env deployment/workflow-recipes -n "$CONTROL_NS" "${args[@]}" >/dev/null
  kubectl rollout status deployment/workflow-recipes -n "$CONTROL_NS" --timeout=180s >/dev/null
}

custom_coordinator_set_wrc_policy() {
  local enabled=$1 prefixes=$2 require_digest=$3
  kubectl set env deployment/workflow-recipes -n "$CONTROL_NS" \
    "WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=${enabled}" \
    "WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES=${prefixes}" \
    "WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST=${require_digest}" >/dev/null
  CUSTOM_COORDINATOR_WRC_POLICY_PATCHED=true
  kubectl rollout status deployment/workflow-recipes -n "$CONTROL_NS" --timeout=180s >/dev/null
}

custom_coordinator_enable_wrc_policy() {
  custom_coordinator_set_wrc_policy true "clerum/workflow-custom-sdk-e2e:" false
  ok "WRC custom coordinator policy enabled for fixture image"
}

custom_coordinator_assert_disabled_policy_blocks_pod() {
  custom_coordinator_set_wrc_policy false "clerum/workflow-custom-sdk-e2e:" false
  kubectl apply -f "$RECIPE_FILE" >/dev/null

  if custom_coordinator_wait_for_phase failed 120; then
    local message
    message=$(kubectl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.message}' 2>/dev/null || true)
    if [[ "$message" != *"custom coordinator images are disabled"* ]]; then
      fail "disabled custom image policy failed with unexpected message: ${message:-<empty>}"
      exit 1
    fi
    if kubectl get pod "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" >/dev/null 2>&1; then
      fail "disabled custom image policy still created coordinator pod"
      exit 1
    fi
    ok "disabled custom coordinator policy rejects fixture before pod creation"
  else
    fail "disabled custom coordinator policy did not fail the fixture"
    kubectl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi

  kubectl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" >/dev/null 2>&1 || true
}

custom_coordinator_assert_disallowed_image_blocks_pod() {
  local blocked_name="${RECIPE_NAME}-disallowed"
  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${blocked_name}
  namespace: ${RECIPE_NS}
spec:
  triggers:
    onDemand: {}
  coordinatorImage: clerum/workflow-custom-sdk-e2e-evil:test
  steps:
    - id: prepare
YAML

  if custom_coordinator_wait_for_recipe_phase "$blocked_name" failed 120; then
    local message
    message=$(kubectl get workflowrecipe "$blocked_name" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.message}' 2>/dev/null || true)
    if [[ "$message" != *"not allowed"* ]]; then
      fail "disallowed custom image failed with unexpected message: ${message:-<empty>}"
      exit 1
    fi
    if kubectl get pod "${blocked_name}-coordinator" -n "$SANDBOX_NS" >/dev/null 2>&1; then
      fail "disallowed custom image still created coordinator pod"
      exit 1
    fi
    ok "custom coordinator image allowlist rejects adjacent image before pod creation"
  else
    fail "disallowed custom coordinator image did not fail"
    kubectl get workflowrecipe "$blocked_name" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi

  kubectl delete workflowrecipe "$blocked_name" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$blocked_name" "$TIMEOUT_DELETE" >/dev/null 2>&1 || true
}

custom_coordinator_cleanup() {
  custom_coordinator_init_kubectl_context
  local children child
  children=$(kubectl get workflowrecipe -n "$RECIPE_NS" \
    -l "clerum.io/parent-recipe=${RECIPE_NAME}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  for child in $children; do
    kubectl delete workflowrecipe "$child" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  kubectl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete workflowrecipe "${RECIPE_NAME}-disallowed" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" >/dev/null 2>&1 || true
  for child in $children; do
    wait_for_workflowrecipe_deleted "$RECIPE_NS" "$child" "$TIMEOUT_DELETE" >/dev/null 2>&1 || true
  done
  kubectl delete pod "$INSPECTOR_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete pod "$NETWORK_PROBE_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl delete pvc "$CUSTOM_OUTPUT_PVC" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  for ns in "$SANDBOX_NS" "$RECIPE_NS"; do
    kubectl delete pod,configmap,secret,networkpolicy,pvc -n "$ns" \
      -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found >/dev/null 2>&1 || true
    for child in $children; do
      kubectl delete pod,configmap,secret,networkpolicy,pvc -n "$ns" \
        -l "clerum.io/recipe=${child}" --ignore-not-found >/dev/null 2>&1 || true
    done
  done
}

custom_coordinator_cleanup_all() {
  custom_coordinator_cleanup || true
  custom_coordinator_restore_wrc_env || true
}
