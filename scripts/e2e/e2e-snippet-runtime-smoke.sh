#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_NAME="e2e-layer3a-snippet-smoke"
ARTIFACT_NAME="snippet-smoke-result.json"
RENDERED_RECIPE=""
E2E_CREATED_RECIPE=0

cleanup_tmp() {
  if [ -n "$RENDERED_RECIPE" ]; then
    rm -f "$RENDERED_RECIPE"
  fi
}

cleanup_snippet_smoke() {
  local cleanup_status=0 exists_status=0

  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || cleanup_status=1

  if any_sandbox_resource_exists pod "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-snippet-runner" "${RECIPE_NAME}-artifact-reader"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete pod "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-snippet-runner" "${RECIPE_NAME}-artifact-reader" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
    wait_for_named_resources_deleted "$SANDBOX_NS" pod "$TIMEOUT_DELETE" "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-snippet-runner" "${RECIPE_NAME}-artifact-reader" || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists service "wf-${RECIPE_NAME}-snippet-runner" "wf-${RECIPE_NAME}-artifact-reader"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete service "wf-${RECIPE_NAME}-snippet-runner" "wf-${RECIPE_NAME}-artifact-reader" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists secret "wf-${RECIPE_NAME}-coordinator-token"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete secret "wf-${RECIPE_NAME}-coordinator-token" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists configmap "${RECIPE_NAME}-workflow-config"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete configmap "${RECIPE_NAME}-workflow-config" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  if any_sandbox_resource_exists networkpolicy \
    "${RECIPE_NAME}-coord-to-wrc" \
    "${RECIPE_NAME}-wrc-to-artifact-reader" \
    "${RECIPE_NAME}-coord-to-snippet-runner" \
    "${RECIPE_NAME}-coord-to-snippet-runner-ingress" \
    "${RECIPE_NAME}-snippet-runner-egress"; then
    exists_status=0
  else
    exists_status=$?
  fi
  if [ "$exists_status" -eq 0 ]; then
    kctl delete networkpolicy \
      "${RECIPE_NAME}-coord-to-wrc" \
      "${RECIPE_NAME}-wrc-to-artifact-reader" \
      "${RECIPE_NAME}-coord-to-snippet-runner" \
      "${RECIPE_NAME}-coord-to-snippet-runner-ingress" \
      "${RECIPE_NAME}-snippet-runner-egress" \
      -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  elif [ "$exists_status" -eq 2 ]; then
    cleanup_status=1
  fi

  return "$cleanup_status"
}

cleanup_on_exit() {
  local status=$?
  cleanup_tmp
  if [ "${E2E_KEEP_RESOURCES:-0}" = "1" ]; then
    exit "$status"
  fi
  if [ "$E2E_CREATED_RECIPE" != "1" ]; then
    exit "$status"
  fi
  if ! cleanup_snippet_smoke && [ "$status" -eq 0 ]; then
    fail "snippet runtime smoke cleanup left E2E resources behind"
    exit 1
  fi
  exit "$status"
}

if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_snippet_smoke
  exit $?
fi

trap cleanup_on_exit EXIT

wait_for_phase() {
  local expected=$1 timeout=${2:-180} elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
    [ "$phase" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "last phase: ${phase:-<empty>}"
  return 1
}

assert_smoke_status_contract() {
  local status_json
  status_json=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)
  if STATUS_JSON="$status_json" ARTIFACT_NAME="$ARTIFACT_NAME" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["STATUS_JSON"])
artifact_name = os.environ["ARTIFACT_NAME"]
steps = {step.get("id"): step for step in doc.get("status", {}).get("steps", [])}
step = steps.get("write-artifact")
if not step:
    raise SystemExit("missing write-artifact step status")
if step.get("phase") != "completed":
    raise SystemExit(f"step phase mismatch: {step.get('phase')}")
if step.get("executor") != "snippet":
    raise SystemExit(f"step executor mismatch: {step.get('executor')}")
if "snippet-smoke" not in step.get("output", ""):
    raise SystemExit(f"step output missing smoke marker: {step.get('output')}")
artifacts = {item.get("name"): item for item in doc.get("status", {}).get("artifacts", [])}
artifact = artifacts.get(artifact_name)
if not artifact:
    raise SystemExit(f"missing status artifact: {artifact_name}")
if artifact.get("path") != f"/output/{artifact_name}":
    raise SystemExit(f"artifact path mismatch: {artifact}")
PY
  then
    ok "snippet runtime smoke status records snippet executor and artifact metadata"
  else
    fail "snippet runtime smoke status contract mismatch"
    kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

kctl cluster-info >/dev/null
kctl get ns "$SANDBOX_NS" >/dev/null
kctl get crd workflowrecipes.clerum.io >/dev/null
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "snippet runtime smoke prerequisites available"

if ! cleanup_snippet_smoke; then
  fail "snippet runtime smoke pre-run cleanup left E2E resources behind"
  exit 1
fi

RENDERED_RECIPE=$(mktemp "${TMPDIR:-/tmp}/snippet-smoke.XXXXXX.yaml")
cat > "$RENDERED_RECIPE" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NS}
spec:
  triggers:
    onDemand: {}
  description: Minimal deploy smoke for the Layer 3A TypeScript snippet runner.
  inputs:
    scenario: snippet-smoke
  output:
    destination: pvc
    format: json
  steps:
    - id: write-artifact
      run:
        type: snippet
        language: typescript
        code: |
          const artifact = await sdk.artifacts.writeJson("${ARTIFACT_NAME}", {
            scenario: sdk.inputs.scenario,
            layer: "3a",
            executor: "snippet"
          })
          return { scenario: sdk.inputs.scenario, layer: "3a", artifact }
YAML

kctl apply -f "$RENDERED_RECIPE"
E2E_CREATED_RECIPE=1
ok "snippet runtime smoke WorkflowRecipe applied"

if wait_for_phase completed 180; then
  ok "snippet runtime smoke workflow completed"
else
  fail "snippet runtime smoke workflow did not complete"
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  kctl logs "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  kctl logs "${RECIPE_NAME}-snippet-runner" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  exit 1
fi

if kctl get pod "${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" >/dev/null 2>&1; then
  fail "snippet-only smoke unexpectedly created mcp-host pod"
  exit 1
else
  ok "snippet-only smoke skipped mcp-host pod"
fi

kctl get pod "${RECIPE_NAME}-snippet-runner" -n "$SANDBOX_NS" >/dev/null
kctl get svc "wf-${RECIPE_NAME}-snippet-runner" -n "$SANDBOX_NS" >/dev/null
ok "snippet runtime smoke created runner pod and service"

kctl get pod "${RECIPE_NAME}-artifact-reader" -n "$SANDBOX_NS" >/dev/null
kctl get svc "wf-${RECIPE_NAME}-artifact-reader" -n "$SANDBOX_NS" >/dev/null
ok "snippet runtime smoke created artifact-reader for run artifacts"

assert_smoke_status_contract
