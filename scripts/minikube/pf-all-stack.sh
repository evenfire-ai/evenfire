#!/usr/bin/env bash
# Background port-forwards required by Control UI + Desktop E2E gates.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORKTREE_ROOT="$(git -C "${SCRIPT_DIR}/../.." rev-parse --show-toplevel 2>/dev/null)" || {
  echo 'ERROR: unable to resolve the port-forward worktree root' >&2
  exit 1
}
WORKTREE_ROOT="$(cd -- "${WORKTREE_ROOT}" && pwd -P)"
# shellcheck source=scripts/minikube/port-forward-owner.sh
source "${SCRIPT_DIR}/port-forward-owner.sh"

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
CONTEXT="${KUBECONTEXT:-${PROFILE}}"
KC=(kubectl "--context=${CONTEXT}")
HOLD=false
PIDFILES=()
PIDFILE_NAMESPACES=()
PIDFILE_SERVICES=()
PIDFILE_LOCAL_PORTS=()
PIDFILE_REMOTE_PORTS=()
SAFE_PROFILE="${PROFILE//[^A-Za-z0-9_.-]/_}"
HAS_PROFILE_OWNED_PORTS=false
STARTUP_COMPLETE=false
PROFILE_PIDS_DIR=''
HEALTH_ATTEMPTS="${PF_HEALTH_ATTEMPTS:-20}"
HEALTH_DELAY="${PF_HEALTH_DELAY:-0.5}"
STARTUP_DELAY="${PF_STARTUP_DELAY:-0.2}"
if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "ERROR: invalid Minikube profile identifier: $PROFILE" >&2
  exit 1
fi
if [[ "${CONTEXT}" != "${PROFILE}" ]]; then
  echo "ERROR: Minikube profile/context mismatch (${PROFILE} != ${CONTEXT}); refusing a foreign port-forward" >&2
  exit 1
fi
if [[ ! "${HEALTH_ATTEMPTS}" =~ ^[1-9][0-9]*$ ||
      ! "${HEALTH_DELAY}" =~ ^[0-9]+([.][0-9]+)?$ ||
      ! "${STARTUP_DELAY}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo 'ERROR: invalid port-forward startup/health wait configuration' >&2
  exit 1
fi
PROFILE_PID_ROOT="${CLERUM_PROFILE_CACHE_ROOT:-${HOME}/.cache/clerum/minikube-profiles}"
[[ "${PROFILE_PID_ROOT}" == /* ]] || {
  echo "ERROR: profile cache root must be absolute: ${PROFILE_PID_ROOT}" >&2
  exit 1
}

ensure_private_directory() {
  local directory="$1"
  [[ ! -L "${directory}" ]] || {
    echo "ERROR: refusing a symlinked profile cache directory: ${directory}" >&2
    return 1
  }
  mkdir -p -- "${directory}"
  [[ -d "${directory}" && ! -L "${directory}" ]] || {
    echo "ERROR: profile cache path is not a private directory: ${directory}" >&2
    return 1
  }
}

prepare_profile_pid_directory() {
  local profile_dir="${PROFILE_PID_ROOT}/${PROFILE}"
  ensure_private_directory "${PROFILE_PID_ROOT}"
  ensure_private_directory "${profile_dir}"
  PROFILE_PIDS_DIR="${profile_dir}/pids"
  ensure_private_directory "${PROFILE_PIDS_DIR}"
  chmod 700 "${PROFILE_PIDS_DIR}"
}

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

BRANCH_PROFILE_PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${PROFILE_PID_ROOT}/${PROFILE}/ports.env}"
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

prepare_profile_pid_directory
umask 077

cleanup() {
  local index cleanup_status=0
  for ((index = ${#PIDFILES[@]} - 1; index >= 0; index -= 1)); do
    if ! pf_owner_cleanup_record "${PIDFILES[$index]}" "${PROFILE}" "${CONTEXT}" \
      "${WORKTREE_ROOT}" "${PIDFILE_NAMESPACES[$index]}" \
      "${PIDFILE_SERVICES[$index]}" "${PIDFILE_LOCAL_PORTS[$index]}" \
      "${PIDFILE_REMOTE_PORTS[$index]}"; then
      cleanup_status=1
    fi
  done
  return "${cleanup_status}"
}

on_exit() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [[ "${HOLD}" == true || "${STARTUP_COMPLETE}" != true || "${status}" -ne 0 ]]; then
    cleanup || cleanup_status=$?
  fi
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status="${cleanup_status}"
  fi
  exit "${status}"
}

start_pf() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local ports="$4"
  local health_url="${5:-}"
  local log="/tmp/pf-${SAFE_PROFILE}-${name}.log"
  local legacy_pidfile="/tmp/pf-${SAFE_PROFILE}-${name}.pid"
  local profile_pidfile="${PROFILE_PIDS_DIR}/${name}.pid"
  local local_port remote_port pid attempt

  [[ "${ports}" =~ ^([0-9]{1,5}):([0-9]{1,5})$ ]] || {
    echo "ERROR: invalid port mapping for ${name}: ${ports}" >&2
    return 1
  }
  local_port="${BASH_REMATCH[1]}"
  remote_port="${BASH_REMATCH[2]}"
  [[ -n "${health_url}" ]] || {
    echo "ERROR: ${name} has no required health endpoint" >&2
    return 1
  }

  # Do not migrate or kill a live legacy /tmp record: it has no canonical
  # worktree binding. A dead legacy record is unambiguous and can be pruned.
  if [[ -e "${legacy_pidfile}" || -L "${legacy_pidfile}" ]]; then
    pf_owner_cleanup_record "${legacy_pidfile}" "${PROFILE}" "${CONTEXT}" \
      "${WORKTREE_ROOT}" "${namespace}" "${service}" "${local_port}" "${remote_port}"
  fi
  pf_owner_cleanup_record "${profile_pidfile}" "${PROFILE}" "${CONTEXT}" \
    "${WORKTREE_ROOT}" "${namespace}" "${service}" "${local_port}" "${remote_port}"

  nohup "${KC[@]}" -n "${namespace}" port-forward --address=127.0.0.1 "svc/${service}" "${ports}" >"${log}" 2>&1 </dev/null &
  pid=$!
  pf_owner_pause "${STARTUP_DELAY}"
  if ! pf_owner_record_process "${profile_pidfile}" "${pid}" "${PROFILE}" \
    "${CONTEXT}" "${WORKTREE_ROOT}" "${namespace}" "${service}" \
    "${local_port}" "${remote_port}"; then
    echo "  ERROR: ${name} port-forward ownership could not be recorded" >&2
    pf_owner_abort_child "${pid}" "${CONTEXT}" "${namespace}" "${service}" \
      "${local_port}" "${remote_port}" || true
    return 1
  fi

  PIDFILES+=("${profile_pidfile}")
  PIDFILE_NAMESPACES+=("${namespace}")
  PIDFILE_SERVICES+=("${service}")
  PIDFILE_LOCAL_PORTS+=("${local_port}")
  PIDFILE_REMOTE_PORTS+=("${remote_port}")
  echo "  ${name}: pid=${pid} ns=${namespace} svc=${service} ports=${ports}"
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "  ERROR: ${name} port-forward failed to stay running" >&2
    sed -n '1,80p' "${log}" >&2 || true
    return 1
  fi

  for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1)); do
    if curl -sf -m 2 "${health_url}" >/dev/null 2>&1; then
      # Health can succeed in the same small interval in which a forward
      # exits or its PID is reused. Revalidate the exact recorded process and
      # binding after the user-facing probe before publishing success.
      if ! pf_owner_record_process_matches "${profile_pidfile}" "${PROFILE}" \
        "${CONTEXT}" "${WORKTREE_ROOT}" "${namespace}" "${service}" \
        "${local_port}" "${remote_port}"; then
        echo "  ERROR: ${name} port-forward ownership was lost during health verification" >&2
        return 1
      fi
      return 0
    fi
    pf_owner_pause "${HEALTH_DELAY}"
  done
  echo "  ERROR: ${name} did not become healthy (${health_url})" >&2
  return 1
}

start_optional_pf() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local ports="$4"
  local health_url="${5:-}"
  local namespace_resource service_resource

  if ! namespace_resource="$("${KC[@]}" get namespace "${namespace}" --ignore-not-found -o name)"; then
    echo "  ERROR: ${name} could not inspect namespace ${namespace}" >&2
    return 1
  fi
  if [[ -z "${namespace_resource}" ]]; then
    echo "  ${name}: skipped (namespace ${namespace} not present)"
    return 0
  fi
  if ! service_resource="$("${KC[@]}" -n "${namespace}" get svc "${service}" --ignore-not-found -o name)"; then
    echo "  ERROR: ${name} could not inspect service ${namespace}/${service}" >&2
    return 1
  fi
  if [[ -z "${service_resource}" ]]; then
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
  local namespace_resource deployment_resource desired

  if ! namespace_resource="$("${KC[@]}" get namespace "${namespace}" --ignore-not-found -o name)"; then
    echo "  ERROR: ${name} could not inspect namespace ${namespace}" >&2
    return 1
  fi
  if [[ -z "${namespace_resource}" ]]; then
    echo "  ${name}: skipped (namespace ${namespace} not present)"
    return 0
  fi
  if ! deployment_resource="$("${KC[@]}" -n "${namespace}" get deploy "${deployment}" --ignore-not-found -o name)"; then
    echo "  ERROR: ${name} could not inspect deployment ${namespace}/${deployment}" >&2
    return 1
  fi
  if [[ -z "${deployment_resource}" ]]; then
    echo "  ${name}: skipped (deployment ${namespace}/${deployment} not present)"
    return 0
  fi
  if ! desired="$("${KC[@]}" -n "${namespace}" get deploy "${deployment}" -o jsonpath='{.spec.replicas}')"; then
    echo "  ERROR: ${name} could not read desired replicas for ${namespace}/${deployment}" >&2
    return 1
  fi
  [[ "${desired}" =~ ^[0-9]+$ ]] || {
    echo "  ERROR: ${name} received invalid desired replicas for ${namespace}/${deployment}: ${desired:-<empty>}" >&2
    return 1
  }
  if [[ "${desired}" == "0" ]]; then
    echo "  ${name}: skipped (deployment ${namespace}/${deployment} scaled to 0)"
    return 0
  fi

  start_optional_pf "${name}" "${namespace}" "${service}" "${ports}" "${health_url}"
}

start_optional_mcp_host_pf() {
  local namespace_resource service_resource
  if ! namespace_resource="$("${KC[@]}" get namespace mcp-host --ignore-not-found -o name)"; then
    echo '  ERROR: mcp-host could not inspect namespace mcp-host' >&2
    return 1
  fi
  if [[ -z "${namespace_resource}" ]]; then
    echo '  mcp-host: skipped (namespace mcp-host not present)'
    return 0
  fi
  if ! service_resource="$("${KC[@]}" -n mcp-host get svc chatllm --ignore-not-found -o name)"; then
    echo '  ERROR: mcp-host could not inspect service mcp-host/chatllm' >&2
    return 1
  fi
  if [[ -n "${service_resource}" ]]; then
    start_pf mcp-host mcp-host chatllm "${MCP_HOST_PORT}:8080" \
      "http://127.0.0.1:${MCP_HOST_PORT}/v1/runtime/health"
    return
  fi
  if ! service_resource="$("${KC[@]}" -n mcp-host get svc mcp-host --ignore-not-found -o name)"; then
    echo '  ERROR: mcp-host could not inspect service mcp-host/mcp-host' >&2
    return 1
  fi
  if [[ -n "${service_resource}" ]]; then
    start_pf mcp-host mcp-host mcp-host "${MCP_HOST_PORT}:8080" \
      "http://127.0.0.1:${MCP_HOST_PORT}/v1/runtime/health"
    return
  fi
  echo '  mcp-host: skipped (service mcp-host/chatllm or mcp-host/mcp-host not present)'
}

# Install the cleanup boundary before the first background process is started.
# A later start_pf failure must not strand forwards that were already launched.
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "=== Starting gate port-forwards (${PROFILE}) ==="
start_pf control-ui control-plane control-ui "${CONTROL_UI_PORT}:3000" "http://127.0.0.1:${CONTROL_UI_PORT}"
start_optional_pf profile-ui profiles profile-ui "${PROFILE_UI_PORT}:3001" "http://127.0.0.1:${PROFILE_UI_PORT}"
start_pf control-api control-plane control-api "${CONTROL_API_PORT}:8090" "http://127.0.0.1:${CONTROL_API_PORT}/health"
start_pf external-rest-api profiles external-rest-api "${EXTERNAL_REST_API_PORT}:8091" "http://127.0.0.1:${EXTERNAL_REST_API_PORT}/health"
start_pf rpc-proxy rpc-proxy rpc-proxy "${RPC_PROXY_PORT}:8094" "http://127.0.0.1:${RPC_PROXY_PORT}/health"
start_optional_pf registry-api registry registry-api "${REGISTRY_API_PORT}:8085" "http://127.0.0.1:${REGISTRY_API_PORT}/health"
start_optional_deployment_pf workflow-approval-request-reader channels clerum-workflow-approval-request-reader workflow-approval-request-reader "${WORKFLOW_APPROVAL_READER_PORT}:8098" "http://127.0.0.1:${WORKFLOW_APPROVAL_READER_PORT}/health"
start_optional_mcp_host_pf

STARTUP_COMPLETE=true
echo "=== Port-forwards refreshed ==="

if [[ "${HOLD}" == "true" ]]; then
  echo "=== Holding port-forwards open; press Ctrl-C to stop ==="
  while true; do
    sleep 3600 &
    wait "$!" || true
  done
fi
