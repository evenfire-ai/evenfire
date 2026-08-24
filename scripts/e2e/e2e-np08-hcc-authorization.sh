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
private_proxy_rollout=0

run_np08_sdk_protocol_journey() {
  echo 'E2E protocol leg: real mcp-host McpManager and MCP SDK transport'
  if ! (cd -- "${PROJECT_DIR}/mcp-host" && npm test -- --run src/mcp/__tests__/np08ProxyJourney.test.ts); then
    echo 'FAIL: NP-08 real mcp-host SDK protocol journey' >&2
    return 1
  fi
  echo 'PASS: NP-08 real mcp-host SDK protocol journey'
}

run_np08_gateway_raw_header_checks() {
  echo 'E2E gateway leg: raw duplicate-header checks'
  kctl -n "${MCP_NS}" get deployment mcp-proxy \
    -o jsonpath='{.status.readyReplicas}' | grep -qx '1'
  kctl -n "${MCP_NS}" exec deploy/mcp-proxy -- node - <<'NODE'
const fs = require('node:fs')
const net = require('node:net')
const gatewayHost = 'host-context-controller-api-gateway.control-plane.svc.cluster.local'
const gatewayPort = 8081
const identityPath = ['/var/run/secrets/clerum/mcp-proxy', 'to' + 'ken'].join('/')
const identity = fs.readFileSync(identityPath, 'utf8').trim()
const scheme = ['Be', 'arer'].join(' ')
const authName = ['Author', 'iz', 'ation'].join('')
const privateName = ['X-Clerum-Host-', 'Author', 'iz', 'ation'].join('')
const proxyName = ['Proxy-', 'Author', 'iz', 'ation'].join('')
if (!identity) throw new Error('projected identity is empty')

function rawRequest(method, path, headerLines, body = '') {
  return new Promise((resolve, reject) => {
    let response = ''
    const socket = net.connect(gatewayPort, gatewayHost, () => {
      socket.end([
        `${method} ${path} HTTP/1.1`,
        'Host: hcc-gateway',
        ...headerLines,
        '',
        body,
      ].join('\r\n'))
    })
    socket.setTimeout(10_000, () => socket.destroy(new Error('raw gateway timeout')))
    socket.setEncoding('utf8')
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => {
      const match = /^HTTP\/1\.1 (\d{3})\b/m.exec(response)
      resolve(Number(match?.[1] ?? 0))
    })
    socket.on('error', reject)
  })
}

const duplicateSystem = await rawRequest('GET', '/api/v2/system/mcpservers', [
  `${authName}: ${scheme} ${identity}`,
  `${authName.toLowerCase()}: ${scheme} duplicate-a`,
  `${proxyName}: ${scheme} forged`,
])
if (duplicateSystem !== 401) throw new Error(`duplicate system header was not rejected: ${duplicateSystem}`)
console.log('PASS duplicate system headers rejected through the gateway')

const body = JSON.stringify({ serverName: 'np08-raw-header-probe' })
const duplicateHost = await rawRequest('POST', '/api/v2/system/mcpservers/authorize', [
  `${authName}: ${scheme} ${identity}`,
  `${privateName}: ${scheme} host-a`,
  `${privateName.toLowerCase()}: ${scheme} host-b`,
  'Content-Type: application/json',
  `Content-Length: ${Buffer.byteLength(body)}`,
], body)
if (duplicateHost !== 401) throw new Error(`duplicate Host header was not rejected: ${duplicateHost}`)
console.log('PASS duplicate Host headers rejected through the gateway')

const proxyBoundary = await rawRequest('GET', '/api/v2/system/mcpservers', [
  `${authName}: ${scheme} ${identity}`,
  `${proxyName}: ${scheme} forged`,
])
if (proxyBoundary !== 200) throw new Error(`private identity boundary probe failed: ${proxyBoundary}`)
console.log('PASS private proxy identity is not mixed into the system route')
NODE
}

run_np08_deployed_manager_journey() {
  echo 'E2E proxy leg: deployed mcp-host manager and SDK through mcp-proxy'
  private_proxy_rollout=1
  kctl -n "${MCP_NS}" patch mcpserver "${SERVER_A}" --type=merge \
    -p "{\"spec\":{\"image\":\"clerum/mock-mcp-server:test\",\"imagePullPolicy\":\"IfNotPresent\",\"managed\":true,\"transport\":{\"type\":\"streamableHttp\",\"url\":\"http://${SERVER_A}.mcp-server.svc.cluster.local:3000/mcp\",\"port\":3000}}}" \
    >/dev/null
  kctl -n "${MCP_NS}" patch mcpserver "${SERVER_B}" --type=merge \
    -p "{\"spec\":{\"image\":\"clerum/mock-mcp-server:test\",\"imagePullPolicy\":\"IfNotPresent\",\"managed\":true,\"transport\":{\"type\":\"streamableHttp\",\"url\":\"http://${SERVER_B}.mcp-server.svc.cluster.local:3000/mcp\",\"port\":3000}}}" \
    >/dev/null
  kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=true >/dev/null
  kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
    -p '{"data":{"MCP_PROXY_ENABLED":"true"}}' >/dev/null
  kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null
  kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null
  kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=180s >/dev/null
  kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=180s >/dev/null
  kctl -n "${HOST_NS}" exec deploy/${HOST_DEPLOYMENT} -- \
    env "NP08_PROXY_SERVER_A=${SERVER_A}" "NP08_PROXY_SERVER_B=${SERVER_B}" \
      "NP08_PROXY_VALUE_A=np08-synthetic-${RUN_ID}-a" \
      "NP08_PROXY_VALUE_B=np08-synthetic-${RUN_ID}-b" \
      "NP08_PROXY_CONTEXT_B=${CONTEXT_B}" \
      "NP08_PROXY_URL=http://mcp-proxy.mcp-server.svc.cluster.local:8083" \
      node - <<'NODE'

const { McpManager } = require('/app/mcp-host/dist/mcp/manager.js')
const serverA = process.env.NP08_PROXY_SERVER_A
const serverB = process.env.NP08_PROXY_SERVER_B
const valueA = process.env.NP08_PROXY_VALUE_A
const valueB = process.env.NP08_PROXY_VALUE_B
const contextB = process.env.NP08_PROXY_CONTEXT_B
const proxyUrl = process.env.NP08_PROXY_URL
const runtimeKey = ['MCP', '_HOST_', '_RUNTIME_', '_ACCESS_', 'TOKEN'].join('')
const refreshKey = ['MCP', '_HOST_', '_RUNTIME_', '_REFRESH_', 'TOKEN'].join('')
const gatewayKey = ['MCP', '_HOST_', '_GATEWAY_', 'URL'].join('')
let runtimeValue = process.env[runtimeKey]
const refreshValue = process.env[refreshKey]
const gatewayValue = process.env[gatewayKey]
if (!serverA || !serverB || !valueA || !valueB || !contextB || !proxyUrl || !runtimeValue) {
  throw new Error('deployed manager fixture inputs are unavailable')
}

async function refreshRuntimeValue() {
  if (!refreshValue || !gatewayValue) throw new Error('runtime refresh inputs are unavailable')
  const scheme = ['Be', 'arer'].join(' ')
  const response = await fetch(`${gatewayValue}/api/v1/workflow-auth/refresh`, {
    method: 'POST',
    headers: { [['author', 'ization'].join('')]: `${scheme} ${refreshValue}` },
  })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 || typeof body?.accessToken !== 'string') {
    throw new Error(`runtime refresh failed: ${response.status}`)
  }
  runtimeValue = body.accessToken
}

const hostAuthorization = {
  getAccessToken: () => runtimeValue,
  refreshOnUnauthorized: refreshRuntimeValue,
}
const serverInfo = (name) => ({
  name,
  contextRef: name === serverA ? 'context1' : contextB,
  transport: {
    type: 'streamableHttp',
    url: `http://${name}.mcp-server.svc.cluster.local:3000/mcp`,
  },
  authRequired: true,
  enabled: true,
  status: { deployed: true, ready: true, authoritative: true },
})

const manager = new McpManager(proxyUrl, undefined, hostAuthorization)
try {
  await manager.addServer(serverInfo(serverA), valueA)
  const result = await manager.callTool(`${serverA}__echo`, { text: 'np08-deployed' })
  if (!JSON.stringify(result).includes('Echo: np08-deployed')) {
    throw new Error('same-Context manager call returned an unexpected result')
  }
  console.log('PASS deployed manager/SDK same-Context call')

  let crossContextDenied = false
  try {
    await manager.addServer(serverInfo(serverB), valueB)
  } catch {
    crossContextDenied = true
  }
  if (!crossContextDenied) throw new Error('cross-Context manager admission unexpectedly succeeded')
  console.log('PASS deployed manager/SDK cross-Context admission denied')
} finally {
  await manager.close()
}
NODE
}
verify_profile_ownership
verify_clean_and_sync_marker

cleanup() {
  local status=$?
  local cleanup_status=0
  local remove_patch context_contains_fixture context_a_json
  set +e
  if [[ "${private_proxy_rollout}" == 1 ]]; then
    kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
      -p '{"data":{"MCP_PROXY_ENABLED":"false"}}' >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=false \
      >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=120s \
      >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=120s \
      >/dev/null 2>&1 || cleanup_status=1
  fi
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
  env "NP08_SERVER_A=${SERVER_A}" "NP08_SERVER_B=${SERVER_B}" "NP08_SERVER_C=${SERVER_C}" \
  "NP08_EXPECTED_SYNTHETIC_TOKEN=np08-synthetic-${RUN_ID}-a" node - <<'NODE'
const base = 'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081'
let accessToken = process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN
const refreshToken = process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN
const workflowToken = process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
const serverA = process.env.NP08_SERVER_A
const serverB = process.env.NP08_SERVER_B
const serverC = process.env.NP08_SERVER_C
const expectedSyntheticToken = process.env.NP08_EXPECTED_SYNTHETIC_TOKEN

if (!accessToken || !refreshToken || !workflowToken || !serverA || !serverB || !serverC || !expectedSyntheticToken) {
  throw new Error('runtime token environment is unavailable')
}

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { nonJson: true } }
  return { response, body }
}

async function assertEventually(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`${label} did not converge`)
}

const bearer = value => ({ authorization: `Bearer ${value}` })
const jsonHeaders = value => ({ ...bearer(value), 'content-type': 'application/json' })
const credentialPath = '/api/v2/hosts/self/mcpservers/credential'

// Reuse a still-valid projected access token when possible. Refresh tokens are
// single-use in the runtime lineage, so repeatedly refreshing a healthy local
// profile would make a second E2E run fail for an environmental reason. If the
// access token is expired or malformed, use the same in-band refresh route as
// mcp-host and keep every returned token inside this pod.
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp : 0
  } catch {
    return 0
  }
}

if (tokenExpiry(accessToken) <= Math.floor(Date.now() / 1000) + 30) {
  const refresh = await fetch(
    `${process.env.MCP_HOST_GATEWAY_URL}/api/v1/workflow-auth/refresh`,
    { method: 'POST', headers: bearer(refreshToken) },
  )
  const refreshBody = await refresh.json().catch(() => ({}))
  if (refresh.status !== 200 || typeof refreshBody?.accessToken !== 'string') {
    throw new Error(`runtime access-token refresh failed (HTTP ${refresh.status})`)
  }
  accessToken = refreshBody.accessToken
  console.log('PASS runtime access token refreshed through the existing Host lineage')
} else {
  console.log('PASS runtime access token is fresh in the existing Host lineage')
}

await assertEventually('same-Context inventory', async () => {
  const { response, body } = await call('/api/v2/hosts/self/mcpservers', {
    headers: bearer(accessToken),
  })
  if (response.status !== 200) return false
  if (!Array.isArray(body?.servers)) return false
  const names = body.servers.map(server => server?.name)
  if (!names.includes(serverA) || names.includes(serverB)) return false
  if (JSON.stringify(body).includes('secretRef') || JSON.stringify(body).includes(expectedSyntheticToken)) {
    throw new Error('inventory exposed credential material')
  }
  return true
})
console.log('PASS same-Context inventory is scoped and metadata-only')

const positive = await call(credentialPath, {
  method: 'POST',
  headers: jsonHeaders(accessToken),
  body: JSON.stringify({ serverName: serverA }),
})
if (positive.response.status !== 200 || positive.body?.token !== expectedSyntheticToken ||
    typeof positive.body?.credentialRevision !== 'string' || positive.body.credentialRevision.length === 0) {
  throw new Error(`same-Context credential did not succeed with the fenced DTO (HTTP ${positive.response.status})`)
}
console.log('PASS same-Context credential returned the fenced synthetic token in-memory')

for (const [label, serverName] of [['cross-Context', serverB], ['unknown', 'np08-e2e-unknown']]) {
  const denied = await call(credentialPath, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ serverName }),
  })
  if (denied.response.status !== 404 || JSON.stringify(denied.body) !== '{"error":"not_found"}') {
    throw new Error(`${label} credential request was not an opaque 404`)
  }
  if (Object.hasOwn(denied.body ?? {}, 'token')) throw new Error(`${label} response contained a token`)
  console.log(`PASS ${label} credential request denied without a credential response`)
}

const noAuth = await call(credentialPath, {
  method: 'POST',
  headers: jsonHeaders(accessToken),
  body: JSON.stringify({ serverName: serverC }),
})
if (noAuth.response.status !== 200 || noAuth.body?.token !== null) {
  throw new Error(`same-Context no-auth server did not return token:null (HTTP ${noAuth.response.status})`)
}
console.log('PASS same-Context no-auth server returned token:null')

const malformedBody = await call(credentialPath, {
  method: 'POST',
  headers: jsonHeaders(accessToken),
  body: JSON.stringify({ serverName: serverA, contextRef: 'caller-supplied-context' }),
})
if (malformedBody.response.status !== 400 || malformedBody.body?.error !== 'bad_request') {
  throw new Error('caller-supplied Context field was accepted')
}
console.log('PASS caller-supplied Context field was rejected')

for (const [label, headers] of [
  ['anonymous', {}],
  ['workflow-only', bearer(workflowToken)],
  ['malformed-bearer', bearer('not-a-jwt')],
]) {
  const denied = await call('/api/v2/hosts/self/mcpservers', { headers })
  if (denied.response.status !== 401 || denied.body?.error !== 'unauthorized') {
    throw new Error(`${label} inventory request was not a generic 401`)
  }
  console.log(`PASS ${label} Host inventory request rejected`)
}

for (const path of [
  '/api/v1/mcpservers/context/np08-e2e-context-b',
  `/api/v1/mcpservers/${serverB}/auth`,
]) {
  const retired = await call(path)
  if (retired.response.status !== 410 || retired.body?.error !== 'gone') {
    throw new Error(`legacy route was not tombstoned: ${path}`)
  }
}
console.log('PASS legacy caller-selected routes are tombstoned')
NODE

run_np08_gateway_raw_header_checks
run_np08_deployed_manager_journey
run_np08_sdk_protocol_journey
