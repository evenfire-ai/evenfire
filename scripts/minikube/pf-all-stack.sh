#!/usr/bin/env bash
# Background port-forwards required by Control UI + Desktop E2E gates.

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC=(kubectl --context="${PROFILE}")
HOLD=false
PIDS=()
PIDFILES=()
PIDFILE_SERVICES=()
SAFE_PROFILE="${PROFILE//[^A-Za-z0-9_.-]/_}"
HAS_PROFILE_OWNED_PORTS=false
STARTUP_COMPLETE=false
if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "ERROR: invalid Minikube profile identifier: $PROFILE" >&2
  exit 1
fi
set +u
PROFILE_PID_ROOT="$CLERUM_PROFILE_CACHE_ROOT"
set -u
if [[ -z "$PROFILE_PID_ROOT" ]]; then
  PROFILE_PID_ROOT="$HOME/.cache/clerum/minikube-profiles"
fi

load_branch_profile_ports_env() {
  local file="$1"
  local line
  local key
  local value

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]] && continue
    if [[ "${line}" =~ ^([A-Z_]+)=([0-9]{2,5})$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      case "${key}" in
        PORT_BASE|CONTROL_UI_PORT|PROFILE_UI_PORT|CONTROL_API_PORT|EXTERNAL_REST_API_PORT|MEMBER_REGISTRATION_SERVICE_PORT|RPC_PROXY_PORT|REGISTRY_API_PORT|WORKFLOW_APPROVAL_READER_PORT|MCP_HOST_PORT)
          printf -v "${key}" '%s' "${value}"
          ;;
        *)
          echo "ERROR: unsupported port variable in ${file}: ${key}" >&2
          exit 1
          ;;
      esac
    elif [[ "${line}" =~ ^([A-Z_]+)=http://127\.0\.0\.1:([0-9]{2,5})$ ]]; then
      key="${BASH_REMATCH[1]}"
      case "${key}" in
        CONTROL_UI_URL|CONTROL_UI_BASE_URL|PROFILE_UI_URL|PROFILE_UI_BASE_URL|CONTROL_API_URL|CONTROL_API_BASE_URL|EXTERNAL_REST_API_URL|EXTERNAL_REST_API_BASE_URL|MEMBER_REGISTRATION_SERVICE_URL|MEMBER_REGISTRATION_SERVICE_BASE_URL|RPC_PROXY_URL|RPC_PROXY_BASE_URL|REGISTRY_API_URL|REGISTRY_API_BASE_URL|WORKFLOW_APPROVAL_READER_URL|WORKFLOW_APPROVAL_READER_BASE_URL|MCP_HOST_URL|MCP_HOST_BASE_URL)
          ;;
        *)
          echo "ERROR: unsupported URL variable in ${file}: ${key}" >&2
          exit 1
          ;;
      esac
    else
      echo "ERROR: unsupported port assignment in ${file}: ${line}" >&2
      exit 1
    fi
  done < "${file}"
}

BRANCH_PROFILE_PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${PROFILE}/ports.env}"
if [[ -f "${BRANCH_PROFILE_PORTS_ENV}" ]]; then
  load_branch_profile_ports_env "${BRANCH_PROFILE_PORTS_ENV}"
  HAS_PROFILE_OWNED_PORTS=true
elif [[ "${PROFILE}" =~ ^clerum-(codex|detached)- ]]; then
  echo "ERROR: missing branch-scoped port cache for minikube profile: ${PROFILE}" >&2
  echo "Expected ${BRANCH_PROFILE_PORTS_ENV}" >&2
  exit 1
fi

is_branch_profile() {
  [[ "$PROFILE" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]
}

if [[ ! -f "${BRANCH_PROFILE_PORTS_ENV}" ]] && is_branch_profile; then
  echo "ERROR: missing branch-scoped port cache for minikube profile: ${PROFILE}" >&2
  echo "Expected ${BRANCH_PROFILE_PORTS_ENV}" >&2
  exit 1
fi

if [[ -z "${PROFILE_UI_PORT:-}" && -n "${PORT_BASE:-}" ]]; then
  PROFILE_UI_PORT=$((PORT_BASE + 1))
fi

CONTROL_UI_PORT="${CONTROL_UI_PORT:-3000}"
PROFILE_UI_PORT="${PROFILE_UI_PORT:-3001}"
CONTROL_API_PORT="${CONTROL_API_PORT:-8090}"
EXTERNAL_REST_API_PORT="${EXTERNAL_REST_API_PORT:-8091}"
RPC_PROXY_PORT="${RPC_PROXY_PORT:-8094}"
REGISTRY_API_PORT="${REGISTRY_API_PORT:-8085}"
WORKFLOW_APPROVAL_READER_PORT="${WORKFLOW_APPROVAL_READER_PORT:-8098}"
MCP_HOST_PORT="${MCP_HOST_PORT:-8080}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hold)
      HOLD=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_random_port_for_branch_profile() {
  local name="$1"
  local value="$2"
  local default_port="$3"
  if [[ "${HAS_PROFILE_OWNED_PORTS}" != "true" ]] && ! is_branch_profile; then
    return 0
  fi
  if [[ "${value}" == "${default_port}" ]]; then
    echo "ERROR: ${PROFILE} must use profile-owned random port-forwards; ${name}=${value} is the shared default." >&2
    echo "Run branch-profile-preflight or set ${name} explicitly before running this helper." >&2
    exit 1
  fi
}

require_random_port_for_branch_profile CONTROL_UI_PORT "${CONTROL_UI_PORT}" 3000
require_random_port_for_branch_profile PROFILE_UI_PORT "${PROFILE_UI_PORT}" 3001
require_random_port_for_branch_profile CONTROL_API_PORT "${CONTROL_API_PORT}" 8090
require_random_port_for_branch_profile EXTERNAL_REST_API_PORT "${EXTERNAL_REST_API_PORT}" 8091
require_random_port_for_branch_profile RPC_PROXY_PORT "${RPC_PROXY_PORT}" 8094
require_random_port_for_branch_profile REGISTRY_API_PORT "${REGISTRY_API_PORT}" 8085
require_random_port_for_branch_profile WORKFLOW_APPROVAL_READER_PORT "${WORKFLOW_APPROVAL_READER_PORT}" 8098
require_random_port_for_branch_profile MCP_HOST_PORT "${MCP_HOST_PORT}" 8080

cleanup() {
  if [[ "${HOLD}" != "true" && "${STARTUP_COMPLETE}" == "true" ]]; then
    return 0
  fi
  local index
  for index in "${!PIDFILES[@]}"; do
    kill_owned_pidfile "${PIDFILES[$index]}" "${PIDFILE_SERVICES[$index]}" || true
  done
}

kill_owned_pidfile() {
  local pidfile="$1"
  local service="$2"
  local pid command_line expected_start actual_start
  [[ -f "$pidfile" ]] || return 0
  pid="$(sed -n '1p' "$pidfile" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    rm -f -- "$pidfile"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$pidfile"
    return 0
  fi
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" != *port-forward* ||
        "$command_line" != *"svc/$service"* ||
        "$command_line" != *"$PROFILE"* ]]; then
    echo "ERROR: refusing to kill PID $pid from $pidfile; it is not the $PROFILE $service port-forward" >&2
    return 1
  fi
  expected_start="$(sed -n 's/^PROCESS_START=//p' "$pidfile" 2>/dev/null | head -1 || true)"
  if [[ -z "$expected_start" ]]; then
    echo "ERROR: refusing to kill PID $pid from $pidfile; its process-start signature is missing" >&2
    return 1
  fi
  if [[ "$expected_start" != unavailable ]]; then
    actual_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
    if [[ -z "$actual_start" || "$actual_start" != "$expected_start" ]]; then
      echo "ERROR: refusing to kill PID $pid from $pidfile; its process-start signature changed" >&2
      return 1
    fi
  fi
  kill "$pid" 2>/dev/null || true
  rm -f -- "$pidfile"
}

write_pidfile() {
  local pidfile="$1" pid="$2" process_start
  process_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  [ -n "$process_start" ] || process_start=unavailable
  printf '%s\nPROCESS_START=%s\n' "$pid" "$process_start" >"$pidfile"
}

start_pf() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local ports="$4"
  local health_url="${5:-}"
  local log="/tmp/pf-${SAFE_PROFILE}-${name}.log"
  local pidfile="/tmp/pf-${SAFE_PROFILE}-${name}.pid"
  local profile_pids_dir="$PROFILE_PID_ROOT/$SAFE_PROFILE/pids"
  local profile_pidfile="${profile_pids_dir}/${name}.pid"

  mkdir -p "$profile_pids_dir"
  kill_owned_pidfile "$pidfile" "$service"
  kill_owned_pidfile "$profile_pidfile" "$service"

  nohup "${KC[@]}" -n "${namespace}" port-forward --address=127.0.0.1 "svc/${service}" "${ports}" >"${log}" 2>&1 </dev/null &
  write_pidfile "${pidfile}" "$!"
  write_pidfile "${profile_pidfile}" "$!"
  PIDS+=("$!")
  PIDFILES+=("$pidfile" "$profile_pidfile")
  PIDFILE_SERVICES+=("$service" "$service")
  echo "  ${name}: pid=$(cat "${pidfile}") ns=${namespace} svc=${service} ports=${ports}"
  sleep 0.2
  if ! kill -0 "$!" 2>/dev/null; then
    echo "  ERROR: ${name} port-forward failed to stay running" >&2
    sed -n '1,80p' "${log}" >&2 || true
    exit 1
  fi

  if [[ -n "${health_url}" ]]; then
    for _ in $(seq 1 20); do
      if curl -sf -m 2 "${health_url}" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.5
    done
    echo "  WARN: ${name} did not become healthy yet (${health_url})"
  fi
}

start_optional_pf() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local ports="$4"
  local health_url="${5:-}"

  if ! "${KC[@]}" get namespace "${namespace}" >/dev/null 2>&1; then
    echo "  ${name}: skipped (namespace ${namespace} not present)"
    return 0
  fi
  if ! "${KC[@]}" -n "${namespace}" get svc "${service}" >/dev/null 2>&1; then
    echo "  ${name}: skipped (service ${namespace}/${service} not present)"
    return 0
  fi

  start_pf "${name}" "${namespace}" "${service}" "${ports}" "${health_url}"
}

start_optional_deployment_pf() {
  local name="$1"
  local namespace="$2"
  local deployment="$3"
  local service="$4"
  local ports="$5"
  local health_url="${6:-}"

  if ! "${KC[@]}" get namespace "${namespace}" >/dev/null 2>&1; then
    echo "  ${name}: skipped (namespace ${namespace} not present)"
    return 0
  fi
  if ! "${KC[@]}" -n "${namespace}" get deploy "${deployment}" >/dev/null 2>&1; then
    echo "  ${name}: skipped (deployment ${namespace}/${deployment} not present)"
    return 0
  fi
  local desired
  desired="$("${KC[@]}" -n "${namespace}" get deploy "${deployment}" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  if [[ -z "${desired}" || "${desired}" == "0" ]]; then
    echo "  ${name}: skipped (deployment ${namespace}/${deployment} scaled to ${desired:-0})"
    return 0
  fi

  start_optional_pf "${name}" "${namespace}" "${service}" "${ports}" "${health_url}"
}

# Install the cleanup boundary before the first background process is started.
# A later start_pf failure must not strand forwards that were already launched.
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

echo "=== Starting gate port-forwards (${PROFILE}) ==="
start_pf control-ui control-plane control-ui "${CONTROL_UI_PORT}:3000" "http://127.0.0.1:${CONTROL_UI_PORT}"
start_optional_pf profile-ui profiles profile-ui "${PROFILE_UI_PORT}:3001" "http://127.0.0.1:${PROFILE_UI_PORT}"
start_pf control-api control-plane control-api "${CONTROL_API_PORT}:8090" "http://127.0.0.1:${CONTROL_API_PORT}/health"
start_pf external-rest-api profiles external-rest-api "${EXTERNAL_REST_API_PORT}:8091" "http://127.0.0.1:${EXTERNAL_REST_API_PORT}/health"
start_pf rpc-proxy rpc-proxy rpc-proxy "${RPC_PROXY_PORT}:8094" "http://127.0.0.1:${RPC_PROXY_PORT}/health"
start_optional_pf registry-api registry registry-api "${REGISTRY_API_PORT}:8085" "http://127.0.0.1:${REGISTRY_API_PORT}/health"
start_optional_deployment_pf workflow-approval-request-reader channels clerum-workflow-approval-request-reader workflow-approval-request-reader "${WORKFLOW_APPROVAL_READER_PORT}:8098" "http://127.0.0.1:${WORKFLOW_APPROVAL_READER_PORT}/health"

if "${KC[@]}" get svc chatllm -n mcp-host >/dev/null 2>&1; then
  start_pf mcp-host mcp-host chatllm "${MCP_HOST_PORT}:8080" "http://127.0.0.1:${MCP_HOST_PORT}/v1/runtime/health"
elif "${KC[@]}" get svc mcp-host -n mcp-host >/dev/null 2>&1; then
  start_pf mcp-host mcp-host mcp-host "${MCP_HOST_PORT}:8080" "http://127.0.0.1:${MCP_HOST_PORT}/v1/runtime/health"
fi

STARTUP_COMPLETE=true
echo "=== Port-forwards refreshed ==="

if [[ "${HOLD}" == "true" ]]; then
  echo "=== Holding port-forwards open; press Ctrl-C to stop ==="
  while true; do
    sleep 3600 &
    wait "$!" || true
  done
fi
