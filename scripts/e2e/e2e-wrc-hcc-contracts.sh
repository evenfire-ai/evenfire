#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

WORKFLOW_RECIPE_NS="${WORKFLOW_RECIPE_NS:-sandbox-recipes}"
RECIPE_NS="${RECIPE_NS:-mcp-server}"
WRC_RECIPE_NAME="e2e-wrc-tools-args-status"
HCC_SERVER_NAME="e2e-hcc-coingecko-proxy"
WRC_PF_PID=""
WRC_PF_LOG=""
WRC_PORT=""
E2E_CREATED_RESOURCES=0

cleanup_contract_resources() {
  local cleanup_status=0

  kctl delete workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$WRC_RECIPE_NAME" "$TIMEOUT_DELETE" \
    >/dev/null 2>&1 || cleanup_status=1

  kctl delete mcpserver "$HCC_SERVER_NAME" -n "$RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  kctl delete configmap "${HCC_SERVER_NAME}-nginx-conf" -n "$RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete deployment "$HCC_SERVER_NAME" -n "$RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  kctl delete service "$HCC_SERVER_NAME" -n "$RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1

  return "$cleanup_status"
}

stop_wrc_port_forward() {
  if [ -n "$WRC_PF_PID" ] && kill -0 "$WRC_PF_PID" >/dev/null 2>&1; then
    kill "$WRC_PF_PID" >/dev/null 2>&1 || true
    wait "$WRC_PF_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$WRC_PF_LOG" ]; then
    rm -f "$WRC_PF_LOG"
  fi
}

cleanup_on_exit() {
  local status=$?
  stop_wrc_port_forward
  if [ "${E2E_KEEP_RESOURCES:-0}" != "1" ] && [ "$E2E_CREATED_RESOURCES" = "1" ]; then
    cleanup_contract_resources >/dev/null 2>&1 || {
      if [ "$status" -eq 0 ]; then
        fail "contract E2E cleanup left resources behind"
        status=1
      fi
    }
  fi
  exit "$status"
}

trap cleanup_on_exit EXIT

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "Command '$1' available"
  else
    fail "Command '$1' not found"
    exit 1
  fi
}

start_wrc_port_forward() {
  WRC_PF_LOG="$(mktemp "${TMPDIR:-/tmp}/wrc-port-forward.XXXXXX.log")"
  kctl -n "$CONTROL_NS" port-forward svc/workflow-recipes :8082 >"$WRC_PF_LOG" 2>&1 &
  WRC_PF_PID=$!

  for _ in $(seq 1 80); do
    if ! kill -0 "$WRC_PF_PID" >/dev/null 2>&1; then
      fail "workflow-recipes port-forward exited: $(tr '\n' ' ' < "$WRC_PF_LOG")"
      return 1
    fi
    WRC_PORT="$(sed -nE 's/.*127\.0\.0\.1:([0-9]+) -> 8082.*/\1/p' "$WRC_PF_LOG" | head -1)"
    if [ -n "$WRC_PORT" ]; then
      ok "workflow-recipes port-forward on 127.0.0.1:${WRC_PORT}"
      return 0
    fi
    sleep 0.25
  done

  fail "timed out waiting for workflow-recipes port-forward"
  return 1
}

sign_wrc_status_token() {
  local private_pem
  private_pem="$(kctl -n "$CONTROL_NS" get secret clerum-wrc-signing-key \
    -o 'go-template={{index .data "private.pem" | base64decode}}')"

  PRIVATE_PEM="$private_pem" \
  RECIPE_NAME="$WRC_RECIPE_NAME" \
  RECIPE_NAMESPACE="$WORKFLOW_RECIPE_NS" \
  node <<'NODE'
const crypto = require('crypto')

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

const now = Math.floor(Date.now() / 1000)
const header = { alg: 'RS256', typ: 'JWT' }
const payload = {
  sub: 'coordinator',
  aud: 'clerum-wrc',
  iss: 'clerum-wrc',
  iat: now,
  exp: now + 600,
  jti: crypto.randomUUID(),
  recipeName: process.env.RECIPE_NAME,
  recipeNamespace: process.env.RECIPE_NAMESPACE,
  scopes: ['status_write', 'status_read'],
}
const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), process.env.PRIVATE_PEM)
console.log(`${signingInput}.${signature.toString('base64url')}`)
NODE
}

wait_for_configmap() {
  local ns=$1 name=$2 timeout=${3:-90} elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if kctl get configmap "$name" -n "$ns" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_running_workflowrecipe_status() {
  local timeout=${1:-30} elapsed=0 status_json
  while [ "$elapsed" -lt "$timeout" ]; do
    status_json="$(kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json 2>/dev/null || true)"
    if [ -n "$status_json" ] && STATUS_JSON="$status_json" node <<'NODE' >/dev/null 2>&1
const doc = JSON.parse(process.env.STATUS_JSON)
if (doc.status?.phase !== 'active') {
  throw new Error(`recipe phase is ${doc.status?.phase}; expected active`)
}
if (doc.status?.workflowExecution?.phase !== 'running') {
  throw new Error(`workflow phase is ${doc.status?.workflowExecution?.phase}; expected running`)
}
NODE
    then
      printf '%s' "$status_json"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  printf '%s' "$status_json"
  return 1
}

wait_for_completed_tool_status() {
  local timeout=${1:-30} elapsed=0 status_json
  while [ "$elapsed" -lt "$timeout" ]; do
    status_json="$(kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json 2>/dev/null || true)"
    if [ -n "$status_json" ] && STATUS_JSON="$status_json" node <<'NODE' >/dev/null 2>&1
const doc = JSON.parse(process.env.STATUS_JSON)
const steps = doc.status?.steps ?? []
const step = steps.find(s => s.id === 'tool-step')
if (!step) throw new Error('missing tool-step status')
if (step.phase !== 'completed') throw new Error(`unexpected phase ${step.phase}`)
const tool = step.toolsCalled?.[0]
if (!tool) throw new Error('missing toolsCalled[0]')
if (typeof tool.args !== 'object' || tool.args === null || Array.isArray(tool.args)) {
  throw new Error(`toolsCalled[0].args is not an object: ${typeof tool.args}`)
}
if (tool.args.query !== 'Mythos vs GPT-5.5') throw new Error('args.query not preserved')
if (tool.args.preferences?.comparison !== 'explicit') throw new Error('nested args not preserved')
if (tool.result?.success !== true) throw new Error('internal artifact tool result not preserved')
const artifact = tool.result?.artifact
if (artifact?.name !== 'synthetic-contract-report.pdf') throw new Error('tool artifact name not preserved')
if (artifact?.path !== '/output/synthetic-contract-report.pdf') throw new Error('tool artifact path not preserved')
const statusArtifact = (doc.status?.artifacts ?? []).find(a => a.name === 'synthetic-contract-report.pdf')
if (!statusArtifact) throw new Error('status.artifacts missing synthetic artifact')
if (statusArtifact.path !== '/output/synthetic-contract-report.pdf') {
  throw new Error(`unexpected artifact path ${statusArtifact.path}`)
}
if (doc.status?.workflowExecution?.phase !== 'completed') {
  throw new Error(`workflow phase is ${doc.status?.workflowExecution?.phase}`)
}
if (doc.status?.phase !== 'active') {
  throw new Error(`recipe phase is ${doc.status?.phase}; expected active`)
}
NODE
    then
      printf '%s' "$status_json"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  printf '%s' "$status_json"
  return 1
}

wait_for_pending_preserves_non_terminal_recipe_status() {
  local timeout=${1:-30} elapsed=0 status_json
  while [ "$elapsed" -lt "$timeout" ]; do
    status_json="$(kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json 2>/dev/null || true)"
    if [ -n "$status_json" ] && STATUS_JSON="$status_json" node <<'NODE' >/dev/null 2>&1
const doc = JSON.parse(process.env.STATUS_JSON)
const recipePhase = doc.status?.phase
if (recipePhase === 'failed' || recipePhase === 'deleted') {
  throw new Error(`recipe phase is ${recipePhase}; expected non-terminal`)
}
if (doc.status?.workflowExecution?.phase !== 'pending') {
  throw new Error(`workflow phase is ${doc.status?.workflowExecution?.phase}; expected pending`)
}
NODE
    then
      printf '%s' "$status_json"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  printf '%s' "$status_json"
  return 1
}

header "Phase 0 - Prerequisites"
require_safe_kube_context
require_command curl
require_command jq
require_command node
kctl cluster-info >/dev/null
ok "Kubernetes cluster reachable"
kctl get crd workflowrecipes.clerum.io >/dev/null
ok "WorkflowRecipe CRD installed"
kctl get crd mcpservers.clerum.io >/dev/null
ok "McpServer CRD installed"
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "workflow-recipes deployment exists"
kctl get deploy host-context-controller -n "$CONTROL_NS" >/dev/null
ok "host-context-controller deployment exists"

header "Phase 1 - Clean slate"
if cleanup_contract_resources; then
  ok "previous contract E2E resources removed"
else
  fail "failed to remove previous contract E2E resources"
  exit 1
fi

header "Phase 2 - WRC toolsCalled args status contract"
kctl apply -f - <<YAML >/dev/null
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WRC_RECIPE_NAME}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    clerum.io/workflow-run-id: 00000000-0000-4000-8000-0000000000c1
    clerum.io/trigger-source: e2e
    clerum.io/on-demand: "true"
    clerum.io/workflow-actor-type: admin
    clerum.io/workflow-actor-id: e2e-wrc-status-contract
    e2e.clerum.io/suite: wrc-hcc-contracts
spec:
  agent:
    provider: zai
    model: glm-4.7
  triggers:
    onDemand: {}
  steps:
    - id: tool-step
      instruction: "Synthetic status-contract step for toolsCalled args validation."
YAML
E2E_CREATED_RESOURCES=1
ok "synthetic WorkflowRecipe applied"

start_wrc_port_forward
token="$(sign_wrc_status_token)"

running_response_file="$(mktemp "${TMPDIR:-/tmp}/wrc-running-response.XXXXXX.json")"
running_http_status="$(curl -sS -o "$running_response_file" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${WRC_PORT}/api/v1/workflow/${WRC_RECIPE_NAME}/status" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary '{"workflowPhase":"running"}')"
if [ "$running_http_status" = "200" ] && jq -e '.accepted == true' "$running_response_file" >/dev/null; then
  ok "workflow-recipes accepted workflow running status update"
else
  fail "workflow-recipes rejected workflow running update (HTTP ${running_http_status}): $(cat "$running_response_file")"
  rm -f "$running_response_file"
  exit 1
fi
rm -f "$running_response_file"

if wait_for_running_workflowrecipe_status >/dev/null; then
  ok "WorkflowRecipe becomes active when workflow execution is running"
else
  fail "WorkflowRecipe did not become active on running workflow execution"
  kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

step_running_response_file="$(mktemp "${TMPDIR:-/tmp}/wrc-step-running-response.XXXXXX.json")"
step_running_payload='{"stepId":"tool-step","phase":"running","executor":"agentic"}'
step_running_http_status="$(curl -sS -o "$step_running_response_file" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${WRC_PORT}/api/v1/workflow/${WRC_RECIPE_NAME}/status" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary "$step_running_payload")"
if [ "$step_running_http_status" = "200" ] && jq -e '.accepted == true' "$step_running_response_file" >/dev/null; then
  ok "workflow-recipes accepted running step status update"
else
  fail "workflow-recipes rejected running step update (HTTP ${step_running_http_status}): $(cat "$step_running_response_file")"
  rm -f "$step_running_response_file"
  exit 1
fi
rm -f "$step_running_response_file"

premature_completed_response_file="$(mktemp "${TMPDIR:-/tmp}/wrc-premature-completed-response.XXXXXX.json")"
premature_completed_http_status="$(curl -sS -o "$premature_completed_response_file" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${WRC_PORT}/api/v1/workflow/${WRC_RECIPE_NAME}/status" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary '{"workflowPhase":"completed"}')"
if [ "$premature_completed_http_status" = "409" ] &&
  jq -e '(.error | test("before all declared steps complete")) and (.incompleteSteps | index("tool-step"))' "$premature_completed_response_file" >/dev/null; then
  ok "workflow-recipes rejects completed workflow status while declared step is still running"
else
  fail "workflow-recipes accepted premature workflow completion (HTTP ${premature_completed_http_status}): $(cat "$premature_completed_response_file")"
  rm -f "$premature_completed_response_file"
  exit 1
fi
rm -f "$premature_completed_response_file"

status_after_rejected_completion="$(kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json)"
if STATUS_JSON="$status_after_rejected_completion" node <<'NODE' >/dev/null 2>&1
const doc = JSON.parse(process.env.STATUS_JSON)
const step = (doc.status?.steps ?? []).find((candidate) => candidate.id === 'tool-step')
if (doc.status?.workflowExecution?.phase !== 'running') {
  throw new Error(`workflow phase is ${doc.status?.workflowExecution?.phase}; expected running`)
}
if (step?.phase !== 'running') {
  throw new Error(`tool-step phase is ${step?.phase}; expected running`)
}
NODE
then
  ok "rejected premature completion leaves workflow and step running"
else
  fail "premature completion rejection changed persisted workflow status unexpectedly"
  kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

payload="$(node <<'NODE'
console.log(JSON.stringify({
  stepId: 'tool-step',
  phase: 'completed',
  output: 'status contract accepted object args',
  executor: 'agentic',
  modelUsed: 'synthetic-minikube-contract-test',
  toolsCalled: [
    {
      serverName: 'synthetic-mcp',
      toolName: 'synthetic_tool',
      args: {
        query: 'Mythos vs GPT-5.5',
        preferences: {
          comparison: 'explicit',
          steps: ['research', 'compare', 'summarize'],
        },
      },
      result: {
        success: true,
        artifact: {
          name: 'synthetic-contract-report.pdf',
          format: 'pdf',
          path: '/output/synthetic-contract-report.pdf',
          sizeBytes: 128,
          createdAt: '2026-05-13T00:00:00.000Z',
        },
      },
      durationMs: 12,
    },
  ],
}))
NODE
)"
response_file="$(mktemp "${TMPDIR:-/tmp}/wrc-status-response.XXXXXX.json")"
http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${WRC_PORT}/api/v1/workflow/${WRC_RECIPE_NAME}/status" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary "$payload")"
if [ "$http_status" = "200" ] && jq -e '.accepted == true' "$response_file" >/dev/null; then
  ok "workflow-recipes accepted toolsCalled args object status update"
else
  fail "workflow-recipes rejected status update (HTTP ${http_status}): $(cat "$response_file")"
  rm -f "$response_file"
  exit 1
fi
rm -f "$response_file"

if status_json="$(wait_for_completed_tool_status)"; then
  ok "WorkflowRecipe status persisted toolsCalled args and artifact metadata"
else
  fail "WorkflowRecipe status did not preserve toolsCalled args and artifact metadata"
  kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

pending_response_file="$(mktemp "${TMPDIR:-/tmp}/wrc-pending-response.XXXXXX.json")"
pending_http_status="$(curl -sS -o "$pending_response_file" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${WRC_PORT}/api/v1/workflow/${WRC_RECIPE_NAME}/status" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary '{"workflowPhase":"pending"}')"
if [ "$pending_http_status" = "200" ] && jq -e '.accepted == true' "$pending_response_file" >/dev/null; then
  ok "workflow-recipes accepted workflow pending status update"
else
  fail "workflow-recipes rejected workflow pending update (HTTP ${pending_http_status}): $(cat "$pending_response_file")"
  rm -f "$pending_response_file"
  exit 1
fi
rm -f "$pending_response_file"

if wait_for_pending_preserves_non_terminal_recipe_status >/dev/null; then
  ok "WorkflowRecipe stays non-terminal when workflow execution is pending"
else
  fail "WorkflowRecipe did not stay non-terminal on pending workflow execution"
  kctl get workflowrecipe "$WRC_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi

header "Phase 3 - HCC remote proxy path contract"
kctl apply -f - <<YAML >/dev/null
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${HCC_SERVER_NAME}
  namespace: ${RECIPE_NS}
  labels:
    e2e.clerum.io/suite: wrc-hcc-contracts
spec:
  contextRef: ${CONTEXT_NAME}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://${HCC_SERVER_NAME}.${RECIPE_NS}.svc.cluster.local:3000/mcp
    port: 3000
  remote:
    baseUrl: https://mcp.api.coingecko.com/mcp
  egressBindings:
    - dns: mcp.api.coingecko.com
      port: 443
      protocol: TCP
YAML
ok "synthetic remote McpServer applied"

if wait_for_configmap "$RECIPE_NS" "${HCC_SERVER_NAME}-nginx-conf" 90; then
  ok "HCC rendered remote nginx ConfigMap"
else
  fail "HCC did not render remote nginx ConfigMap"
  kctl logs deploy/host-context-controller -n "$CONTROL_NS" --tail=80 2>/dev/null || true
  exit 1
fi

nginx_conf="$(kctl get configmap "${HCC_SERVER_NAME}-nginx-conf" -n "$RECIPE_NS" \
  -o 'go-template={{index .data "default.conf.template"}}')"
if printf '%s\n' "$nginx_conf" | grep -Fq 'location /mcp {'; then
  ok "remote proxy matches local /mcp endpoint path"
else
  fail "remote proxy is missing location /mcp"
  printf '%s\n' "$nginx_conf"
  exit 1
fi

if printf '%s\n' "$nginx_conf" | grep -Fq 'proxy_pass https://mcp.api.coingecko.com/mcp;'; then
  ok "remote proxy keeps upstream CoinGecko /mcp baseUrl"
else
  fail "remote proxy is missing upstream CoinGecko /mcp proxy_pass"
  printf '%s\n' "$nginx_conf"
  exit 1
fi

if printf '%s\n' "$nginx_conf" | grep -Fq 'location / {'; then
  fail "remote proxy still uses catch-all location / for a /mcp upstream"
  printf '%s\n' "$nginx_conf"
  exit 1
else
  ok "remote proxy does not use catch-all location for CoinGecko /mcp"
fi

if wait_for_deployment "$RECIPE_NS" "$HCC_SERVER_NAME" 120; then
  ok "remote proxy deployment became ready"
else
  fail "remote proxy deployment did not become ready"
  kctl describe deployment "$HCC_SERVER_NAME" -n "$RECIPE_NS" 2>/dev/null || true
  kctl get pods -n "$RECIPE_NS" -l "app=${HCC_SERVER_NAME}" -o wide 2>/dev/null || true
  exit 1
fi

if cleanup_contract_resources; then
  ok "contract E2E resources cleaned up"
else
  fail "contract E2E cleanup left resources behind"
fi

print_results
