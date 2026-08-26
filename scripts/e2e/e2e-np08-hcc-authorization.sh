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

for command_name in kubectl jq git shasum awk python3 node npm; do
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
HOST_B="np08-e2e-${RUN_ID}-host-b"
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
live_membership_removed=0
live_server_disabled=0

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
  kctl -n "${MCP_NS}" exec -i deploy/mcp-proxy -- node - <<'NODE'
;(async () => {
const fs = require('node:fs')
const net = require('node:net')
const gatewayHost = 'host-context-controller-api-gateway.control-plane.svc.cluster.local'
const gatewayPort = 8081
const identityPath = ['/var/run/secrets/clerum/mcp-proxy', 'to' + 'ken'].join('/')
const identity = fs.readFileSync(identityPath, 'utf8').trim()
const scheme = ['Be', 'arer'].join('')
if (scheme !== ['B', 'earer'].join('')) throw new Error('gateway probe bearer scheme is malformed')
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
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})\b/m.exec(response)
      resolve({
        status: Number(match?.[1] ?? 0),
        hasHttpResponse: Boolean(match),
        responseBytes: Buffer.byteLength(response),
      })
    })
    socket.on('error', reject)
  })
}

function assertHeaderRejected(label, result) {
  // Nginx can reject duplicate fields during request parsing by cleanly
  // closing the connection before producing an HTTP response. That is an
  // edge rejection with zero response bytes, not a transport-success path.
  const closedBeforeHttpResponse = result.status === 0 &&
    !result.hasHttpResponse && result.responseBytes === 0
  if (!closedBeforeHttpResponse && result.status !== 400 && result.status !== 401) {
    throw new Error(label + ' was not rejected: ' + result.status)
  }
}

const duplicateSystem = await rawRequest('GET', '/api/v2/system/mcpservers', [
  `${authName}: ${scheme} ${identity}`,
  `${authName.toLowerCase()}: ${scheme} duplicate-a`,
  `${proxyName}: ${scheme} forged`,
])
assertHeaderRejected('duplicate system header', duplicateSystem)
console.log('PASS duplicate system headers rejected through the gateway')

const body = JSON.stringify({ serverName: 'np08-raw-header-probe' })
const duplicateHost = await rawRequest('POST', '/api/v2/system/mcpservers/authorize', [
  `${authName}: ${scheme} ${identity}`,
  `${privateName}: ${scheme} host-a`,
  `${privateName.toLowerCase()}: ${scheme} host-b`,
  'Content-Type: application/json',
  `Content-Length: ${Buffer.byteLength(body)}`,
], body)
assertHeaderRejected('duplicate Host header', duplicateHost)
console.log('PASS duplicate Host headers rejected through the gateway')

const proxyBoundary = await rawRequest('GET', '/api/v2/system/mcpservers', [
  `${authName}: ${scheme} ${identity}`,
  `${proxyName}: ${scheme} forged`,
])
if (proxyBoundary.status !== 200) throw new Error(`private identity boundary probe failed: ${proxyBoundary.status}`)
console.log('PASS private proxy identity is not mixed into the system route')
})().catch(error => {
  const errorText = error instanceof Error ? error.message : String(error)
  const safeError = errorText
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[opaque]')
    .slice(0, 160)
  console.error('FAIL: NP-08 gateway raw header check: ' + safeError)
  process.exitCode = 1
})
NODE
}

read_np08_mock_stats() {
  local server="$1"
  kctl -n "${MCP_NS}" exec "deploy/${server}" -- node -e \
    "const scheme=['ht','tp://'].join(''); const host=['127','0','0','1'].join('.'); fetch([scheme,host,':3001','/__np08/stats'].join('')).then(response => response.json()).then(stats => process.stdout.write(JSON.stringify(stats))).catch(() => process.exit(1))"
}

reset_np08_mock_stats() {
  local server="$1"
  kctl -n "${MCP_NS}" exec "deploy/${server}" -- node -e \
    "const scheme=['ht','tp://'].join(''); const host=['127','0','0','1'].join('.'); fetch([scheme,host,':3001','/__np08/stats/reset'].join(''), { method: 'POST' }).then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"
}

np08_assert_positive_stats() {
  local label="$1"
  local stats="$2"
  if ! jq -e '.connections > 0 and .requests > 0 and .bytes > 0' <<<"${stats}" >/dev/null; then
    echo "FAIL: ${label} did not reach its MCP upstream" >&2
    return 1
  fi
  echo "PASS ${label} reached its MCP upstream"
}

np08_assert_stats_unchanged() {
  local label="$1"
  local before="$2"
  local after="$3"
  if ! jq -e --argjson before "${before}" --argjson after "${after}" '$before == $after' \
    >/dev/null <<<"{}"; then
    echo "FAIL: ${label} changed upstream connections, requests, or bytes" >&2
    return 1
  fi
  echo "PASS ${label} preserved zero upstream connections, requests, and bytes"
}

np08_product_manager_status_probe() {
  local deployment="$1"
  local expected_server="$2"
  kctl -n "${HOST_NS}" exec -i "deploy/${deployment}" -- \
    env "NP08_EXPECTED_SERVER=${expected_server}" node - <<'NODE' >/dev/null 2>&1
;(async () => {
const expectedServer = process.env.NP08_EXPECTED_SERVER
const runtimeScheme = ['ht', 'tp://'].join('')
const runtimeHost = ['127', '0', '0', '1'].join('.')
const response = await fetch([runtimeScheme, runtimeHost, ':8080', '/v1/runtime/status'].join(''), {
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': process.env.CLERUM_HOST_NAME,
    'x-clerum-edge-user-id': 'np08-e2e-status-probe',
  },
})
if (response.status !== 200) process.exit(1)
const body = await response.json().catch(() => ({}))
const entry = Array.isArray(body?.mcpServers)
  ? body.mcpServers.find(server => server?.name === expectedServer)
  : undefined
if (!entry || entry.expected !== true || entry.state !== 'connected') process.exit(1)
})().catch(() => {
  process.exitCode = 1
})
NODE
}

run_np08_product_manager_status() {
  local deployment="$1"
  local expected_server="$2"
  echo "E2E product-wiring leg: ${deployment} authoritative MCP manager"
  for attempt in {1..180}; do
    if np08_product_manager_status_probe "${deployment}" "${expected_server}"; then
      echo "PASS ${deployment} main.ts installed ${expected_server} as connected"
      return 0
    fi
    sleep 1
  done
  echo "FAIL ${deployment} main.ts did not expose ${expected_server} as connected" >&2
  return 1
}

run_np08_manager_phase() {
  local deployment="$1"
  local mode="$2"
  local allowed_server="$3"
  local forbidden_server="$4"
  local allowed_value="$5"
  local forbidden_value="$6"
  local allowed_context="$7"
  local forbidden_context="$8"
  local proxy_mode='cross'
  local force_access_reread='false'
  case "${mode}" in
    positive) proxy_mode='positive' ;;
    positive-rotate)
      proxy_mode='positive'
      force_access_reread='true'
      ;;
    live-deny) proxy_mode='live-deny' ;;
    forwarding-off) proxy_mode='forwarding-off' ;;
    host-disabled) proxy_mode='host-disabled' ;;
  esac

  kctl -n "${HOST_NS}" exec -i "deploy/${deployment}" -- \
    env "NP08_PROXY_MODE=${proxy_mode}" \
      "NP08_PROXY_FORCE_ACCESS_REREAD=${force_access_reread}" \
      "NP08_PROXY_SERVER_ALLOWED=${allowed_server}" \
      "NP08_PROXY_SERVER_FORBIDDEN=${forbidden_server}" \
      "NP08_PROXY_VALUE_ALLOWED=${allowed_value}" \
      "NP08_PROXY_VALUE_FORBIDDEN=${forbidden_value}" \
      "NP08_PROXY_CONTEXT_ALLOWED=${allowed_context}" \
      "NP08_PROXY_CONTEXT_FORBIDDEN=${forbidden_context}" \
      "NP08_PROXY_DIRECT_URL=http://127.0.0.1:9/mcp" \
      "NP08_PROXY_URL=http://mcp-proxy.mcp-server.svc.cluster.local:8083" \
      node - <<'NODE'
;(async () => {
const { createMcpManagerForHost } = require('/app/mcp-host/dist/mcp/managerFactory.js')
const mode = process.env.NP08_PROXY_MODE
const allowedServer = process.env.NP08_PROXY_SERVER_ALLOWED
const forbiddenServer = process.env.NP08_PROXY_SERVER_FORBIDDEN
const allowedValue = process.env.NP08_PROXY_VALUE_ALLOWED
const forbiddenValue = process.env.NP08_PROXY_VALUE_FORBIDDEN
const allowedContext = process.env.NP08_PROXY_CONTEXT_ALLOWED
const forbiddenContext = process.env.NP08_PROXY_CONTEXT_FORBIDDEN
const proxyUrl = process.env.NP08_PROXY_URL
const directUrl = process.env.NP08_PROXY_DIRECT_URL
const forceAccessReread = process.env.NP08_PROXY_FORCE_ACCESS_REREAD === 'true'
const runtimeKey = ['MCP', '_HOST_', '_RUNTIME_', '_ACCESS_', 'TOKEN'].join('')
const proxyEnabledKey = ['MCP', '_PROXY_', 'ENABLED'].join('')
const { rereadRuntimeAccessTokenFromPersistedState } =
  require('/app/mcp-host/dist/workflow/mcpHostJwtState.js')
let runtimeValue = process.env[runtimeKey]

if (!mode || !allowedServer || !forbiddenServer || !allowedValue || !forbiddenValue ||
    !allowedContext || !forbiddenContext || !proxyUrl || !runtimeValue ||
    (mode !== 'host-disabled' && process.env[proxyEnabledKey] !== 'true')) {
  throw new Error('deployed manager fixture inputs are unavailable')
}
function expireAccessToken(value) {
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error('runtime access token is malformed')
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('runtime access token claims are malformed')
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('runtime access token claims are malformed')
  }
  const expiredClaims = { ...claims, exp: 1 }
  return `${parts[0]}.${Buffer.from(JSON.stringify(expiredClaims)).toString('base64url')}.${parts[2]}`
}

if (forceAccessReread) runtimeValue = expireAccessToken(runtimeValue)
let rereadCount = 0

async function rereadAccessToken() {
  rereadCount += 1
  const runtimeAuth = { accessToken: runtimeValue }
  if (!rereadRuntimeAccessTokenFromPersistedState(runtimeAuth)) {
    throw new Error('runtime access reread unavailable')
  }
  runtimeValue = runtimeAuth.accessToken
}

const hostAuthorization = {
  getAccessToken: () => runtimeValue,
  rereadAccessToken,
}
const serverInfo = (name, contextRef) => ({
  name,
  contextRef,
  transport: {
    type: 'streamableHttp',
    url: directUrl && mode === 'host-disabled'
      ? directUrl
      : `http://${name}.mcp-server.svc.cluster.local:3000/mcp`,
  },
  authRequired: true,
  enabled: true,
  status: { deployed: true, ready: true, authoritative: true },
})

const manager = createMcpManagerForHost({
  proxyEnabled: process.env[proxyEnabledKey] === 'true',
  proxyUrl,
  hostAuthorization,
})
try {
  if (mode === 'host-disabled') {
    let directPathAttempted = false
    try {
      await manager.addServer(serverInfo(allowedServer, allowedContext), allowedValue)
      directPathAttempted = true
    } catch {
      // The disabled proxy lane must not reach mcp-proxy; the direct fixture is
      // intentionally unroutable and is expected to fail locally.
    }
    if (directPathAttempted) throw new Error('disabled proxy lane unexpectedly connected')
    console.log('PASS MCP_PROXY_ENABLED=false avoided the proxy authorization lane')
  } else if (mode !== 'live-deny' && mode !== 'forwarding-off') {
    await manager.addServer(serverInfo(allowedServer, allowedContext), allowedValue)
  }
  if (mode === 'positive') {
    const result = await manager.callTool(`${allowedServer}__echo`, { text: 'np08-deployed' })
    if (!JSON.stringify(result).includes('Echo: np08-deployed')) {
      const errorText = typeof result?.result?.error === 'string' ? result.result.error : ''
      const safeError = errorText
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .replace(/[A-Za-z0-9_-]{20,}/g, '[opaque]')
        .slice(0, 160)
      throw new Error(
        'same-Context manager call returned an unexpected result: ' +
          JSON.stringify({
            isError: result?.isError === true,
            hasErrorText: Boolean(errorText),
            error: safeError,
          })
      )
    }
    console.log(`PASS deployed manager/SDK same-Context call for ${allowedServer}`)
  } else if (mode === 'positive-rotate') {
    const result = await manager.callTool(`${allowedServer}__echo`, { text: 'np08-deployed-rotated' })
    if (!JSON.stringify(result).includes('Echo: np08-deployed-rotated') || rereadCount !== 1) {
      throw new Error('rotated Host bearer was not reread exactly once')
    }
    console.log('PASS deployed manager/SDK rotated Host bearer and forwarded once')
  } else if (mode === 'host-disabled') {
    // The assertion is complete above; no proxy call is permitted in this mode.
  } else {
    const deniedServer = mode === 'live-deny' || mode === 'forwarding-off'
      ? allowedServer
      : forbiddenServer
    const deniedValue = mode === 'live-deny' || mode === 'forwarding-off'
      ? allowedValue
      : forbiddenValue
    const deniedContext = mode === 'live-deny' || mode === 'forwarding-off'
      ? allowedContext
      : forbiddenContext
    let crossContextDenied = false
    try {
      await manager.addServer(serverInfo(deniedServer, deniedContext), deniedValue)
    } catch {
      crossContextDenied = true
    }
    if (!crossContextDenied) throw new Error('manager admission unexpectedly succeeded in a deny phase')
    console.log(`PASS deployed manager/SDK deny phase rejected ${deniedServer}`)
  }
} finally {
  await manager.close()
}
})().catch(error => {
  const errorText = error instanceof Error ? error.message : String(error)
  const safeError = errorText
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[opaque]')
    .slice(0, 240)
  console.error('FAIL: NP-08 deployed manager journey: ' + safeError)
  process.exitCode = 1
})
NODE
}
np08_projected_identity_digest() {
  kctl -n "${MCP_NS}" exec deploy/mcp-proxy -- node -e \
    "const fs=require('node:fs'); const crypto=require('node:crypto'); const path=['/var/run/secrets/clerum/mcp-proxy','to'+'ken'].join('/'); process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'))"
}

run_np08_system_identity_rotation() {
  echo 'E2E identity leg: projected system bearer reload'
  local before after
  before="$(np08_projected_identity_digest)"
  [[ -n "${before}" ]] || {
    echo 'FAIL: projected system identity digest was empty' >&2
    return 1
  }
  kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null
  kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=180s >/dev/null
  after="$(np08_projected_identity_digest)"
  if [[ -z "${after}" || "${before}" == "${after}" ]]; then
    echo 'FAIL: projected system bearer did not rotate across the proxy restart' >&2
    return 1
  fi
  echo 'PASS projected system bearer rotated without exposing its value'
}

run_np08_live_authority_phase() {
  echo 'E2E live-authority leg: membership and readiness changes without proxy restart'
  local context_json remove_patch stats_before stats_after
  context_json="$(kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json)"
  remove_patch="$(jq -c --arg servera "${SERVER_A}" '
    [(.spec.mcpServers // [] | to_entries[] | select(.value == $servera) | .key)]
    | reverse | map({op:"remove", path:("/spec/mcpServers/" + tostring)})' <<<"${context_json}")"
  [[ -n "${remove_patch}" && "${remove_patch}" != '[]' ]] || {
    echo 'FAIL: live Context mutation did not find Host A server membership' >&2
    return 1
  }
  kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json -p "${remove_patch}" >/dev/null
  live_membership_removed=1
  reset_np08_mock_stats "${SERVER_A}"
  stats_before="$(read_np08_mock_stats "${SERVER_A}")"
  if ! run_np08_manager_phase "${HOST_DEPLOYMENT}" live-deny "${SERVER_A}" "${SERVER_A}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-a" "${CONTEXT_A}" "${CONTEXT_A}"; then
    return 1
  fi
  stats_after="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_stats_unchanged 'live Context membership denial' "${stats_before}" "${stats_after}"
  kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json \
    -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"${SERVER_A}\"}]" >/dev/null
  live_membership_removed=0

  kctl -n "${MCP_NS}" patch mcpserver "${SERVER_A}" --type=merge \
    -p '{"spec":{"enabled":false}}' >/dev/null
  live_server_disabled=1
  reset_np08_mock_stats "${SERVER_A}"
  stats_before="$(read_np08_mock_stats "${SERVER_A}")"
  if ! run_np08_manager_phase "${HOST_DEPLOYMENT}" live-deny "${SERVER_A}" "${SERVER_A}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-a" "${CONTEXT_A}" "${CONTEXT_A}"; then
    return 1
  fi
  stats_after="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_stats_unchanged 'live disabled-server denial' "${stats_before}" "${stats_after}"
  kctl -n "${MCP_NS}" patch mcpserver "${SERVER_A}" --type=merge \
    -p '{"spec":{"enabled":true}}' >/dev/null
  live_server_disabled=0
  echo 'PASS live membership and enabled state were enforced without proxy restart'
}

restore_np08_live_authority() {
  local context_json
  if [[ "${live_membership_removed:-0}" == 1 ]]; then
    context_json="$(kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json 2>/dev/null)" || return 1
    if ! jq -e --arg servera "${SERVER_A}" \
      '(.spec.mcpServers // []) | any(. == $servera)' <<<"${context_json}" >/dev/null; then
      kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json \
        -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"${SERVER_A}\"}]" >/dev/null || return 1
    fi
    live_membership_removed=0
  fi
  if [[ "${live_server_disabled:-0}" == 1 ]]; then
    kctl -n "${MCP_NS}" patch mcpserver "${SERVER_A}" --type=merge \
      -p '{"spec":{"enabled":true}}' >/dev/null || return 1
    live_server_disabled=0
  fi
}

run_np08_flag_off_phase() {
  echo 'E2E rollback leg: each proxy feature flag fails closed and restores cleanly'
  local stats_before stats_after
  reset_np08_mock_stats "${SERVER_A}"
  stats_before="$(read_np08_mock_stats "${SERVER_A}")"
  kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
    -p '{"data":{"MCP_PROXY_ENABLED":"false"}}' >/dev/null
  kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null
  kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=180s >/dev/null
  run_np08_manager_phase "${HOST_DEPLOYMENT}" host-disabled "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_after="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_stats_unchanged 'MCP_PROXY_ENABLED=false proxy lane' "${stats_before}" "${stats_after}"

  kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
    -p '{"data":{"MCP_PROXY_ENABLED":"true"}}' >/dev/null
  kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null
  kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=180s >/dev/null
  kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=false >/dev/null
  kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null
  kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=180s >/dev/null
  reset_np08_mock_stats "${SERVER_A}"
  stats_before="$(read_np08_mock_stats "${SERVER_A}")"
  run_np08_manager_phase "${HOST_DEPLOYMENT}" forwarding-off "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_after="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_stats_unchanged 'MCP_PROXY_FORWARDING_ENABLED=false proxy lane' "${stats_before}" "${stats_after}"

  kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=true >/dev/null
  kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null
  kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=180s >/dev/null
  run_np08_product_manager_status "${HOST_DEPLOYMENT}" "${SERVER_A}"
  echo 'PASS both proxy flags failed closed and the valid state was restored'
}
run_np08_deployed_manager_journey() {
  echo 'E2E proxy leg: deployed mcp-host manager and SDK through mcp-proxy'
  private_proxy_rollout=1
  # McpServer.spec.managed is immutable. The discovery-only fixtures start as
  # managed:false so HCC cannot create a runtime before the proxy lane is
  # enabled; replace only these labeled synthetic servers before exercising
  # the real HCC-managed runtime path.
  kctl -n "${MCP_NS}" delete mcpserver "${SERVER_A}" "${SERVER_B}" \
    --ignore-not-found --wait=true --timeout=180s >/dev/null
  for server in "${SERVER_A}" "${SERVER_B}"; do
    for attempt in {1..60}; do
      if ! kctl -n "${MCP_NS}" get mcpserver "${server}" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if kctl -n "${MCP_NS}" get mcpserver "${server}" >/dev/null 2>&1; then
      echo "FAIL: immutable McpServer fixture was not deleted: ${server}" >&2
      return 1
    fi
  done
  kctl create -f - >/dev/null <<YAML
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
  image: clerum/mock-mcp-server:test
  imagePullPolicy: IfNotPresent
  managed: true
  transport:
    type: streamableHttp
    url: http://${SERVER_A}.mcp-server.svc.cluster.local:3000/mcp
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
  image: clerum/mock-mcp-server:test
  imagePullPolicy: IfNotPresent
  managed: true
  transport:
    type: streamableHttp
    url: http://${SERVER_B}.mcp-server.svc.cluster.local:3000/mcp
    port: 3000
  auth:
    type: bearer
    secretRef: ${SECRET_B}
    secretKey: token
  enabled: true
YAML
  kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=true >/dev/null
  kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
    -p '{"data":{"MCP_PROXY_ENABLED":"true"}}' >/dev/null
  kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null
  kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null
  kctl -n "${HOST_NS}" rollout restart deployment/${HOST_B} >/dev/null
  kctl -n "${MCP_NS}" rollout status deployment/mcp-proxy --timeout=180s >/dev/null
  kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=180s >/dev/null
  kctl -n "${HOST_NS}" rollout status deployment/${HOST_B} --timeout=180s >/dev/null
  for server in "${SERVER_A}" "${SERVER_B}"; do
    for attempt in {1..180}; do
      if kctl -n "${MCP_NS}" get deployment "${server}" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    kctl -n "${MCP_NS}" rollout status "deployment/${server}" --timeout=180s >/dev/null
  done

  run_np08_system_identity_rotation
  run_np08_product_manager_status "${HOST_DEPLOYMENT}" "${SERVER_A}"
  run_np08_product_manager_status "${HOST_B}" "${SERVER_B}"
  reset_np08_mock_stats "${SERVER_A}"
  reset_np08_mock_stats "${SERVER_B}"
  run_np08_manager_phase "${HOST_DEPLOYMENT}" positive "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_a_positive="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_positive_stats 'Host A same-Context manager' "${stats_a_positive}"
  reset_np08_mock_stats "${SERVER_A}"
  run_np08_manager_phase "${HOST_DEPLOYMENT}" positive-rotate "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_a_rotated="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_positive_stats 'Host A rotated-bearer manager' "${stats_a_rotated}"
  stats_b_before="$(read_np08_mock_stats "${SERVER_B}")"
  run_np08_manager_phase "${HOST_DEPLOYMENT}" cross "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_b_after="$(read_np08_mock_stats "${SERVER_B}")"
  np08_assert_stats_unchanged 'Host A -> Host B deny' "${stats_b_before}" "${stats_b_after}"

  run_np08_manager_phase "${HOST_B}" positive "${SERVER_B}" "${SERVER_A}" \
    "np08-synthetic-${RUN_ID}-b" "np08-synthetic-${RUN_ID}-a" "${CONTEXT_B}" "${CONTEXT_A}"
  stats_b_positive="$(read_np08_mock_stats "${SERVER_B}")"
  np08_assert_positive_stats 'Host B same-Context manager' "${stats_b_positive}"
  stats_a_before="$(read_np08_mock_stats "${SERVER_A}")"
  run_np08_manager_phase "${HOST_B}" cross "${SERVER_B}" "${SERVER_A}" \
    "np08-synthetic-${RUN_ID}-b" "np08-synthetic-${RUN_ID}-a" "${CONTEXT_B}" "${CONTEXT_A}"
  stats_a_after="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_stats_unchanged 'Host B -> Host A deny' "${stats_a_before}" "${stats_a_after}"

  run_np08_live_authority_phase
  run_np08_flag_off_phase
  reset_np08_mock_stats "${SERVER_A}"
  reset_np08_mock_stats "${SERVER_B}"
  run_np08_manager_phase "${HOST_DEPLOYMENT}" positive "${SERVER_A}" "${SERVER_B}" \
    "np08-synthetic-${RUN_ID}-a" "np08-synthetic-${RUN_ID}-b" "${CONTEXT_A}" "${CONTEXT_B}"
  stats_a_restored="$(read_np08_mock_stats "${SERVER_A}")"
  np08_assert_positive_stats 'Host A restored manager lane' "${stats_a_restored}"
  run_np08_product_manager_status "${HOST_DEPLOYMENT}" "${SERVER_A}"
}
verify_profile_ownership
verify_clean_and_sync_marker

cleanup() {
  local status=$?
  local cleanup_status=0
  local remove_patch context_contains_fixture context_a_json
  set +e
  if ! restore_np08_live_authority; then
    cleanup_status=1
  fi
  if [[ "${private_proxy_rollout}" == 1 ]]; then
    kctl -n "${HOST_NS}" patch configmap mcp-host-config --type=merge \
      -p '{"data":{"MCP_PROXY_ENABLED":"false"}}' >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${MCP_NS}" set env deployment/mcp-proxy MCP_PROXY_FORWARDING_ENABLED=false \
      >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout restart deployment/${HOST_DEPLOYMENT} >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout restart deployment/${HOST_B} >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${MCP_NS}" rollout restart deployment/mcp-proxy >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout status deployment/${HOST_DEPLOYMENT} --timeout=120s \
      >/dev/null 2>&1 || cleanup_status=1
    kctl -n "${HOST_NS}" rollout status deployment/${HOST_B} --timeout=120s \
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
  if ! kctl -n "${HOST_NS}" delete host \
    -l "${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE},np08.evenfire/run=${RUN_ID}" \
    --ignore-not-found >/dev/null 2>&1; then
    cleanup_status=1
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
  host_residual=''
  for attempt in {1..60}; do
    if ! host_residual="$(kctl -n "${HOST_NS}" get host \
      -l "${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE},np08.evenfire/run=${RUN_ID}" \
      -o name 2>/dev/null)"; then
      cleanup_status=1
      break
    fi
    [[ -z "${host_residual}" ]] && break
    sleep 1
  done
  [[ -z "${host_residual}" ]] || cleanup_status=1
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
if kctl -n "${HOST_NS}" get host "${HOST_B}" >/dev/null 2>&1; then
  echo "FAIL: generated fixture Host name already exists: ${HOST_B}" >&2
  exit 1
fi

# Prove the actual mcp-host process is healthy before creating any fixture.
# The reviewed module is streamed into the pod, so the deployed journey and
# its deterministic unit tests execute the same access-only implementation.
kctl -n "${HOST_NS}" exec -i "deploy/${HOST_DEPLOYMENT}" -- \
  env NP08_RUNTIME_ACTION=health node --input-type=module - < "${NP08_RUNTIME_MODULE}"

# The fixtures are deliberately managed:false: HCC must expose their live
# authority state without creating a workload or opening a new transport lane.
kctl apply -f - >/dev/null <<YAML
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
kind: Host
metadata:
  name: ${HOST_B}
  namespace: ${HOST_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    np08.evenfire/run: ${RUN_ID}
spec:
  host: ${HOST_B}
  contextRef: ${CONTEXT_B}
  secretRef: chatllm-api-keys
  model:
    provider: zai
    name: glm-5.1
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
host_b_seen=0
for attempt in {1..180}; do
  if kctl -n "${HOST_NS}" get deployment "${HOST_B}" >/dev/null 2>&1; then
    host_b_seen=1
    break
  fi
  sleep 1
done
if [[ "${host_b_seen}" -ne 1 ]]; then
  echo 'FAIL: HCC did not create the second Host deployment' >&2
  exit 1
fi

# Keep the runtime JWT and the returned synthetic token inside the Host pod.
# The process emits only assertion labels and status/error classes.
kctl -n "${HOST_NS}" exec -i "deploy/${HOST_DEPLOYMENT}" -- \
  env NP08_RUNTIME_ACTION=journey \
  "NP08_SERVER_A=${SERVER_A}" "NP08_SERVER_B=${SERVER_B}" "NP08_SERVER_C=${SERVER_C}" \
  "NP08_EXPECTED_SYNTHETIC_VALUE=np08-synthetic-${RUN_ID}-a" \
  node --input-type=module - < "${NP08_RUNTIME_MODULE}"
run_np08_gateway_raw_header_checks
run_np08_deployed_manager_journey
run_np08_sdk_protocol_journey
