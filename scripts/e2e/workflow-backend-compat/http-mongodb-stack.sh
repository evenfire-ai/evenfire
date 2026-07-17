#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Test: MongoDB MCP Stack — Full Integration via WorkflowRecipe
# ═══════════════════════════════════════════════════════════════════════
#
# Tests the complete lifecycle of a composite WorkflowRecipe:
#   1. MongoDB StatefulSet (sandbox-recipes) with PVC persistence
#   2. MongoDB MCP Server Deployment (mcp-server) via MCP Delegation
#   3. Cross-namespace NetworkPolicies via bindings
#   4. mcp-proxy tool listing and MongoDB tool execution
#
# Prerequisites:
#   - minikube profile "clerum-test" running with Calico CNI
#   - CRDs installed (helm install clerum-crds)
#   - HCC, API Gateway, WRC Controller deployed in control-plane
#   - MCP Host deployed in mcp-host with ZAI provider
#   - Images loaded: mongodb/mongodb-community-server:7.0-ubi8,
#     mongodb/mongodb-mcp-server:latest
#   - Context CRD "context1" exists in mcp-server namespace
#
# Usage:
#   ./scripts/e2e/workflow-backend-compat/http-mongodb-stack.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
RECIPE_FILE="workflow-recipes/samples/mongodb-mcp-stack.yaml"
RECIPE_NAME="mongodb-mcp-stack"
SANDBOX_NS="sandbox-recipes"
RECIPE_NS="$SANDBOX_NS"
MCP_SERVER_NS="mcp-server"
MCP_HOST_NS="mcp-host"
CONTROL_NS="control-plane"
TIMEOUT_POD=120        # seconds to wait for pod readiness
TIMEOUT_DISCOVERY=60   # seconds to wait for mcp-proxy routing
POLL_INTERVAL=3        # seconds between poll attempts
E2E_KUBECONTEXT="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-}}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"

current_e2e_context() {
  if [ -n "$E2E_KUBECONTEXT" ]; then
    printf "%s\n" "$E2E_KUBECONTEXT"
  else
    "$KUBECTL_BIN" config current-context 2>/dev/null
  fi
}

kctl() {
  if [ -n "$E2E_KUBECONTEXT" ]; then
    "$KUBECTL_BIN" --context "$E2E_KUBECONTEXT" "$@"
  else
    "$KUBECTL_BIN" "$@"
  fi
}

# Auto-detect MCP Host deployment name (chatllm or mcp-host)
_MCP_HOST_DEPLOY=""
_detect_mcp_host_deploy() {
  if [ -n "$_MCP_HOST_DEPLOY" ]; then echo "$_MCP_HOST_DEPLOY"; return; fi
  for name in mcp-host chatllm; do
    if kctl get deploy "$name" -n "$MCP_HOST_NS" &>/dev/null; then
      _MCP_HOST_DEPLOY="$name"
      echo "$name"
      return
    fi
  done
  echo ""
}

# Detect minikube context (Calico CNI has partial NP enforcement)
_is_minikube() {
  local context
  context="$(current_e2e_context || true)"
  printf "%s\n" "$context" | grep -Eqi "minikube|clerum-test|^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$"
}

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

pass=0
fail=0
total=0

# ─── Helpers ─────────────────────────────────────────────────────────
log()   { echo -e "${CYAN}[E2E]${NC} $*"; }
ok()    { pass=$((pass+1)); total=$((total+1)); echo -e "${GREEN}  ✅ PASS${NC} — $*"; }
fail()  { fail=$((fail+1)); total=$((total+1)); echo -e "${RED}  ❌ FAIL${NC} — $*"; }
warn()  { echo -e "${YELLOW}  ⚠️  WARN${NC} — $*"; }
header(){ echo -e "\n${BOLD}═══ $* ═══${NC}"; }

wait_for_pod() {
  local ns=$1 label=$2 timeout=$3
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local ready
    ready=$(kctl get pods -n "$ns" -l "$label" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [ "$ready" = "True" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_statefulset() {
  local ns=$1 name=$2 timeout=$3
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local ready
    ready=$(kctl get statefulset "$name" -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    if [ "${ready:-0}" -ge 1 ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# ─── Cleanup function ───────────────────────────────────────────────
cleanup() {
  header "Cleanup"
  log "Deleting WorkflowRecipe ${RECIPE_NAME}..."
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true

  # Wait for finalizer to clean up
  sleep 5

  # Clean up any orphaned resources
  kctl delete statefulset mongodb -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc mongodb mongodb-headless -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete deployment mongodb-mcp-server -n "$MCP_SERVER_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "${RECIPE_NAME}-mongodb-mcp-server" -n "$MCP_SERVER_NS" --ignore-not-found 2>/dev/null || true
  kctl delete mcpserver "${RECIPE_NAME}-mongodb-mcp-server" -n "$MCP_SERVER_NS" --ignore-not-found 2>/dev/null || true

  # Clean up NetworkPolicies created by HCC for this recipe
  kctl delete networkpolicy -n "$MCP_SERVER_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$MCP_HOST_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true

  # Remove manually-created NPs from previous test
  kctl delete networkpolicy mongodb-server-egress-to-db -n "$MCP_SERVER_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy allow-mcp-server-to-mongodb -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true

  # Keep permanent seed resources out of compatibility cleanup. Context routing
  # for later suites depends on the shared seeded server and allowlist entries.

  log "Cleanup complete"
}

# ─── Handle --cleanup-only flag ─────────────────────────────────────
if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
# TEST EXECUTION
# ═══════════════════════════════════════════════════════════════════════

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  E2E Test: MongoDB MCP Stack — Composite WorkflowRecipe    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Phase 0: Prerequisites ─────────────────────────────────────────
header "Phase 0 — Prerequisites"

# Check cluster
if kctl cluster-info &>/dev/null; then
  ok "Kubernetes cluster reachable"
else
  fail "Cannot reach Kubernetes cluster"
  exit 1
fi

# Check namespaces
for ns in "$RECIPE_NS" "$MCP_SERVER_NS" "$MCP_HOST_NS" "$CONTROL_NS"; do
  if kctl get ns "$ns" &>/dev/null; then
    ok "Namespace '$ns' exists"
  else
    fail "Namespace '$ns' not found"
  fi
done

# Check CRDs
for crd in workflowrecipes.clerum.io mcpservers.clerum.io contexts.clerum.io hosts.clerum.io; do
  if kctl get crd "$crd" &>/dev/null; then
    ok "CRD '$crd' installed"
  else
    fail "CRD '$crd' not found"
  fi
done

# Check control-plane pods
for deploy in host-context-controller host-context-controller-api-gateway workflow-recipes; do
  if kctl get deploy "$deploy" -n "$CONTROL_NS" &>/dev/null; then
    ok "Deployment '$deploy' exists in control-plane"
  else
    fail "Deployment '$deploy' not found in control-plane"
  fi
done

# Check MCP Host (auto-detect deployment name)
_detect_mcp_host_deploy
if [ -n "$_MCP_HOST_DEPLOY" ]; then
  ok "MCP Host deployment '${_MCP_HOST_DEPLOY}' exists"
else
  fail "MCP Host not found (tried: mcp-host, chatllm)"
fi

# Check Context CRD
if kctl get context context1 -n "$MCP_SERVER_NS" &>/dev/null; then
  ok "Context 'context1' exists"
else
  fail "Context 'context1' not found"
fi

# ─── Phase 1: Cleanup previous state ────────────────────────────────
header "Phase 1 — Clean Slate"
cleanup

# ─── Phase 2: Apply WorkflowRecipe ──────────────────────────────────
header "Phase 2 — Apply Composite WorkflowRecipe"

log "Applying ${RECIPE_FILE}..."
if kctl apply -f "$RECIPE_FILE" 2>&1; then
  ok "WorkflowRecipe '${RECIPE_NAME}' applied"
else
  fail "Failed to apply WorkflowRecipe"
  exit 1
fi

# ─── Phase 3: Verify MongoDB StatefulSet in sandbox-recipes ─────────
header "Phase 3 — MongoDB Database (sandbox-recipes)"

log "Waiting for MongoDB StatefulSet to be ready (${TIMEOUT_POD}s)..."
if wait_for_statefulset "$SANDBOX_NS" "mongodb" "$TIMEOUT_POD"; then
  ok "MongoDB StatefulSet ready in sandbox-recipes"
else
  fail "MongoDB StatefulSet not ready (timeout ${TIMEOUT_POD}s)"
  kctl get statefulset -n "$SANDBOX_NS" 2>/dev/null || true
  kctl get pods -n "$SANDBOX_NS" 2>/dev/null || true
  kctl describe pod -n "$SANDBOX_NS" -l app=mongodb 2>/dev/null | tail -20 || true
fi

# Check PVC
pvc_status=$(kctl get pvc -n "$SANDBOX_NS" -l app=mongodb -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
if [ "$pvc_status" = "Bound" ]; then
  ok "MongoDB PVC bound in sandbox-recipes"
else
  # StatefulSet PVCs use name pattern: <vct-name>-<sts-name>-<ordinal>
  pvc_status=$(kctl get pvc "mongodb-data-mongodb-0" -n "$SANDBOX_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [ "$pvc_status" = "Bound" ]; then
    ok "MongoDB PVC 'mongodb-data-mongodb-0' bound in sandbox-recipes"
  else
    fail "MongoDB PVC not bound (status: ${pvc_status:-not found})"
  fi
fi

# Verify headless service
if kctl get svc mongodb-headless -n "$SANDBOX_NS" &>/dev/null; then
  ok "MongoDB headless Service exists"
else
  warn "MongoDB headless Service not found (checking 'mongodb' service)"
  if kctl get svc mongodb -n "$SANDBOX_NS" &>/dev/null; then
    ok "MongoDB ClusterIP Service exists"
  else
    fail "No MongoDB Service found"
  fi
fi

# Test MongoDB connectivity
log "Testing MongoDB ping..."
if kctl exec mongodb-0 -n "$SANDBOX_NS" -- mongosh --eval "db.runCommand({ping:1})" --quiet 2>/dev/null | grep -q '"ok" : 1\|ok: 1'; then
  ok "MongoDB responds to ping"
else
  fail "MongoDB does not respond to ping"
fi

# Test MongoDB write/read
log "Testing MongoDB write/read..."
write_result=$(kctl exec mongodb-0 -n "$SANDBOX_NS" -- mongosh --eval "
  db = db.getSiblingDB('clerum');
  db.e2e_test.insertOne({test: 'stack', ts: new Date()});
  JSON.stringify(db.e2e_test.findOne({test: 'stack'}));
" --quiet 2>/dev/null || echo "")
if echo "$write_result" | grep -q '"test":"stack"'; then
  ok "MongoDB write/read verified"
else
  fail "MongoDB write/read failed"
fi

# ─── Phase 4: Verify MCP Delegation ─────────────────────────────────
header "Phase 4 — MCP Delegation (McpServer CRD + Service)"

# Check McpServer CRD was auto-created
mcp_server_name="${RECIPE_NAME}-mongodb-mcp-server"
if kctl get mcpserver "$mcp_server_name" -n "$MCP_SERVER_NS" &>/dev/null; then
  ok "McpServer CRD '${mcp_server_name}' auto-created by WRC"
else
  fail "McpServer CRD '${mcp_server_name}' not found"
fi

# Verify McpServer is managed: false
managed=$(kctl get mcpserver "$mcp_server_name" -n "$MCP_SERVER_NS" -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
if [ "$managed" = "false" ]; then
  ok "McpServer managed=false (WRC manages deployment, not HCC)"
else
  fail "McpServer managed='$managed' (expected: false)"
fi

# Check recipe-bindings annotation
bindings_annotation=$(kctl get mcpserver "$mcp_server_name" -n "$MCP_SERVER_NS" -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
if echo "$bindings_annotation" | grep -q '"port":27017'; then
  ok "McpServer has recipe-bindings annotation (port 27017)"
else
  fail "McpServer recipe-bindings annotation not found or incomplete"
fi

# Check transport Service
if kctl get svc "$mcp_server_name" -n "$MCP_SERVER_NS" &>/dev/null; then
  ok "Transport Service '${mcp_server_name}' created"
else
  fail "Transport Service '${mcp_server_name}' not found"
fi

# Verify the Context that the delegated McpServer actually references.
context_ref=$(kctl get mcpserver "$mcp_server_name" -n "$MCP_SERVER_NS" \
  -o jsonpath='{.spec.contextRef}' 2>/dev/null || echo "")
elapsed=0
context_timeout="${TIMEOUT_CONTEXT:-180}"
context_allowlisted=false
while [ "$elapsed" -lt "$context_timeout" ]; do
  context_servers=$(kctl get context "$context_ref" -n "$MCP_SERVER_NS" \
    -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "")
  if [ -n "$context_ref" ] && printf "%s" "$context_servers" | tr '[],"' '    ' | tr ' ' '\n' | grep -Fxq "$mcp_server_name"; then
    context_allowlisted=true
    break
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done
if [ "$context_allowlisted" = "true" ]; then
  ok "Context '${context_ref}' allowlist includes '${mcp_server_name}'"
else
  fail "Context '${context_ref:-<missing>}' does not include '${mcp_server_name}' after ${context_timeout}s"
fi

# ─── Phase 5: Verify MongoDB MCP Server Deployment ──────────────────
header "Phase 5 — MongoDB MCP Server (mcp-server namespace)"

log "Waiting for MongoDB MCP Server pod to be ready (${TIMEOUT_POD}s)..."
if wait_for_pod "$MCP_SERVER_NS" "app=mongodb-mcp-server" "$TIMEOUT_POD"; then
  ok "MongoDB MCP Server pod ready in mcp-server"
else
  fail "MongoDB MCP Server pod not ready (timeout ${TIMEOUT_POD}s)"
  kctl get pods -n "$MCP_SERVER_NS" -l app=mongodb-mcp-server 2>/dev/null || true
  kctl describe pod -n "$MCP_SERVER_NS" -l app=mongodb-mcp-server 2>/dev/null | tail -20 || true
fi

# Check MCP Server logs for successful start
mcp_logs=$(kctl logs -n "$MCP_SERVER_NS" -l app=mongodb-mcp-server --tail=20 2>/dev/null || echo "")
if echo "$mcp_logs" | grep -q "Streamable HTTP Transport started"; then
  ok "MongoDB MCP Server transport started"
else
  fail "MongoDB MCP Server transport did not start"
fi

# ─── Phase 6: Verify NetworkPolicies ────────────────────────────────
header "Phase 6 — NetworkPolicy Enforcement"

# Test 1: Generic pod in mcp-server CANNOT reach MongoDB (deny-all)
log "Testing deny-all enforcement..."
if kctl run np-test-deny --image=busybox --rm -i --restart=Never -n "$MCP_SERVER_NS" \
   --timeout=10s -- nc -z -w3 "mongodb.${SANDBOX_NS}.svc.cluster.local" 27017 &>/dev/null 2>&1; then
  if _is_minikube; then
    warn "Deny-all NOT enforced (expected on minikube/Calico — MongoDB reachable)"
  else
    fail "Deny-all NOT enforced: generic pod reached MongoDB"
  fi
else
  ok "Deny-all enforced: generic pod cannot reach MongoDB"
fi

# Test 2: MongoDB MCP Server CAN reach MongoDB (binding NP or egress allowed)
log "Testing MCP server → MongoDB connectivity..."
mcp_pod=$(kctl get pod -n "$MCP_SERVER_NS" -l app=mongodb-mcp-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$mcp_pod" ]; then
  connect_result=$(kctl exec "$mcp_pod" -n "$MCP_SERVER_NS" -- node -e "
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(5000);
    s.connect(27017, 'mongodb.${SANDBOX_NS}.svc.cluster.local', () => { console.log('CONNECTED'); s.destroy(); });
    s.on('error', e => { console.log('ERROR:' + e.message); s.destroy(); });
    s.on('timeout', () => { console.log('TIMEOUT'); s.destroy(); });
  " 2>&1 || echo "ERROR")
  if echo "$connect_result" | grep -q "CONNECTED"; then
    ok "MCP server can reach MongoDB:27017 (binding NP works)"
  else
    fail "MCP server cannot reach MongoDB:27017 (result: $connect_result)"
  fi
else
  fail "Cannot test connectivity: MCP server pod not found"
fi

# Test 3: Arbitrary internet egress blocked
log "Testing internet egress blocked..."
if [ -n "$mcp_pod" ]; then
  egress_result=$(kctl exec "$mcp_pod" -n "$MCP_SERVER_NS" -- node -e "
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(3000);
    s.connect(80, '1.1.1.1', () => { console.log('OPEN'); s.destroy(); });
    s.on('error', e => { console.log('BLOCKED'); s.destroy(); });
    s.on('timeout', () => { console.log('BLOCKED'); s.destroy(); });
  " 2>&1 || echo "BLOCKED")
  if echo "$egress_result" | grep -q "BLOCKED"; then
    ok "Internet egress blocked for MCP server"
  else
    if _is_minikube; then
      warn "Internet egress NOT blocked (expected on minikube/Calico)"
    else
      fail "Internet egress NOT blocked for MCP server"
    fi
  fi
fi

# ─── Phase 7: Verify mcp-proxy tools/list + tools/call ──────────────
header "Phase 7 — mcp-proxy MongoDB Tool Contract"

log "Verifying ${mcp_server_name}.list-databases through mcp-proxy..."
result=$(kctl exec -i -n "$MCP_SERVER_NS" deploy/mcp-proxy \
  -- node - "$mcp_server_name" <<'NODE' 2>/dev/null || echo '{"ok":false,"stage":"exec","error":"kctl exec failed"}'
const http = require('http');
const serverName = process.argv[2];

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('data: ')) {
        return JSON.parse(lines[i].slice(6));
      }
    }
    return { raw: text };
  }
}

function postMcp(id, method, params, sessionId) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  return new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost',
      port: 8083,
      path: `/servers/${serverName}/mcp`,
      method: 'POST',
      headers,
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        sessionId: res.headers['mcp-session-id'],
        body: text,
        parsed: parseBody(text),
      }));
    });
    req.on('error', error => resolve({ status: 0, error: error.message, body: '' }));
    req.write(body);
    req.end();
  });
}

(async () => {
  const init = await postMcp(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e-mongodb-backend-compat', version: '1.0.0' },
  });
  if (init.status !== 200 && init.status !== 201) {
    console.log(JSON.stringify({ ok: false, stage: 'initialize', status: init.status, body: init.body }));
    return;
  }
  const sessionId = init.sessionId || null;

  const listed = await postMcp(2, 'tools/list', {}, sessionId);
  if (listed.status !== 200) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/list', status: listed.status, body: listed.body }));
    return;
  }
  const tools = listed.parsed?.result?.tools || [];
  const names = tools.map(tool => tool.name);
  if (!names.includes('list-databases')) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/list', status: listed.status, tools: names }));
    return;
  }

  const called = await postMcp(3, 'tools/call', {
    name: 'list-databases',
    arguments: {},
  }, sessionId);
  if (called.status !== 200) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/call', status: called.status, body: called.body }));
    return;
  }
  const text = (called.parsed?.result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
  if (!text.includes('database')) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/call', status: called.status, output: text }));
    return;
  }

  console.log(JSON.stringify({ ok: true, tools: names, output: text }));
})();
NODE
)

ok_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")
tools_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(','.join(json.load(sys.stdin).get('tools',[])))" 2>/dev/null || echo "")
output_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('output',''))" 2>/dev/null || echo "")
stage_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stage',''))" 2>/dev/null || echo "")
status_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

if [ "$ok_value" = "True" ]; then
  ok "mcp-proxy listed MongoDB tools and list-databases returned database output"
  log "tools: ${tools_value}; output chars=${#output_value}; expected database signal matched"
else
  fail "mcp-proxy MongoDB contract failed at ${stage_value:-unknown} HTTP ${status_value:-unknown}: $(printf "%s" "$result" | head -c 260)"
fi

# ─── Results ─────────────────────────────────────────────────────────
header "Results"

echo ""
echo -e "${BOLD}Total: ${total}  |  ${GREEN}Pass: ${pass}${NC}  |  ${RED}Fail: ${fail}${NC}"
echo ""

if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${fail} test(s) failed${NC}"
  exit 1
fi
