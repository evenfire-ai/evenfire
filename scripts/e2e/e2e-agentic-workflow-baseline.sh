#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_NAME="e2e-agentic-workflow-baseline"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-5.1}}"
E2E_CREATED_RECIPE=0

cleanup_agentic_workflow() {
  local cleanup_status=0 exists_status=0

  # Keep destructive cleanup scoped to exact fixture-owned names in the shared dev cluster.
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || cleanup_status=1

  if any_sandbox_resource_exists pod "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-mcp-host"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete pod "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
    wait_for_named_resources_deleted "$SANDBOX_NS" pod "$TIMEOUT_DELETE" "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-mcp-host" || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists secret "wf-${RECIPE_NAME}-coordinator-token" "wf-${RECIPE_NAME}-mcp-host-runtime-tokens"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete secret "wf-${RECIPE_NAME}-coordinator-token" "wf-${RECIPE_NAME}-mcp-host-runtime-tokens" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists configmap "${RECIPE_NAME}-workflow-config" "wf-${RECIPE_NAME}-soul-md"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete configmap "${RECIPE_NAME}-workflow-config" "wf-${RECIPE_NAME}-soul-md" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  return "$cleanup_status"
}

cleanup_on_exit() {
  local status=$?
  if [ "${E2E_KEEP_RESOURCES:-0}" = "1" ]; then
    exit "$status"
  fi
  if [ "$E2E_CREATED_RECIPE" != "1" ]; then
    exit "$status"
  fi
  if ! cleanup_agentic_workflow && [ "$status" -eq 0 ]; then
    fail "agentic workflow cleanup left E2E resources behind"
    exit 1
  fi
  exit "$status"
}

if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_agentic_workflow
  exit $?
fi

trap cleanup_on_exit EXIT

wait_for_phase() {
  local expected=$1 timeout=${2:-240} elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
    [ "$phase" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "last phase: ${phase:-<empty>}"
  return 1
}

wait_for_named_pod_ready() {
  local pod_name=$1 timeout=${2:-180} elapsed=0 ready=""
  while [ "$elapsed" -lt "$timeout" ]; do
    ready=$(kctl get pod "$pod_name" -n "$SANDBOX_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    [ "$ready" = "True" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  kctl get pod "$pod_name" -n "$SANDBOX_NS" 2>/dev/null || true
  return 1
}

kctl cluster-info >/dev/null
kctl get ns "$SANDBOX_NS" >/dev/null
kctl get ns "$MCP_HOST_NS" >/dev/null
kctl get crd workflowrecipes.clerum.io >/dev/null
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "runtime prerequisites available"

if ! cleanup_agentic_workflow; then
  fail "agentic workflow pre-run cleanup left E2E resources behind"
  exit 1
fi

kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-agentic-workflow-baseline
  namespace: sandbox-recipes
  labels:
    clerum.io/workflow-run-id: 00000000-0000-4000-8000-0000000000a1
    clerum.io/workflow-actor-type: admin
    clerum.io/workflow-actor-id: e2e-agentic-runtime-baseline
spec:
  triggers:
    onDemand: {}
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  steps:
    - id: ping
      instruction: "Return a concise response for the runtime smoke check."
      toolChoice: none
YAML
E2E_CREATED_RECIPE=1

if wait_for_named_pod_ready "${RECIPE_NAME}-coordinator" 180; then
  ok "agentic workflow created ready coordinator pod"
else
  fail "agentic workflow did not create ready coordinator pod"
  exit 1
fi

if wait_for_named_pod_ready "${RECIPE_NAME}-mcp-host" 180; then
  ok "agentic workflow created ready mcp-host broker pod"
else
  fail "agentic workflow did not create ready mcp-host broker pod"
  exit 1
fi

kctl get secret "wf-${RECIPE_NAME}-mcp-host-runtime-tokens" -n "$SANDBOX_NS" >/dev/null
ok "runtime token Secret exists"

if kctl get pod "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null | grep -q MCP_HOST_RUNTIME_ACCESS_TOKEN; then
  fail "coordinator received Host JWT runtime token"
  exit 1
else
  ok "coordinator does not receive Host JWT runtime token"
fi

if kctl get pod "${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null | grep -q MCP_HOST_RUNTIME_ACCESS_TOKEN; then
  ok "mcp-host broker receives Host JWT runtime token"
else
  fail "mcp-host broker did not receive Host JWT runtime token"
  exit 1
fi

if wait_for_phase completed 240; then
  ok "agentic workflow completed"
else
  fail "agentic workflow did not complete"
  kctl logs "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" --tail=80 2>/dev/null || true
  exit 1
fi

status_json=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)
if STATUS_JSON="$status_json" python3 - <<'PY'
import json, os
doc = json.loads(os.environ["STATUS_JSON"])
status = doc.get("status", {})
steps = status.get("steps", [])
if status.get("workflowExecution", {}).get("phase") != "completed":
    raise SystemExit(1)
if status.get("workflowExecution", {}).get("message") != "Workflow completed":
    raise SystemExit(1)
if len(steps) != 1:
    raise SystemExit(1)
step = steps[0]
if step.get("id") != "ping" or step.get("phase") != "completed":
    raise SystemExit(1)
if step.get("executor") != "agentic":
    raise SystemExit(1)
if not str(step.get("output", "")).strip():
    raise SystemExit(1)
if not str(step.get("modelUsed", "")).strip():
    raise SystemExit(1)
tools_called = step.get("toolsCalled", [])
if not isinstance(tools_called, list) or tools_called:
    raise SystemExit(1)
PY
then
  ok "WorkflowRecipe status has completed agentic step with runtime output and no tool calls"
else
  fail "WorkflowRecipe status did not match agentic baseline contract"
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

print_results
