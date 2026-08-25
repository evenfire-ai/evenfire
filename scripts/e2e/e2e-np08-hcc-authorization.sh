#!/usr/bin/env bash
set -euo pipefail

# Local Minikube E2E for the NP-08 caller-binding contract.
#
# This is intentionally a service-to-service journey: the request originates
# inside the mcp-host pod, crosses the real HCC gateway, and is authorized by
# the deployed HCC. The Host JWT never leaves that pod. Fixture Secret values
# are synthetic, asserted only in the in-pod process, and never printed.
#
# It is not a production/shared-cluster test. The explicit context guard and
# cleanup trap make accidental use outside the branch-owned Minikube lane a
# hard failure.

usage() {
  cat >&2 <<'USAGE'
usage: scripts/e2e/e2e-np08-hcc-authorization.sh --context <branch-owned-minikube-context>
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
NP08_RUNTIME_MODULE="${SCRIPT_DIR}/_lib/np08-runtime-access.mjs"

context=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      context="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${context}" ]]; then
  usage
  exit 2
fi

profile="${MINIKUBE_PROFILE:-${context}}"
if [[ "${profile}" != "${context}" ]]; then
  echo "FAIL: MINIKUBE_PROFILE must equal --context for the deployed NP-08 gate" >&2
  exit 2
fi

case "${context}" in
  *gke*|*prod*|*staging*|clerum-test|default|minikube)
    echo "FAIL: refusing shared, protected, or non-local NP-08 context" >&2
    exit 2
    ;;
esac
if [[ ! "${context}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "FAIL: NP-08 context is not a valid local Minikube identifier" >&2
  exit 2
fi

for command_name in kubectl jq git shasum awk python3 node; do
  command -v "${command_name}" >/dev/null || {
    echo "FAIL: required command missing: ${command_name}" >&2
    exit 1
  }
done

[[ -r "${NP08_RUNTIME_MODULE}" ]] || {
  echo 'FAIL: NP-08 runtime access module is unavailable' >&2
  exit 1
}

kctl() {
  kubectl --context="${context}" "$@"
}

# shellcheck source=scripts/minikube/pre-gate-marker.sh
source "${PROJECT_DIR}/scripts/minikube/pre-gate-marker.sh"
# shellcheck source=scripts/minikube/image-mode.sh
source "${PROJECT_DIR}/scripts/minikube/image-mode.sh"
# shellcheck source=scripts/e2e/_lib/np08-cleanup.sh
source "${SCRIPT_DIR}/_lib/np08-cleanup.sh"
# shellcheck source=scripts/e2e/_lib/np08-provenance.sh
source "${SCRIPT_DIR}/_lib/np08-provenance.sh"

SYNC_CONFIGMAP="${CLERUM_PRE_GATE_SYNC_CONFIGMAP:-clerum-pre-gate-sync-state}"
PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${profile}/ports.env}"

verify_profile_ownership() {
  [[ -f "${PORTS_ENV}" ]] || {
    echo "FAIL: branch profile ports.env is missing: ${PORTS_ENV}" >&2
    exit 1
  }
  local profile_dir profile_env profile_name profile_repo profile_branch profile_dirty current_branch
  profile_dir="${PORTS_ENV%/ports.env}"
  profile_env="${profile_dir}/profile.env"
  [[ -f "${profile_env}" ]] || {
    echo "FAIL: branch profile metadata is missing: ${profile_env}" >&2
    exit 1
  }
  profile_name="$(awk -F= '$1 == "PROFILE" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}" 2>/dev/null || true)"
  profile_repo="$(awk -F= '$1 == "REPO_DIR" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}" 2>/dev/null || true)"
  profile_branch="$(awk -F= '$1 == "BRANCH" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}" 2>/dev/null || true)"
  profile_dirty="$(awk -F= '$1 == "DIRTY" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}" 2>/dev/null || true)"
  current_branch="$(git -C "${PROJECT_DIR}" branch --show-current 2>/dev/null || true)"
  [[ "${profile_name}" == "${profile}" ]] || {
    echo "FAIL: profile marker belongs to '${profile_name:-unknown}', not ${profile}" >&2
    exit 1
  }
  [[ "${profile_dirty}" == "false" ]] || {
    echo "FAIL: profile marker is dirty; refuse stale-profile E2E" >&2
    exit 1
  }
  [[ -n "${profile_repo}" && "$(cd -- "${profile_repo}" 2>/dev/null && pwd -P)" == "${PROJECT_DIR}" ]] || {
    echo "FAIL: profile marker belongs to another worktree: ${profile_repo:-unknown}" >&2
    exit 1
  }
  [[ -n "${current_branch}" && "${profile_branch}" == "${current_branch}" ]] || {
    echo "FAIL: profile marker belongs to another branch" >&2
    exit 1
  }
}

verify_clean_and_sync_marker() {
  local head worktree_id marker_json
  local expected_cluster expected_infra expected_image_source expected_image_tag
  local expected_images_generated_at
  [[ -z "$(git -C "${PROJECT_DIR}" status --porcelain)" ]] || {
    echo "FAIL: worktree is dirty; commit or restore before deployed NP-08 E2E" >&2
    exit 1
  }
  head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD)"
  worktree_id="$(printf '%s' "${PROJECT_DIR}" | shasum | awk '{print $1}')"
  marker_json="$(np08_read_sync_marker control-plane "${SYNC_CONFIGMAP}")" || {
    echo "FAIL: pre-gate marker is missing: control-plane/${SYNC_CONFIGMAP}" >&2
    exit 1
  }
  if ! expected_cluster="$(pre_gate_marker_cluster_fingerprint "${PROJECT_DIR}")"; then
    echo "FAIL: unable to compute current cluster fingerprint" >&2
    exit 1
  fi
  if ! expected_infra="$(pre_gate_marker_infra_fingerprint "${PROJECT_DIR}")"; then
    echo "FAIL: unable to compute current infrastructure fingerprint" >&2
    exit 1
  fi
  if ! expected_image_source="$(image_mode_source "${PROJECT_DIR}")"; then
    echo "FAIL: unable to resolve current image source" >&2
    exit 1
  fi
  if ! expected_image_tag="$(image_mode_tag "${PROJECT_DIR}")"; then
    echo "FAIL: unable to resolve current image tag" >&2
    exit 1
  fi
  if ! expected_images_generated_at="$(image_mode_images_generated_at "${PROJECT_DIR}")"; then
    echo "FAIL: unable to resolve current image acquisition timestamp" >&2
    exit 1
  fi
  np08_verify_sync_marker \
    "${worktree_id}" "${head}" \
    "${expected_cluster}" "${expected_infra}" \
    "${expected_image_source}" "${expected_image_tag}" \
    "${expected_images_generated_at}" "${marker_json}"
}

MCP_NS='mcp-server'
HOST_NS='mcp-host'
CONTROL_NS='control-plane'
HOST_DEPLOYMENT='chatllm'
RUN_ID="${NP08_E2E_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
OWNER_LABEL_KEY='np08.evenfire/owner'
OWNER_LABEL_VALUE='hcc-authorization'
CONTEXT_A='context1'
CONTEXT_B="np08-e2e-${RUN_ID}-context-b"
SERVER_A="np08-e2e-${RUN_ID}-server-a"
SERVER_B="np08-e2e-${RUN_ID}-server-b"
# SERVER_C is a same-Context (CONTEXT_A) no-auth server: no `auth:` block, so a
# credential request must return 200 token:null. Self-provisioned by this test
# instead of assuming a pre-seeded environment server, so the no-auth leg does
# not depend on an external stack existing in the branch profile.
SERVER_C="np08-e2e-${RUN_ID}-server-c"
SECRET_A="np08-e2e-${RUN_ID}-server-a-auth"
SECRET_B="np08-e2e-${RUN_ID}-server-b-auth"

verify_profile_ownership
verify_clean_and_sync_marker

cleanup() {
  local status=$?
  local cleanup_status=0
  local remove_patch context_contains_fixture context_a_json
  set +e
  if [[ "${fixture_context_patched:-0}" == 1 ]]; then
    remove_patch="$(kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json 2>/dev/null | jq -c --arg servera "${SERVER_A}" --arg serverc "${SERVER_C}" '
      [(.spec.mcpServers // [] | to_entries[] | select(.value == $servera or .value == $serverc) | .key)]
      | reverse | map({op:"remove", path:("/spec/mcpServers/" + tostring)})' 2>/dev/null)"
    if [[ -z "${remove_patch}" || "${remove_patch}" == "null" ]]; then
      cleanup_status=1
    elif [[ "${remove_patch}" != '[]' ]] && ! kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json -p "${remove_patch}" >/dev/null 2>&1; then
      cleanup_status=1
    fi
  fi
  for resource in mcpserver secret context; do
    if ! kctl -n "${MCP_NS}" delete "${resource}" \
      -l "${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE},np08.evenfire/run=${RUN_ID}" \
      --ignore-not-found >/dev/null 2>&1; then
      cleanup_status=1
    fi
  done
  context_a_json="$(kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json 2>/dev/null)" || cleanup_status=1
  if [[ -n "${context_a_json}" ]]; then
    context_contains_fixture="$(jq -r --arg servera "${SERVER_A}" --arg serverc "${SERVER_C}" '(.spec.mcpServers // []) | any(. == $servera or . == $serverc)' <<<"${context_a_json}" 2>/dev/null)" || cleanup_status=1
  else
    context_contains_fixture='unknown'
  fi
  if [[ "${context_contains_fixture}" == "true" ]]; then
    cleanup_status=1
  fi
  for resource in mcpserver secret context; do
    if ! np08_cleanup_check_residual "${resource}" \
      "${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE},np08.evenfire/run=${RUN_ID}"; then
      cleanup_status=1
    fi
  done
  if [[ "${cleanup_status}" -ne 0 ]]; then
    echo 'FAIL: NP-08 E2E cleanup did not remove all owned fixtures' >&2
  fi
  status="$(np08_cleanup_final_status "${status}" "${cleanup_status}")"
  if [[ "${status}" -eq 0 ]]; then
    echo 'PASS: NP-08 deployed HCC authorization E2E'
  else
    echo 'FAIL: NP-08 deployed HCC authorization E2E' >&2
  fi
  exit "${status}"
}
trap cleanup EXIT

kctl get namespace "${MCP_NS}" -o name >/dev/null
kctl get namespace "${HOST_NS}" -o name >/dev/null
kctl -n "${CONTROL_NS}" get deployment host-context-controller \
  -o jsonpath='{.status.readyReplicas}' | grep -qx '1'
kctl -n "${CONTROL_NS}" get deployment host-context-controller-api-gateway \
  -o jsonpath='{.status.readyReplicas}' | grep -qx '1'
kctl -n "${HOST_NS}" get deployment "${HOST_DEPLOYMENT}" \
  -o jsonpath='{.status.readyReplicas}' | grep -qx '1'

if kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json | jq -e --arg servera "${SERVER_A}" --arg serverc "${SERVER_C}" '(.spec.mcpServers // []) | any(. == $servera or . == $serverc)' >/dev/null; then
  echo "FAIL: generated fixture server name already exists in ${CONTEXT_A}" >&2
  exit 1
fi

# Prove the actual mcp-host process is healthy before creating any fixture.
# The reviewed module is streamed into the pod, so the deployed journey and
# its deterministic unit tests execute the same access-only implementation.
kctl -n "${HOST_NS}" exec -i "deploy/${HOST_DEPLOYMENT}" -- \
  env NP08_RUNTIME_ACTION=health node --input-type=module - < "${NP08_RUNTIME_MODULE}"

# The fixtures are deliberately managed:false: HCC must expose their live
# authority state without creating a workload or opening a new transport lane.
kctl -n "${MCP_NS}" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_A}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
type: Opaque
stringData:
  token: np08-synthetic-${RUN_ID}-a
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_B}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
type: Opaque
stringData:
  token: np08-synthetic-${RUN_ID}-b
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CONTEXT_B}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
spec:
  contextId: ${CONTEXT_B}
  mcpServers:
    - ${SERVER_B}
---
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${SERVER_A}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
spec:
  contextRef: ${CONTEXT_A}
  image: clerum/mock-mcp-server:dev
  managed: false
  transport:
    type: streamableHttp
    url: http://synthetic-a.invalid/mcp
    port: 3000
  auth:
    type: bearer
    secretRef: ${SECRET_A}
    secretKey: token
  enabled: true
---
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${SERVER_B}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
spec:
  contextRef: ${CONTEXT_B}
  image: clerum/mock-mcp-server:dev
  managed: false
  transport:
    type: streamableHttp
    url: http://synthetic-b.invalid/mcp
    port: 3000
  auth:
    type: bearer
    secretRef: ${SECRET_B}
    secretKey: token
  enabled: true
---
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${SERVER_C}
  namespace: ${MCP_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
spec:
  contextRef: ${CONTEXT_A}
  image: clerum/mock-mcp-server:dev
  managed: false
  transport:
    type: streamableHttp
    url: http://synthetic-c.invalid/mcp
    port: 3000
  enabled: true
YAML

# Append only the fixture owned by this test; cleanup removes only this
# test's matching server entry and labeled resources.
kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json \
  -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"${SERVER_A}\"}]" >/dev/null
fixture_context_patched=1
kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json \
  -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"${SERVER_C}\"}]" >/dev/null

echo 'E2E setup: waiting for HCC to observe the synthetic Context/McpServer fixtures'

# Keep the runtime JWT and the returned synthetic token inside the Host pod.
# The process emits only assertion labels and status/error classes.
kctl -n "${HOST_NS}" exec -i "deploy/${HOST_DEPLOYMENT}" -- \
  env NP08_RUNTIME_ACTION=journey \
  "NP08_SERVER_A=${SERVER_A}" "NP08_SERVER_B=${SERVER_B}" "NP08_SERVER_C=${SERVER_C}" \
  "NP08_EXPECTED_SYNTHETIC_VALUE=np08-synthetic-${RUN_ID}-a" \
  node --input-type=module - < "${NP08_RUNTIME_MODULE}"
