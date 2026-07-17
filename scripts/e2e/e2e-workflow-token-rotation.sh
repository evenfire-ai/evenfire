#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_NAME="e2e-custom-token-rotation"
RECIPE_FILE="${PROJECT_DIR}/tests/e2e/fixtures/custom-coordinator-token-rotation.yaml"
OUTPUT_PVC="${RECIPE_NAME}-workflow-output"
WRC_ENV_SNAPSHOT="${TMPDIR:-/tmp}/clerum-${RECIPE_NAME}-wrc-env.tsv"
E2E_CREATED_RECIPE=0
E2E_WRC_ENV_PATCHED=0

save_wrc_env() {
  local deployment_json="${WRC_ENV_SNAPSHOT}.deployment.json"
  kctl get deployment workflow-recipes -n "$CONTROL_NS" -o json >"$deployment_json"
  python3 - "$WRC_ENV_SNAPSHOT" "$deployment_json" <<'PY'
import json
import sys

target = sys.argv[1]
source = sys.argv[2]
keys = [
    "WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE",
    "WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES",
    "WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST",
    "WRC_RUNTIME_TOKEN_TTL_SECONDS",
    "WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS",
    "WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS",
    "WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS",
]
with open(source, "r", encoding="utf-8") as fh:
    doc = json.load(fh)
env = {
    item.get("name"): item.get("value", "")
    for item in doc.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [{}])[0].get("env", [])
}
with open(target, "w", encoding="utf-8") as fh:
    for key in keys:
        if key in env:
            fh.write(f"{key}\ttrue\t{env[key]}\n")
        else:
            fh.write(f"{key}\tfalse\t\n")
PY
}

restore_wrc_env() {
  if [ "$E2E_WRC_ENV_PATCHED" != "1" ] || [ ! -f "$WRC_ENV_SNAPSHOT" ]; then
    return 0
  fi
  local args=()
  local key present value
  while IFS=$'\t' read -r key present value; do
    if [ "$present" = "true" ]; then
      args+=("${key}=${value}")
    else
      args+=("${key}-")
    fi
  done <"$WRC_ENV_SNAPSHOT"
  kctl set env deployment/workflow-recipes -n "$CONTROL_NS" "${args[@]}" >/dev/null
  kctl rollout status deployment/workflow-recipes -n "$CONTROL_NS" --timeout=180s >/dev/null
}

configure_short_runtime_tokens() {
  save_wrc_env
  # Keep this gate short, but leave enough room for kubelet Secret-volume propagation.
  kctl set env deployment/workflow-recipes -n "$CONTROL_NS" \
    WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=true \
    WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES=clerum/workflow-custom-sdk-e2e: \
    WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST=false \
    WRC_RUNTIME_TOKEN_TTL_SECONDS=120 \
    WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS=90 \
    WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS=300 \
    WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS=600 >/dev/null
  E2E_WRC_ENV_PATCHED=1
  kctl rollout status deployment/workflow-recipes -n "$CONTROL_NS" --timeout=180s >/dev/null
}

cleanup_token_rotation() {
  local cleanup_status=0
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" >/dev/null 2>&1 || cleanup_status=1
  kctl delete pod "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-artifact-reader" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_named_resources_deleted "$SANDBOX_NS" pod "$TIMEOUT_DELETE" "${RECIPE_NAME}-coordinator" "${RECIPE_NAME}-artifact-reader" >/dev/null 2>&1 || cleanup_status=1
  kctl delete secret "wf-${RECIPE_NAME}-coordinator-token" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete configmap "${RECIPE_NAME}-workflow-config" "wf-${RECIPE_NAME}-soul-md" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete pvc "$OUTPUT_PVC" -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  return "$cleanup_status"
}

cleanup_on_exit() {
  local status=$?
  if [ "${E2E_KEEP_RESOURCES:-0}" != "1" ] && [ "$E2E_CREATED_RECIPE" = "1" ]; then
    cleanup_token_rotation || status=1
  fi
  restore_wrc_env || status=1
  exit "$status"
}

if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_token_rotation
  exit $?
fi

trap cleanup_on_exit EXIT

get_wrc_secret_data() {
  local resource_name="wf-${RECIPE_NAME}-coordinator-token"
  local resource_kind="secret"
  local resource_json="${WRC_ENV_SNAPSHOT}.runtime.json"
  if ! kctl get "$resource_kind" "$resource_name" -n "$SANDBOX_NS" -o json >"$resource_json" 2>/dev/null; then
    printf "\n"
    return 0
  fi
  python3 - "$resource_json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        doc = json.load(fh)
except Exception:
    print("")
    raise SystemExit(0)
print(doc.get("data", {}).get("wrc-token", ""))
PY
}

wait_for_secret_data() {
  local timeout=${1:-120} elapsed=0 value=""
  while [ "$elapsed" -lt "$timeout" ]; do
    value="$(get_wrc_secret_data)"
    if [ -n "$value" ]; then
      printf "%s\n" "$value"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_secret_rotation() {
  local initial=$1 timeout=${2:-180} elapsed=0 value=""
  while [ "$elapsed" -lt "$timeout" ]; do
    value="$(get_wrc_secret_data)"
    if [ -n "$value" ] && [ "$value" != "$initial" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_phase() {
  local expected=$1 timeout=${2:-300} elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
    [ "$phase" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "last phase: ${phase:-<empty>}"
  return 1
}

kctl cluster-info >/dev/null
kctl get ns "$SANDBOX_NS" >/dev/null
kctl get crd workflowrecipes.clerum.io >/dev/null
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "runtime token rotation prerequisites available"

cleanup_token_rotation >/dev/null 2>&1 || true
configure_short_runtime_tokens
ok "WRC configured with short runtime token TTL for opt-in rotation gate"

kctl apply -f "$RECIPE_FILE" >/dev/null
E2E_CREATED_RECIPE=1
ok "token rotation WorkflowRecipe installed"

initial_token="$(wait_for_secret_data 120)"
if [ -n "$initial_token" ]; then
  ok "initial coordinator WRC token Secret observed"
else
  fail "initial coordinator WRC token Secret was not created"
  exit 1
fi

if wait_for_secret_rotation "$initial_token" 180; then
  ok "WRC rotated the coordinator WRC token Secret before expiry"
else
  fail "coordinator WRC token Secret did not rotate before timeout"
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

if wait_for_phase completed 420; then
  ok "workflow completed after initial runtime token expiry"
else
  fail "workflow did not complete after runtime token rotation"
  kctl logs "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

pod_json="$(kctl get pod "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" -o json)"
if POD_JSON="$pod_json" python3 - <<'PY'
import json
import os

pod = json.loads(os.environ["POD_JSON"])
container = pod["spec"]["containers"][0]
env = {item.get("name"): item for item in container.get("env", [])}
if "WRC_TOKEN" in env:
    raise SystemExit("direct WRC_TOKEN env must not be present")
if env.get("WRC_TOKEN_FILE", {}).get("value") != "/var/run/clerum/workflow-tokens/wrc-token":
    raise SystemExit("WRC_TOKEN_FILE missing")
mount = next((m for m in container.get("volumeMounts", []) if m.get("name") == "workflow-tokens"), None)
if not mount or mount.get("readOnly") is not True or "subPath" in mount:
    raise SystemExit("workflow token Secret must be mounted read-only without subPath")
PY
then
  ok "coordinator consumes WRC token through a rotatable Secret volume"
else
  fail "coordinator token-file contract mismatch"
  exit 1
fi

status_json="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)"
if STATUS_JSON="$status_json" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["STATUS_JSON"])
status = doc.get("status", {})
if status.get("workflowExecution", {}).get("phase") != "completed":
    raise SystemExit("workflow not completed")
steps = {step.get("id"): step for step in status.get("steps", [])}
probe = steps.get("wait-for-token-rotation", {})
emit = steps.get("emit", {})
if probe.get("phase") != "completed" or emit.get("phase") != "completed":
    raise SystemExit(f"step status mismatch: {steps!r}")
if not any(a.get("name") == "custom-sdk-result.json" for a in status.get("artifacts", [])):
    raise SystemExit("custom token rotation artifact missing")
PY
then
  ok "WorkflowRecipe status proves post-rotation completion and artifact metadata"
else
  fail "WorkflowRecipe status did not match token rotation contract"
  exit 1
fi

if kctl get secret "wf-${RECIPE_NAME}-coordinator-token" -n mcp-server >/dev/null 2>&1; then
  fail "runtime token Secret leaked into mcp-server namespace"
  exit 1
else
  ok "runtime token Secret remains scoped to sandbox-recipes"
fi

print_results
