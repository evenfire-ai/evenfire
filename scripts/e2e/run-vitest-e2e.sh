#!/usr/bin/env bash
# Run cluster-backed Vitest E2E with the same minikube/port-forward contract
# that the tests expect.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
PF_LOG="${E2E_PF_LOG:-/tmp/clerum-test-e2e-port-forwards.log}"
PF_PID=""
WAIT_FULL_STACK="${E2E_WAIT_FULL_STACK:-}"
DEFAULT_VITEST_SUITES=(
  external-rest-api/security.e2e.test.ts
  rpc-proxy/security.e2e.test.ts
  integration/channel-reader-via-api.test.ts
  integration/contracts.test.ts
  integration/control-api-k8s.test.ts
  integration/mcp-proxy-routing.test.ts
  integration/network-policies.test.ts
  integration/profiles-chain.test.ts
  # Connector credential rotation (issue #223). This list is explicit, not a
  # glob over tests/e2e/ — a suite that is not named here simply never runs,
  # and a gate that never ran a test proves nothing.
  integration/mcp-secret-rotation-failure.test.ts
  integration/mcp-secret-rotation-preservation.test.ts
  integration/mcp-secret-rotation-isolation.test.ts
  integration/mcp-secret-rotation-shared.test.ts
  integration/mcp-secret-rotation-remote.test.ts
  integration/mcp-hcc-upgrade-rollout.test.ts
  integration/mcp-server-readiness-regression.test.ts
  integration/mcp-secrets-access-guard.test.ts
  mcp-host/approval-endpoints.test.ts
  mcp-host/artifacts.e2e.test.ts
  mcp-host/crd.test.ts
  mcp-host/health.test.ts
)

if [[ -z "${WAIT_FULL_STACK}" ]]; then
  if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
    WAIT_FULL_STACK="false"
  else
    WAIT_FULL_STACK="true"
  fi
fi

log() {
  printf '[e2e-vitest] %s\n' "$*"
}

service_url() {
  local env_name="$1"
  local default_port="$2"
  local configured="${!env_name:-}"
  if [[ -n "${configured}" ]]; then
    printf '%s' "${configured%/}"
    return 0
  fi
  printf 'http://127.0.0.1:%s' "${default_port}"
}

die() {
  printf '[e2e-vitest] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "${PF_PID}" 2>/dev/null; then
        wait "${PF_PID}" 2>/dev/null || true
        return 0
      fi
      sleep 0.2
    done
    kill -9 "${PF_PID}" 2>/dev/null || true
    wait "${PF_PID}" 2>/dev/null || true
  fi
}

wait_http() {
  local name="$1"
  local url="$2"
  local deadline="${3:-60}"
  local elapsed=0

  while [[ "${elapsed}" -lt "${deadline}" ]]; do
    if [[ -n "${PF_PID}" ]] && ! kill -0 "${PF_PID}" 2>/dev/null; then
      die "port-forward supervisor exited before ${name} became ready. Check ${PF_LOG}"
    fi
    if curl -fsS --max-time 2 "${url}" >/dev/null 2>&1; then
      log "OK ${name} ${url}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  return 1
}

mint_mcp_host_auth_token() {
  KUBECTL_CONTEXT="${PROFILE}" node <<'NODE'
const { execFileSync } = require('child_process');
const jwt = require('./tests/e2e/node_modules/jsonwebtoken');

const context = process.env.KUBECTL_CONTEXT || 'clerum-test';
const configuredHostRefs = (process.env.E2E_HOST_REF || 'chatllm')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const hostRefs = configuredHostRefs.length > 0 ? configuredHostRefs : ['chatllm'];
const keyB64 = execFileSync(
  'kubectl',
  [
    '--context',
    context,
    'get',
    'secret',
    'control-api-secrets',
    '-n',
    'control-plane',
    '-o',
    'jsonpath={.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}',
  ],
  { encoding: 'utf-8' }
).replace(/'/g, '');

const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8');
const token = jwt.sign(
  {
    sub: 'e2e-vitest-runtime',
    typ: 'user',
    teamId: 'e2e-team',
    scopes: [
      'host:message:invoke',
      'host:status:read',
      'host:task:read',
      'host:activity:read',
      'host:approval:write',
      'host:health:read',
    ],
    hostRefs,
    jti: `e2e-vitest-runtime-${Date.now()}`,
  },
  privateKey,
  {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: 'rpc-proxy',
    expiresIn: '1h',
  }
);

process.stdout.write(token);
NODE
}

cd "${PROJECT_DIR}"

if ! minikube -p "${PROFILE}" status >/dev/null 2>&1; then
  die "minikube profile '${PROFILE}' is not running. Run: make minikube-setup"
fi

if ! kubectl --context="${PROFILE}" cluster-info >/dev/null 2>&1; then
  die "kubectl cannot reach context '${PROFILE}'. Run: make minikube-status"
fi

if [[ ! -x tests/e2e/node_modules/.bin/vitest ]]; then
  log "Installing tests/e2e dependencies with npm ci"
  (cd tests/e2e && npm ci --no-audit --no-fund)
fi

export MINIKUBE_PROFILE="${PROFILE}"
export KUBECONTEXT="${KUBECONTEXT:-${PROFILE}}"
export KUBE_CONTEXT="${KUBE_CONTEXT:-${PROFILE}}"
export KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-${PROFILE}}"
CONTROL_API_HEALTH_BASE="$(service_url CONTROL_API_BASE_URL "${CONTROL_API_PORT:-8090}")"
EXTERNAL_REST_API_HEALTH_BASE="$(service_url EXTERNAL_REST_API_BASE_URL "${EXTERNAL_REST_API_PORT:-8091}")"
RPC_PROXY_HEALTH_BASE="$(service_url RPC_PROXY_BASE_URL "${RPC_PROXY_PORT:-8094}")"
REGISTRY_API_HEALTH_BASE="$(service_url REGISTRY_API_BASE_URL "${REGISTRY_API_PORT:-8085}")"
WORKFLOW_APPROVAL_READER_HEALTH_BASE="$(service_url WORKFLOW_APPROVAL_READER_BASE_URL "${WORKFLOW_APPROVAL_READER_PORT:-8098}")"
MCP_HOST_RUNTIME_HEALTH_BASE="$(service_url MCP_HOST_RUNTIME_BASE_URL "${MCP_HOST_PORT:-8080}")"

export CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-${CONTROL_API_HEALTH_BASE}}"
export CONTROL_API_URL="${CONTROL_API_URL:-${CONTROL_API_BASE_URL}}"
export EXTERNAL_REST_API_BASE_URL="${EXTERNAL_REST_API_BASE_URL:-${EXTERNAL_REST_API_HEALTH_BASE}}"
export EXTERNAL_REST_API_URL="${EXTERNAL_REST_API_URL:-${EXTERNAL_REST_API_BASE_URL}}"
export RPC_PROXY_BASE_URL="${RPC_PROXY_BASE_URL:-${RPC_PROXY_HEALTH_BASE}}"
export RPC_PROXY_URL="${RPC_PROXY_URL:-${RPC_PROXY_BASE_URL}}"
export REGISTRY_API_BASE_URL="${REGISTRY_API_BASE_URL:-${REGISTRY_API_HEALTH_BASE}}"
export WORKFLOW_APPROVAL_READER_BASE_URL="${WORKFLOW_APPROVAL_READER_BASE_URL:-${WORKFLOW_APPROVAL_READER_HEALTH_BASE}}"
export MCP_HOST_RUNTIME_BASE_URL="${MCP_HOST_RUNTIME_BASE_URL:-${MCP_HOST_RUNTIME_HEALTH_BASE}}"
export MCP_HOST_URL="${MCP_HOST_URL:-${MCP_HOST_RUNTIME_BASE_URL}}"

if [[ -z "${MCP_HOST_AUTH_TOKEN:-}" ]]; then
  log "Minting mcp-host runtime auth token for legacy direct-host suites"
  MCP_HOST_AUTH_TOKEN="$(mint_mcp_host_auth_token)" \
    || die "could not mint mcp-host runtime auth token"
  export MCP_HOST_AUTH_TOKEN
fi

if [[ "${E2E_USE_EXISTING_PORT_FORWARDS:-false}" != "true" ]]; then
  log "Starting held minikube port-forwards for Vitest (log: ${PF_LOG})"
  scripts/minikube/pf-all-stack.sh --hold >"${PF_LOG}" 2>&1 &
  PF_PID="$!"
  trap cleanup EXIT INT TERM
else
  log "Using existing port-forwards (E2E_USE_EXISTING_PORT_FORWARDS=true)"
fi

wait_http control-api "${CONTROL_API_HEALTH_BASE}/health" 60 \
  || die "control-api localhost health never became ready. Check ${PF_LOG}"
wait_http external-rest-api "${EXTERNAL_REST_API_HEALTH_BASE}/health" 60 \
  || die "external-rest-api localhost health never became ready. Check ${PF_LOG}"
wait_http rpc-proxy "${RPC_PROXY_HEALTH_BASE}/health" 60 \
  || die "rpc-proxy localhost health never became ready. Check ${PF_LOG}"
if [[ "${WAIT_FULL_STACK}" == "true" ]]; then
  wait_http registry-api "${REGISTRY_API_HEALTH_BASE}/health" 60 \
    || die "registry-api localhost health never became ready. Check ${PF_LOG}"
  wait_http workflow-approval-request-reader "${WORKFLOW_APPROVAL_READER_HEALTH_BASE}/health" 60 \
    || die "workflow-approval-request-reader localhost health never became ready. Check ${PF_LOG}"
else
  log "Skipping optional full-stack health waits (E2E_WAIT_FULL_STACK=false)"
fi
wait_http mcp-host "${MCP_HOST_RUNTIME_HEALTH_BASE}/v1/runtime/health" 90 \
  || die "mcp-host runtime health never became ready. Check ${PF_LOG}"

log "Running Vitest E2E"
cd tests/e2e
if [[ "$#" -gt 0 ]]; then
  npx vitest run "$@"
else
  log "No explicit Vitest specs supplied; running deterministic default suites"
  npx vitest run "${DEFAULT_VITEST_SUITES[@]}"
fi
