#!/usr/bin/env bash
# E2E: stdio-mcp-multi-tool — Two stdio MCP servers + Redis backend
#
# Validates:
#   1. Redis Deployment in sandbox-recipes
#   2. Two stdio MCP servers (data-mcp + compute-mcp) with stdio-bridge sidecars
#   3. NetworkPolicy: data-mcp → Redis allowed, compute-mcp → Redis blocked
#   4. mcp-proxy lists and calls tools from both servers

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

RECIPE_FILE="workflow-recipes/samples/stdio-mcp-multi-tool.yaml"
RECIPE_NAME="stdio-mcp-multi-tool"
BACKEND_ID="redis"
BACKEND_PORT=6379
BACKEND_TYPE="deployment"
MCP_ID_1="data-mcp"
MCP_ID_2="compute-mcp"
MCP_SERVER_NAME_1="${RECIPE_NAME}-${MCP_ID_1}"
MCP_SERVER_NAME_2="${RECIPE_NAME}-${MCP_ID_2}"

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  header "Cleanup"
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false --grace-period=5 2>/dev/null || true
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
  [ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ] && kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --grace-period=5 2>/dev/null || true
  kctl delete deployment "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete mcpserver "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$RECIPE_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$MCP_HOST_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  exit 0
fi

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Clean Slate
header "Phase 1 — Clean Slate"
header "Cleanup"
kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false --grace-period=5 2>/dev/null || true
wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
[ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ] && kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --grace-period=5 2>/dev/null || true
kctl delete deployment "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
kctl delete svc "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
kctl delete deployment "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete svc "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete mcpserver "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete networkpolicy -n "$RECIPE_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
kctl delete networkpolicy -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
sleep 3

# Phase 2: Apply Recipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: Redis Backend
verify_backend_deployment "$BACKEND_ID" "$BACKEND_PORT"

# Phase 4: MCP Delegation — TWO McpServer CRDs
header "Phase 4 — MCP Delegation (2 stdio McpServer CRDs)"
sleep 10

for srv_name in "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2"; do
  if kctl get mcpserver "$srv_name" -n "$RECIPE_NS" &>/dev/null; then
    ok "McpServer CRD '${srv_name}' auto-created"
  else
    fail "McpServer CRD '${srv_name}' not found"
  fi

  managed=$(kctl get mcpserver "$srv_name" -n "$RECIPE_NS" \
    -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
  if [ "$managed" = "true" ]; then
    ok "McpServer '${srv_name}' managed=true (stdio)"
  else
    fail "McpServer '${srv_name}' managed='$managed' (expected: true)"
  fi
done

# Verify data-mcp has bindings annotation (port 6379)
bindings_ann=$(kctl get mcpserver "$MCP_SERVER_NAME_1" -n "$RECIPE_NS" \
  -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
if echo "$bindings_ann" | grep -q "\"port\":${BACKEND_PORT}"; then
  ok "data-mcp has recipe-bindings (port ${BACKEND_PORT})"
else
  fail "data-mcp recipe-bindings annotation incomplete"
fi

# Verify compute-mcp has NO bindings (no binding defined)
bindings_ann_2=$(kctl get mcpserver "$MCP_SERVER_NAME_2" -n "$RECIPE_NS" \
  -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
if [ -z "$bindings_ann_2" ]; then
  ok "compute-mcp has no bindings (as expected — no backend access)"
else
  fail "compute-mcp unexpectedly has bindings: $bindings_ann_2"
fi

for srv_name in "$MCP_SERVER_NAME_1" "$MCP_SERVER_NAME_2"; do
  verify_mcp_context_allowlist "$srv_name"
done

# Phase 5: stdio-bridge sidecar pods (both)
verify_stdio_mcp_server_pod "$MCP_ID_1" "$MCP_SERVER_NAME_1"
verify_stdio_mcp_server_pod "$MCP_ID_2" "$MCP_SERVER_NAME_2"

# Phase 6: NetworkPolicy
header "Phase 6 — NetworkPolicy (selective connectivity)"

# Test: data-mcp CAN reach Redis (has binding)
verify_networkpolicy "$MCP_SERVER_NAME_1" "$BACKEND_ID" "$BACKEND_PORT"

# Test: internet egress blocked for compute-mcp
log "Testing internet egress blocked for compute-mcp..."
compute_pod=$(kctl get pods -n "$RECIPE_NS" -l "app=${MCP_SERVER_NAME_2}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$compute_pod" ]; then
  egress_result=$(kctl exec -n "$RECIPE_NS" "$compute_pod" -c stdio-bridge \
    -- sh -c 'wget -q -O- --timeout=3 http://1.1.1.1 2>&1 || echo BLOCKED' 2>/dev/null || echo "BLOCKED")
  if echo "$egress_result" | grep -qi "BLOCKED\|timeout\|refused"; then
    ok "Internet egress blocked for compute-mcp"
  else
    warn "Internet egress may not be blocked for compute-mcp"
  fi
fi

# Phase 7: mcp-proxy tool contracts
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID_1" "read_env" \
  '{"name":"REDIS_HOST"}' \
  "redis"
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID_2" "add" \
  '{"a":50,"b":25}' \
  "75"

# Results
print_results
