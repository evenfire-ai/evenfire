#!/usr/bin/env bash
# E2E: stdio-mcp-with-postgres — stdio MCP + PostgreSQL backend with bindings
#
# Validates:
#   1. PostgreSQL StatefulSet in sandbox-recipes
#   2. stdio MCP server with HCC-managed sidecar in mcp-server
#   3. Cross-namespace NetworkPolicy via bindings
#   4. Template resolution ({{postgres:host}}, {{postgres:port}})
#   5. mcp-proxy tool listing and tool execution through stdio-bridge

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

RECIPE_FILE="workflow-recipes/samples/stdio-mcp-with-postgres.yaml"
RECIPE_NAME="stdio-mcp-with-postgres"
BACKEND_ID="postgres"
BACKEND_PORT=5432
BACKEND_TYPE="statefulset"
MCP_ID="pg-stdio-mcp"
MCP_SERVER_NAME="${RECIPE_NAME}-${MCP_ID}"

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  header "Cleanup"
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false --grace-period=5 2>/dev/null || true
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
  [ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ] && kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --grace-period=5 2>/dev/null || true
  kctl delete statefulset "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$BACKEND_ID" "${BACKEND_ID}-headless" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$RECIPE_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$MCP_HOST_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  exit 0
fi

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Clean Slate
cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"

# Phase 2: Apply Recipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: PostgreSQL Backend
verify_backend_statefulset "$BACKEND_ID" "$BACKEND_PORT"

# Custom Phase 3 extension: PostgreSQL readiness
log "Testing PostgreSQL readiness..."
pg_elapsed=0
pg_ready=false
while [ "$pg_elapsed" -lt "$TIMEOUT_POD" ]; do
  pg_pod=$(kctl get pods -n "$SANDBOX_NS" -l "app=${BACKEND_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "$pg_pod" ]; then
    pg_result=$(kctl exec -n "$SANDBOX_NS" "$pg_pod" -- \
      pg_isready -U postgres 2>/dev/null || echo "not ready")
    if echo "$pg_result" | grep -q "accepting connections"; then
      pg_ready=true
      break
    fi
  fi
  sleep "$POLL_INTERVAL"
  pg_elapsed=$((pg_elapsed + POLL_INTERVAL))
done

if [ "$pg_ready" = "true" ]; then
  ok "PostgreSQL accepting connections"
else
  fail "PostgreSQL not accepting connections after ${TIMEOUT_POD}s"
fi

# Phase 4: MCP Delegation (stdio)
header "Phase 4 — MCP Delegation (stdio McpServer CRD + Service)"
sleep 10

if kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" &>/dev/null; then
  ok "McpServer CRD '${MCP_SERVER_NAME}' auto-created"
else
  fail "McpServer CRD '${MCP_SERVER_NAME}' not found"
fi

managed=$(kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
if [ "$managed" = "true" ]; then
  ok "McpServer managed=true (HCC manages stdio-bridge deployment)"
else
  fail "McpServer managed='$managed' (expected: true for stdio)"
fi

bindings_ann=$(kctl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
if echo "$bindings_ann" | grep -q "\"port\":${BACKEND_PORT}"; then
  ok "McpServer has recipe-bindings (port ${BACKEND_PORT})"
else
  fail "McpServer recipe-bindings annotation incomplete"
fi

verify_mcp_context_allowlist "$MCP_SERVER_NAME"

# Phase 5: stdio-bridge sidecar pod
verify_stdio_mcp_server_pod "$MCP_ID" "$MCP_SERVER_NAME"

# Phase 6: NetworkPolicy
verify_networkpolicy "$MCP_SERVER_NAME" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: mcp-proxy tool contract
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID" "read_env" \
  '{"name":"PG_HOST"}' \
  "postgres"

# Results
print_results
