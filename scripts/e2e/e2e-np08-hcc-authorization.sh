#!/usr/bin/env bash
set -euo pipefail

# Local Minikube E2E for the PR1 NP-08 caller-binding contract.
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

case "${context}" in
  clerum-codex-np-08-cross-context-mcp-token-plan-*) ;;
  *)
    echo "FAIL: refusing non branch-owned NP-08 Minikube context" >&2
    exit 2
    ;;
esac

for command_name in kubectl jq; do
  command -v "${command_name}" >/dev/null || {
    echo "FAIL: required command missing: ${command_name}" >&2
    exit 1
  }
done

kctl() {
  kubectl --context="${context}" "$@"
}

MCP_NS='mcp-server'
HOST_NS='mcp-host'
CONTROL_NS='control-plane'
HOST_DEPLOYMENT='chatllm'
CONTEXT_A='context1'
CONTEXT_B='np08-e2e-context-b'
SERVER_A='np08-e2e-server-a'
SERVER_B='np08-e2e-server-b'
SECRET_A='np08-e2e-server-a-auth'
SECRET_B='np08-e2e-server-b-auth'

cleanup() {
  local status=$?
  set +e
  if [[ -n "${original_servers:-}" ]]; then
    local restore_patch
    restore_patch="$(jq -cn --argjson servers "${original_servers}" '{spec:{mcpServers:$servers}}')"
    kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=merge -p "${restore_patch}" >/dev/null 2>&1
  fi
  kctl -n "${MCP_NS}" delete mcpserver "${SERVER_A}" "${SERVER_B}" --ignore-not-found >/dev/null 2>&1
  kctl -n "${MCP_NS}" delete context "${CONTEXT_B}" --ignore-not-found >/dev/null 2>&1
  kctl -n "${MCP_NS}" delete secret "${SECRET_A}" "${SECRET_B}" --ignore-not-found >/dev/null 2>&1
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

original_servers="$(kctl -n "${MCP_NS}" get context "${CONTEXT_A}" -o json | jq -c '.spec.mcpServers // []')"

# The fixtures are deliberately managed:false: HCC must expose their live
# authority state without creating a workload or opening a new transport lane.
kctl -n "${MCP_NS}" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_A}
  namespace: ${MCP_NS}
type: Opaque
stringData:
  token: np08-synthetic-a
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_B}
  namespace: ${MCP_NS}
type: Opaque
stringData:
  token: np08-synthetic-b
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CONTEXT_B}
  namespace: ${MCP_NS}
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
YAML

# Append only the fixture owned by this test, preserving the original Context
# allowlist for cleanup and for any concurrently seeded local E2E data.
kctl -n "${MCP_NS}" patch context "${CONTEXT_A}" --type=json \
  -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"${SERVER_A}\"}]" >/dev/null

echo 'E2E setup: waiting for HCC to observe the synthetic Context/McpServer fixtures'

# Keep the runtime JWT and the returned synthetic token inside the Host pod.
# The process emits only assertion labels and status/error classes.
kctl -n "${HOST_NS}" exec -i "deploy/${HOST_DEPLOYMENT}" -- node - <<'NODE'
const base = 'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081'
let accessToken = process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN
const refreshToken = process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN
const workflowToken = process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
const serverA = 'np08-e2e-server-a'
const serverB = 'np08-e2e-server-b'
const expectedSyntheticToken = 'np08-synthetic-a'

if (!accessToken || !refreshToken || !workflowToken) {
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
  if (JSON.stringify(body).includes('secretRef') || JSON.stringify(body).includes('np08-synthetic-a')) {
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
  body: JSON.stringify({ serverName: 'mongodb-mcp-stack-mongodb-mcp-server' }),
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
