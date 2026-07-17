#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
CONTROL_PORT="${CONTROL_API_PORT:-8090}"
CONTROL_URL="${E2E_CONTROL_API_URL:-http://127.0.0.1:${CONTROL_PORT}}"
E2E_ADMIN_AUTH="${E2E_CONTROL_API_ADMIN_TOKEN:-}"
ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-${ADMIN_USERNAME:-admin}}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/custom-coordinator-sdk.sh
source "${SCRIPT_DIR}/_lib/custom-coordinator-sdk.sh"

RECIPE_NAME="e2e-custom-coordinator-sdk"
RECIPE_FILE="${PROJECT_DIR}/tests/e2e/fixtures/custom-coordinator-sdk.yaml"
INSPECTOR_POD="${RECIPE_NAME}-artifact-inspector"
NETWORK_PROBE_POD="${RECIPE_NAME}-network-probe"
CUSTOM_OUTPUT_OWNER_NAME="${RECIPE_NAME}"
CUSTOM_OUTPUT_PVC="${RECIPE_NAME}-workflow-output"

PURE_RECIPE_NAME="e2e-custom-coordinator-sdk"
PURE_RECIPE_FILE="${PROJECT_DIR}/tests/e2e/fixtures/custom-coordinator-sdk.yaml"
BROKER_RECIPE_NAME="e2e-custom-coordinator-sdk-broker"
BROKER_RECIPE_FILE="${PROJECT_DIR}/tests/e2e/fixtures/custom-coordinator-sdk-broker-backed.yaml"
BROKER_TIMEOUT_RECIPE_NAME="e2e-custom-coordinator-sdk-broker-timeout"
BROKER_TIMEOUT_RECIPE_FILE="${PROJECT_DIR}/tests/e2e/fixtures/custom-coordinator-sdk-broker-backed-timeout.yaml"

if [ "${1:-}" = "--cleanup-only" ]; then
  for fixture in \
    "${PURE_RECIPE_NAME}|${PURE_RECIPE_FILE}" \
    "${BROKER_RECIPE_NAME}|${BROKER_RECIPE_FILE}" \
    "${BROKER_TIMEOUT_RECIPE_NAME}|${BROKER_TIMEOUT_RECIPE_FILE}"; do
    IFS='|' read -r RECIPE_NAME RECIPE_FILE <<< "$fixture"
    INSPECTOR_POD="${RECIPE_NAME}-artifact-inspector"
    NETWORK_PROBE_POD="${RECIPE_NAME}-network-probe"
    CUSTOM_OUTPUT_PVC="${RECIPE_NAME}-workflow-output"
    custom_coordinator_cleanup
  done
  exit 0
fi

select_custom_coordinator_fixture() {
  RECIPE_NAME=$1
  RECIPE_FILE=$2
  CUSTOM_OUTPUT_OWNER_NAME="${3:-$RECIPE_NAME}"
  INSPECTOR_POD="${RECIPE_NAME}-artifact-inspector"
  NETWORK_PROBE_POD="${RECIPE_NAME}-network-probe"
  CUSTOM_OUTPUT_PVC="${CUSTOM_OUTPUT_OWNER_NAME}-workflow-output"
}

custom_coordinator_cleanup_all_fixtures() {
  for fixture in \
    "${PURE_RECIPE_NAME}|${PURE_RECIPE_FILE}" \
    "${BROKER_RECIPE_NAME}|${BROKER_RECIPE_FILE}" \
    "${BROKER_TIMEOUT_RECIPE_NAME}|${BROKER_TIMEOUT_RECIPE_FILE}"; do
    IFS='|' read -r fixture_name fixture_file <<< "$fixture"
    select_custom_coordinator_fixture "$fixture_name" "$fixture_file"
    custom_coordinator_cleanup || true
  done
  custom_coordinator_restore_wrc_env || true
}

custom_coordinator_assert_broker_env_contract() {
  local pod_name=$1
  local env_names
  env_names=$(kctl get pod "$pod_name" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null || true)
  for required in CLERUM_MCPHOST_URL MCP_HOST_ENDPOINT MCP_HOST_TOKEN_FILE; do
    if ! printf "%s\n" "$env_names" | tr ' ' '\n' | grep -Fxq "$required"; then
      fail "${pod_name} missing broker env var ${required}"
      exit 1
    fi
  done
  custom_coordinator_assert_no_env_vars "$pod_name" \
    MCP_HOST_RUNTIME_ACCESS_TOKEN \
    MCP_HOST_RUNTIME_REFRESH_TOKEN \
    MCP_HOST_WORKFLOW_CONTROL_TOKEN \
    MCP_HOST_TOKEN
  ok "broker-backed custom coordinator receives only file-backed mcp-host access"
}

custom_coordinator_curl_config_quote() {
  local value=$1
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

custom_coordinator_http_json() {
  local method=$1 url=$2 body=${3:-}
  shift 3 2>/dev/null || shift $#

  local cfg="" body_file="" raw rc
  custom_coordinator_http_json_cleanup() {
    rm -f "$cfg" "$body_file"
  }
  trap custom_coordinator_http_json_cleanup RETURN

  cfg=$(mktemp "${TMPDIR:-/tmp}/clerum-custom-coordinator-e2e-curl.XXXXXX")
  chmod 600 "$cfg"
  if [ -n "$body" ]; then
    body_file=$(mktemp "${TMPDIR:-/tmp}/clerum-custom-coordinator-e2e-body.XXXXXX")
    chmod 600 "$body_file"
    printf '%s' "$body" >"$body_file"
  fi

  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'write-out = "\\n%%{http_code}"\n'
    printf 'max-time = 30\n'
    printf 'request = "%s"\n' "$(custom_coordinator_curl_config_quote "$method")"
    printf 'url = "%s"\n' "$(custom_coordinator_curl_config_quote "$url")"
    printf 'header = "Content-Type: application/json"\n'
    for hdr in "$@"; do
      printf 'header = "%s"\n' "$(custom_coordinator_curl_config_quote "$hdr")"
    done
    [ -n "$body_file" ] && printf 'data-binary = "@%s"\n' "$(custom_coordinator_curl_config_quote "$body_file")"
  } >"$cfg"

  set +e
  raw=$(curl --config "$cfg" 2>/dev/null)
  rc=$?
  set -e
  custom_coordinator_http_json_cleanup
  trap - RETURN
  if [ "$rc" -ne 0 ]; then
    HTTP_STATUS="000"
    HTTP_BODY='{"error":"curl failed"}'
    return 1
  fi
  HTTP_STATUS=$(printf '%s' "$raw" | tail -n1)
  HTTP_BODY=$(printf '%s' "$raw" | sed '$d')
}

custom_coordinator_json_get() {
  local json=$1 path=$2
  JSON_INPUT="$json" JSON_PATH="$path" python3 - <<'PY'
import json
import os

value = json.loads(os.environ["JSON_INPUT"])
for key in os.environ["JSON_PATH"].split("."):
    if not key:
        continue
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(key)
if value is None:
    value = ""
print(value)
PY
}

custom_coordinator_require_admin_auth() {
  if [ -z "$E2E_ADMIN_AUTH" ]; then
    local body
    body=$(ADMIN_USERNAME="$ADMIN_USERNAME" ADMIN_PASSWORD="$ADMIN_PASSWORD" node --no-warnings -e '
const body = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
    }
process.stdout.write(JSON.stringify(body))
')
    if ! custom_coordinator_http_json POST "${CONTROL_URL}/api/v1/admin/auth/login" "$body"; then
      fail "admin login request failed for custom coordinator on-demand workflow (HTTP ${HTTP_STATUS}): ${HTTP_BODY}" >&2
      exit 1
    fi
    if [ "$HTTP_STATUS" != "200" ]; then
      fail "admin login failed for custom coordinator on-demand workflow (HTTP ${HTTP_STATUS})" >&2
      exit 1
    fi
    E2E_ADMIN_AUTH=$(custom_coordinator_json_get "$HTTP_BODY" token)
    if [ -z "$E2E_ADMIN_AUTH" ]; then
      fail "admin login response missing token for custom coordinator on-demand workflow" >&2
      exit 1
    fi
    log "admin JWT obtained for custom coordinator on-demand workflow" >&2
  fi
  printf '%s' "$E2E_ADMIN_AUTH"
}

custom_coordinator_trigger_as_admin() {
  local name=$1 auth=$2 body idempotency_key run_id
  body=$(RECIPE_NAME="$name" node --no-warnings -e '
const body = {
  inputs: {
    requestId: `${process.env.RECIPE_NAME}-e2e`,
  },
}
process.stdout.write(JSON.stringify(body))
')
  idempotency_key="custom-coordinator-${name}-$(date +%s)-${RANDOM}"
  if ! custom_coordinator_http_json POST "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_NS}/${name}/trigger" \
    "$body" \
    "Authorization: Bearer ${auth}" \
    "Idempotency-Key: ${idempotency_key}"; then
    fail "admin trigger request failed for ${name} (HTTP ${HTTP_STATUS}): ${HTTP_BODY}" >&2
    exit 1
  fi
  if [ "$HTTP_STATUS" != "201" ] && [ "$HTTP_STATUS" != "200" ]; then
    fail "admin trigger failed for ${name} (HTTP ${HTTP_STATUS}): ${HTTP_BODY}" >&2
    exit 1
  fi
  run_id=$(custom_coordinator_json_get "$HTTP_BODY" id)
  if [ -z "$run_id" ]; then
    fail "admin trigger response missing run id for ${name}: ${HTTP_BODY}" >&2
    exit 1
  fi
  printf '%s' "$run_id"
}

custom_coordinator_wait_for_child_by_run_id() {
  local run_id=$1 timeout=${2:-180} elapsed=0 child=""
  while [ "$elapsed" -lt "$timeout" ]; do
    child=$(kctl get workflowrecipe -n "$RECIPE_NS" \
      -l "clerum.io/workflow-run-id=${run_id}" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ -n "$child" ]; then
      printf '%s' "$child"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

custom_coordinator_wait_for_transport_workload_ready() {
  local recipe_name=$1 workload_id=$2 timeout=${3:-240}
  local mcp_server_ns="${MCP_SERVER_NS:-mcp-server}"
  local label="clerum.io/recipe=${recipe_name},clerum.io/workload=${workload_id}"
  local elapsed=0 pod_ready="" svc_name="" endpoint_ip=""

  while [ "$elapsed" -lt "$timeout" ]; do
    pod_ready=$(kctl get pods -n "$mcp_server_ns" -l "$label" \
      -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    svc_name=$(kctl get svc -n "$mcp_server_ns" -l "$label" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ "$pod_ready" = "True" ] && [ -n "$svc_name" ]; then
      endpoint_ip=$(kctl get endpoints "$svc_name" -n "$mcp_server_ns" \
        -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)
      if [ -n "$endpoint_ip" ]; then
        ok "${recipe_name}/${workload_id} transport workload has a ready service endpoint"
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "${recipe_name}/${workload_id} transport workload did not become trigger-ready"
  kctl get pods,svc,endpoints -n "$mcp_server_ns" -l "$label" 2>/dev/null || true
  exit 1
}

custom_coordinator_assert_broker_mcp_host() {
  if kctl wait --for=condition=Ready "pod/${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" --timeout=180s >/dev/null; then
    ok "broker-backed custom coordinator created ready recipe-local mcp-host"
  else
    fail "broker-backed custom coordinator did not create ready recipe-local mcp-host"
    kctl get pods -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" 2>/dev/null || true
    exit 1
  fi
  if kctl get secret "wf-${RECIPE_NAME}-mcp-host-runtime-tokens" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    ok "broker-backed custom coordinator mints scoped mcp-host runtime token Secret"
  else
    fail "broker-backed custom coordinator missing scoped mcp-host runtime token Secret"
    exit 1
  fi
}

custom_coordinator_assert_broker_tokens() {
  local secret_json
  secret_json=$(kctl get secret "wf-${RECIPE_NAME}-coordinator-token" -n "$SANDBOX_NS" -o json)
  if SECRET_JSON="$secret_json" python3 - <<'PY'
import base64
import json
import os

doc = json.loads(os.environ["SECRET_JSON"])
data = doc.get("data", {})
for key in ("mcp-host-token", "wrc-token"):
    if key not in data:
        raise SystemExit(f"{key} missing")
token = base64.b64decode(data["wrc-token"]).decode()
payload = token.split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload.encode()))
scopes = set(claims.get("scopes", []))
expected = {"model_injection_request", "status_write", "status_read", "signal_read", "health_read"}
if scopes != expected:
    raise SystemExit(f"scope mismatch: {sorted(scopes)!r}")
if claims.get("sub") != "custom-coordinator":
    raise SystemExit(f"subject mismatch: {claims.get('sub')!r}")
PY
  then
    ok "broker-backed custom coordinator receives file-backed mcp-host token plus reduced WRC token"
  else
    fail "broker-backed custom coordinator token Secret did not match policy"
    exit 1
  fi
}

custom_coordinator_assert_broker_status_contract() {
  local status_json
  status_json=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)
  if STATUS_JSON="$status_json" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["STATUS_JSON"])
status = doc.get("status", {})
steps = {step.get("id"): step for step in status.get("steps", [])}
for step_id in ("prepare", "broker-review", "emit"):
    step = steps.get(step_id)
    if not step or step.get("phase") != "completed" or step.get("executor") != "custom":
        raise SystemExit(f"step mismatch for {step_id}: {step!r}")
broker = steps["broker-review"].get("output", {})
if isinstance(broker, str):
    broker = json.loads(broker)
if broker.get("brokerBacked") is not True or broker.get("mcpDataUsed") is not True:
    raise SystemExit(f"broker output missing MCP proof: {broker!r}")
tools = broker.get("tools") or []
if not any(item.get("serverName") == "mock-tools" and item.get("toolName") == "record" for item in tools):
    raise SystemExit(f"mock-tools record call missing: {tools!r}")
artifact_names = {item.get("name") for item in status.get("artifacts", [])}
if {"custom-sdk-result.json", "custom-risk-summary.md"} - artifact_names:
    raise SystemExit(f"broker artifacts missing: {artifact_names!r}")
PY
  then
    ok "broker-backed custom coordinator status proves mcp-host tool use and artifacts"
  else
    fail "broker-backed custom coordinator status contract mismatch"
    kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

custom_coordinator_assert_broker_timeout_status() {
  local timeout=${1:-180} elapsed=0 status_json="" last_reason=""

  while [ "$elapsed" -lt "$timeout" ]; do
    status_json=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)
    if last_reason=$(STATUS_JSON="$status_json" python3 - <<'PY' 2>&1
import json
import os
import re

doc = json.loads(os.environ["STATUS_JSON"])
status = doc.get("status", {})
execution = status.get("workflowExecution", {})
if execution.get("phase") != "failed":
    raise SystemExit(f"workflow did not fail: {execution!r}")
haystack = json.dumps(status)
if not re.search(r"timeout|timed out|aborted|step-timeout", haystack, re.I):
    raise SystemExit(f"timeout proof missing: {haystack}")
PY
    ); then
      ok "broker-backed custom coordinator timeout status proves bounded MCP failure"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "broker-backed custom coordinator timeout status mismatch: ${last_reason:-timeout waiting for final failed status}"
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
}

trap custom_coordinator_cleanup_all_fixtures EXIT

select_custom_coordinator_fixture "$PURE_RECIPE_NAME" "$PURE_RECIPE_FILE"
custom_coordinator_assert_prerequisites
custom_coordinator_capture_wrc_env
custom_coordinator_cleanup_all_fixtures
select_custom_coordinator_fixture "$PURE_RECIPE_NAME" "$PURE_RECIPE_FILE"
custom_coordinator_assert_disabled_policy_blocks_pod
custom_coordinator_enable_wrc_policy
custom_coordinator_assert_disallowed_image_blocks_pod

kctl apply -f "$RECIPE_FILE" >/dev/null
custom_coordinator_wait_completed 300

coord_pod="${RECIPE_NAME}-coordinator"
custom_coordinator_assert_pod_image "$coord_pod"
custom_coordinator_assert_pod_labels "$coord_pod"
custom_coordinator_assert_no_mcp_host
custom_coordinator_assert_no_mcp_runtime_secret
custom_coordinator_assert_no_broker_env "$coord_pod"
custom_coordinator_assert_pod_hardening "$coord_pod"
custom_coordinator_assert_network_boundaries
custom_coordinator_assert_pvc_storage
custom_coordinator_assert_reduced_token
custom_coordinator_assert_config_map_contract
custom_coordinator_assert_status_contract
custom_coordinator_assert_artifact_written

select_custom_coordinator_fixture "$BROKER_RECIPE_NAME" "$BROKER_RECIPE_FILE"
custom_coordinator_cleanup
kctl apply -f "$RECIPE_FILE" >/dev/null
custom_coordinator_wait_for_transport_workload_ready "$RECIPE_NAME" mock-tools 240
BROKER_ADMIN_TOKEN=$(custom_coordinator_require_admin_auth)
BROKER_RUN_ID=$(custom_coordinator_trigger_as_admin "$RECIPE_NAME" "$BROKER_ADMIN_TOKEN")
ok "broker-backed custom coordinator triggered through admin onDemand run ${BROKER_RUN_ID:0:8}"
if BROKER_CHILD_NAME=$(custom_coordinator_wait_for_child_by_run_id "$BROKER_RUN_ID" 180); then
  ok "broker-backed custom coordinator child WorkflowRecipe '${BROKER_CHILD_NAME}' created for run ${BROKER_RUN_ID:0:8}"
else
  fail "broker-backed custom coordinator child WorkflowRecipe was not created for run ${BROKER_RUN_ID}"
  exit 1
fi
select_custom_coordinator_fixture "$BROKER_CHILD_NAME" "$BROKER_RECIPE_FILE" "$BROKER_RECIPE_NAME"
custom_coordinator_wait_completed 360
coord_pod="${RECIPE_NAME}-coordinator"
custom_coordinator_assert_pod_image "$coord_pod"
custom_coordinator_assert_pod_labels "$coord_pod"
custom_coordinator_assert_broker_env_contract "$coord_pod"
custom_coordinator_assert_pod_hardening "$coord_pod"
custom_coordinator_assert_broker_mcp_host
custom_coordinator_assert_broker_tokens
custom_coordinator_assert_broker_status_contract

select_custom_coordinator_fixture "$BROKER_TIMEOUT_RECIPE_NAME" "$BROKER_TIMEOUT_RECIPE_FILE"
custom_coordinator_cleanup
timeout_started_at=$(date +%s)
kctl apply -f "$RECIPE_FILE" >/dev/null
custom_coordinator_wait_for_transport_workload_ready "$RECIPE_NAME" mock-tools 240
BROKER_TIMEOUT_ADMIN_TOKEN=$(custom_coordinator_require_admin_auth)
BROKER_TIMEOUT_RUN_ID=$(custom_coordinator_trigger_as_admin "$RECIPE_NAME" "$BROKER_TIMEOUT_ADMIN_TOKEN")
ok "broker-backed timeout custom coordinator triggered through admin onDemand run ${BROKER_TIMEOUT_RUN_ID:0:8}"
if BROKER_TIMEOUT_CHILD_NAME=$(custom_coordinator_wait_for_child_by_run_id "$BROKER_TIMEOUT_RUN_ID" 180); then
  ok "broker-backed timeout child WorkflowRecipe '${BROKER_TIMEOUT_CHILD_NAME}' created for run ${BROKER_TIMEOUT_RUN_ID:0:8}"
else
  fail "broker-backed timeout child WorkflowRecipe was not created for run ${BROKER_TIMEOUT_RUN_ID}"
  exit 1
fi
select_custom_coordinator_fixture "$BROKER_TIMEOUT_CHILD_NAME" "$BROKER_TIMEOUT_RECIPE_FILE" "$BROKER_TIMEOUT_RECIPE_NAME"
if custom_coordinator_wait_for_phase failed 180; then
  timeout_elapsed=$(( $(date +%s) - timeout_started_at ))
  ok "broker-backed custom coordinator timeout failed boundedly in ${timeout_elapsed}s"
else
  fail "broker-backed custom coordinator timeout did not fail boundedly"
  kctl logs "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi
coord_pod="${RECIPE_NAME}-coordinator"
custom_coordinator_assert_pod_image "$coord_pod"
custom_coordinator_assert_pod_labels "$coord_pod"
custom_coordinator_assert_broker_env_contract "$coord_pod"
custom_coordinator_assert_broker_mcp_host
custom_coordinator_assert_broker_timeout_status

print_results
