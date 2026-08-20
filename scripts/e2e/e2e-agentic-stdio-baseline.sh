#!/usr/bin/env bash
# E2E: agentic-stdio-baseline — Pure compute stdio MCP server (no backend)
#
# Validates:
#   1. stdio transport type in WorkflowRecipe
#   2. HCC injects stdio-bridge sidecar (managed: true)
#   3. HCC marks the delegated server ready
#   4. mcp-proxy routes a real tools/list and tools/call to stdio-bridge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_FILE="workflow-recipes/samples/stdio-mcp-calculator.yaml"
RECIPE_NAME="stdio-mcp-calculator"
MCP_ID="calculator"
MCP_SERVER_NAME="${RECIPE_NAME}-${MCP_ID}"
RECIPE_CONTEXT=""

wait_for_mcpserver() {
  local name=$1 ns=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    if kctl get mcpserver "$name" -n "$ns" &>/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_context_allowlist() {
  local context_name=$1 server_name=$2 ns=$3 timeout=$4 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local servers
    servers=$(kctl get context "$context_name" -n "$ns" \
      -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "")
    if echo "$servers" | grep -q "$server_name"; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

resolve_recipe_context() {
  local context_ref
  context_ref=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.spec.contextRef}' 2>/dev/null || true)
  if [ -n "$context_ref" ]; then
    printf "%s" "$context_ref"
  else
    printf "wf-%s" "$RECIPE_NAME"
  fi
}

wait_for_hcc_server_ready() {
  local server_name=$1 timeout=$2 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local ready
    ready=$(kctl get mcpserver "$server_name" -n "$RECIPE_NS" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    if [ "$ready" = "True" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_stdio_external_egress_ready() {
  local server_name=$1 dns=$2 port=$3 timeout=$4 elapsed=0
  local policy_name="ext-egress-${server_name}-${dns}-${port}"
  while [ $elapsed -lt "$timeout" ]; do
    local bindings condition resolved
    bindings=$(kctl get mcpserver "$server_name" -n "$RECIPE_NS" \
      -o jsonpath='{.spec.egressBindings}' 2>/dev/null || echo "")
    condition=$(kctl get mcpserver "$server_name" -n "$RECIPE_NS" \
      -o jsonpath='{.status.conditions[?(@.type=="ExternalEgressReady")].status}:{.status.conditions[?(@.type=="ExternalEgressReady")].reason}' 2>/dev/null || echo "")
    resolved=$(kctl get mcpserver "$server_name" -n "$RECIPE_NS" \
      -o jsonpath='{.status.resolvedEgressIPs}' 2>/dev/null || echo "")

    if echo "$bindings" | grep -q "$dns" &&
      [ "$condition" = "True:Reconciled" ] &&
      echo "$resolved" | grep -q "$dns" &&
      kctl get networkpolicy "$policy_name" -n "$RECIPE_NS" &>/dev/null; then
      return 0
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

stdio_https_probe() {
  local pod=$1 host=$2 timeout_ms=${3:-6000}
  kctl exec -n "$RECIPE_NS" "$pod" -c stdio-bridge -- env EGRESS_HOST="$host" EGRESS_TIMEOUT_MS="$timeout_ms" node -e '
const https = require("https");
const host = process.env.EGRESS_HOST;
const timeout = Number(process.env.EGRESS_TIMEOUT_MS || "6000");
const req = https.get({ hostname: host, path: "/", family: 4, timeout }, res => {
  console.log(`ALLOWED ${res.statusCode}`);
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 3);
});
req.on("timeout", () => {
  console.log("BLOCKED timeout");
  req.destroy();
  process.exit(2);
});
req.on("error", err => {
  console.log(`BLOCKED ${err.code || err.message}`);
  process.exit(2);
});
'
}

stdio_http_probe() {
  local pod=$1 host=$2 timeout_ms=${3:-3000}
  kctl exec -n "$RECIPE_NS" "$pod" -c stdio-bridge -- env EGRESS_HOST="$host" EGRESS_TIMEOUT_MS="$timeout_ms" node -e '
const http = require("http");
const host = process.env.EGRESS_HOST;
const timeout = Number(process.env.EGRESS_TIMEOUT_MS || "3000");
const req = http.get({ host, path: "/", timeout }, res => {
  console.log(`ALLOWED ${res.statusCode}`);
  res.resume();
  process.exit(0);
});
req.on("timeout", () => {
  console.log("BLOCKED timeout");
  req.destroy();
  process.exit(2);
});
req.on("error", err => {
  console.log(`BLOCKED ${err.code || err.message}`);
  process.exit(2);
});
'
}

wait_for_workflowrecipe_phase() {
  local recipe_name=$1 expected=$2 timeout=$3 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local phase
    phase=$(kctl get workflowrecipe "$recipe_name" -n "$WORKFLOW_RECIPE_NS" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "$expected" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

verify_mcp_proxy_stdio_tool_call() {
  local server_name=$1
  header "Phase 7 — mcp-proxy stdio routing"

  if ! kctl get deploy mcp-proxy -n "$RECIPE_NS" &>/dev/null; then
    fail "mcp-proxy deployment not found"
    return
  fi

  local result="" ok_value="" tools_value="" output_value="" stage_value="" status_value=""
  local elapsed=0 timeout="${MCP_PROXY_ROUTING_TIMEOUT:-$TIMEOUT_DISCOVERY}"

  while [ "$elapsed" -lt "$timeout" ]; do
    result=$(kctl exec -i -n "$RECIPE_NS" deploy/mcp-proxy -- node - "$server_name" <<'NODE' 2>/dev/null || echo '{"ok":false,"stage":"exec","error":"kctl exec failed"}'
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
    clientInfo: { name: 'e2e-stdio-runtime-gate', version: '1.0.0' },
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
  if (!names.includes('multiply')) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/list', status: listed.status, tools: names }));
    return;
  }

  const called = await postMcp(3, 'tools/call', {
    name: 'multiply',
    arguments: { a: 15, b: 7 },
  }, sessionId);
  if (called.status !== 200) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/call', status: called.status, body: called.body }));
    return;
  }
  const text = (called.parsed?.result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
  if (!text.includes('105')) {
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
      ok "mcp-proxy listed stdio tools and tools/call multiply returned 105"
      log "stdio tools: ${tools_value}; multiply output: ${output_value}"
      return
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "mcp-proxy stdio routing failed at ${stage_value:-unknown} HTTP ${status_value:-unknown}: $(printf "%s" "$result" | head -c 260)"
}

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  header "Cleanup"
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false 2>/dev/null || true
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
  [ "$RECIPE_NS" = "$WORKFLOW_RECIPE_NS" ] || kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$RECIPE_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  exit 0
fi

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Clean Slate
header "Phase 1 — Clean Slate"
kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false 2>/dev/null || true
if ! wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE"; then
  fail "WorkflowRecipe '${RECIPE_NAME}' still exists in ${WORKFLOW_RECIPE_NS} after cleanup timeout"
fi
[ "$RECIPE_NS" = "$WORKFLOW_RECIPE_NS" ] || kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete deployment "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete svc "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true

# Phase 2: Apply Recipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

if wait_for_workflowrecipe_phase "$RECIPE_NAME" "active" "$TIMEOUT_POD"; then
  ok "WorkflowRecipe '${RECIPE_NAME}' phase is active after stdio delegation"
else
  phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "missing")
  fail "WorkflowRecipe '${RECIPE_NAME}' phase is '${phase}' (expected: active)"
fi

# Phase 4: MCP Delegation (McpServer CRD)
header "Phase 4 — MCP Delegation (stdio McpServer CRD)"

if wait_for_mcpserver "$MCP_SERVER_NAME" "$RECIPE_NS" "$TIMEOUT_POD"; then
  ok "McpServer CRD '${MCP_SERVER_NAME}' auto-created"
else
  fail "McpServer CRD '${MCP_SERVER_NAME}' not found"
fi

managed=$(kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
if [ "$managed" = "true" ]; then
  ok "McpServer managed=true (HCC manages deployment with stdio-bridge)"
else
  fail "McpServer managed='$managed' (expected: true for stdio)"
fi

transport_type=$(kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.spec.transport.type}' 2>/dev/null || echo "")
if [ "$transport_type" = "stdio" ]; then
  ok "McpServer transport.type=stdio"
else
  fail "McpServer transport.type='$transport_type' (expected: stdio)"
fi

if kctl get svc "$MCP_SERVER_NAME" -n "$RECIPE_NS" &>/dev/null; then
  ok "Transport Service '${MCP_SERVER_NAME}' created"
else
  warn "Transport Service not found (HCC may create it)"
fi

# Context allowlist: recipes with spec.contextRef use that declared Context;
# otherwise WRC creates a per-recipe Context named wf-{recipeName}.
RECIPE_CONTEXT="$(resolve_recipe_context)"
if wait_for_context_allowlist "$RECIPE_CONTEXT" "$MCP_SERVER_NAME" "$RECIPE_NS" "$TIMEOUT_POD"; then
  ok "Context '${RECIPE_CONTEXT}' allowlist includes '${MCP_SERVER_NAME}'"
else
  fail "Context '${RECIPE_CONTEXT}' does not include '${MCP_SERVER_NAME}'"
fi

# Phase 5: stdio-bridge sidecar pod
verify_stdio_mcp_server_pod "$MCP_ID" "$MCP_SERVER_NAME"

# Phase 6: NetworkPolicy (no backend — just verify internet egress blocked)
header "Phase 6 — NetworkPolicy (internet egress blocked)"
log "Testing internet egress blocked..."
local_pod=$(kctl get pods -n "$RECIPE_NS" -l "app=${MCP_SERVER_NAME}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$local_pod" ]; then
  egress_result=$(kctl exec -n "$RECIPE_NS" "$local_pod" -c stdio-bridge \
    -- sh -c 'wget -q -O- --timeout=3 http://1.1.1.1 2>&1 || echo BLOCKED' 2>/dev/null || echo "BLOCKED")
  if echo "$egress_result" | grep -qi "BLOCKED\|timeout\|refused"; then
    ok "Internet egress blocked for stdio MCP pod"
  else
    warn "Internet egress may not be blocked"
  fi
else
  warn "Could not test egress — pod not found"
fi

# Phase 6b: explicit external egress binding for stdio MCP transport.
#
# This validates the non-default path that matters for stdio tools that need
# outbound network access: WRC must propagate workload egressBindings to the
# managed McpServer, HCC must create an exact external-egress policy, and the
# stdio-bridge pod must still be denied access to undeclared hosts/metadata.
header "Phase 6b — NetworkPolicy (explicit stdio egress binding)"
if [ -z "$local_pod" ]; then
  fail "Could not test explicit stdio egress — pod not found"
fi

if kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.workloads[0].egressBindings}' 2>/dev/null | grep -q "example.com"; then
  log "WorkflowRecipe already has stdio egressBinding for example.com"
else
  kctl patch workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --type=json \
    -p='[{"op":"add","path":"/spec/workloads/0/egressBindings","value":[{"dns":"example.com","port":443}]}]' >/dev/null
fi

if wait_for_stdio_external_egress_ready "$MCP_SERVER_NAME" "example.com" "443" "$TIMEOUT_DISCOVERY"; then
  ok "WRC propagated stdio egressBinding and HCC reconciled exact external-egress policy"
else
  kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  kctl get networkpolicy -n "$RECIPE_NS" | grep "$MCP_SERVER_NAME" || true
  fail "stdio external egressBinding did not become ready"
fi

if stdio_https_probe "$local_pod" "example.com" 6000 >/dev/null 2>&1; then
  ok "stdio-bridge can reach declared public host example.com:443"
else
  fail "stdio-bridge could not reach declared public host example.com:443"
fi

if stdio_https_probe "$local_pod" "openai.com" 4000 >/tmp/stdio-openai-probe.log 2>&1; then
  fail "stdio-bridge reached undeclared public host openai.com"
else
  ok "stdio-bridge cannot reach undeclared public host openai.com"
fi

if stdio_http_probe "$local_pod" "169.254.169.254" 3000 >/tmp/stdio-metadata-probe.log 2>&1; then
  fail "stdio-bridge reached link-local metadata address"
else
  ok "stdio-bridge still cannot reach link-local metadata"
fi

# Phase 7: HCC readiness + real proxy/tool signal
header "Phase 7 — HCC delegated server readiness"
if wait_for_hcc_server_ready "$MCP_SERVER_NAME" "$TIMEOUT_DISCOVERY"; then
  ok "HCC reports '${MCP_SERVER_NAME}' deployed=true ready=true"
else
  fail "HCC did not report '${MCP_SERVER_NAME}' ready"
fi

verify_mcp_proxy_stdio_tool_call "$MCP_SERVER_NAME"

# Results
print_results
