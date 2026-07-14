#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Test: mcp-redis-cache — Redis + MCP Server (Deployment + Deployment)
# ═══════════════════════════════════════════════════════════════════════
#
# Validates:
#   1. Redis Deployment (no StatefulSet) in sandbox-recipes
#   2. Mock MCP Server Deployment in mcp-server via MCP Delegation
#   3. Cross-namespace NetworkPolicies via bindings
#   4. mcp-proxy tool listing and tool execution
#
# This recipe uniquely tests:
#   - Deployment + Deployment pattern (no StatefulSet)
#   - Non-persistent backend service
#   - Template syntax for Redis URL: {{redis:host}}:{{redis:port}}
#
# Usage: ./scripts/e2e/workflow-backend-compat/http-redis-cache.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

# ─── Recipe config ─────────────────────────────────────────────────
RECIPE_FILE="workflow-recipes/samples/mcp-redis-cache.yaml"
RECIPE_NAME="mcp-redis-cache"
BACKEND_ID="redis"
BACKEND_PORT=6379
BACKEND_TYPE="deployment"
MCP_ID="redis-mcp"

# ─── Handle --cleanup-only ────────────────────────────────────────
if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  E2E: mcp-redis-cache — Redis + MCP (Deploy + Deploy)      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Cleanup
cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"

# Phase 2: Apply WorkflowRecipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: Verify Redis Deployment (not StatefulSet)
verify_backend_deployment "$BACKEND_ID" "$BACKEND_PORT"

# Test Redis connectivity
log "Testing Redis PING..."
redis_pod=$(kctl get pod -n "$SANDBOX_NS" -l "app=${BACKEND_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$redis_pod" ]; then
  ping_result=$(kctl exec "$redis_pod" -n "$SANDBOX_NS" -- redis-cli PING 2>/dev/null || echo "")
  if [ "$ping_result" = "PONG" ]; then
    ok "Redis responds to PING"
  else
    fail "Redis PING failed (result: ${ping_result})"
  fi
else
  fail "Redis pod not found"
fi

# Verify template interpolation in MCP pod env
log "Checking {{redis:host}} and {{redis:port}} resolution..."
if wait_for_pod "$RECIPE_NS" "app=${MCP_ID}" "$TIMEOUT_POD"; then
  mcp_pod=$(kctl get pod -n "$RECIPE_NS" -l "app=${MCP_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  redis_url_env=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- printenv REDIS_URL 2>/dev/null || echo "")
  if echo "$redis_url_env" | grep -q "redis://redis.*sandbox-recipes.*svc.*:6379"; then
    ok "Template {{redis:host}}:{{redis:port}} resolved in REDIS_URL='${redis_url_env}'"
  else
    fail "REDIS_URL='${redis_url_env}' (expected redis://redis.<sandbox>.svc:6379)"
  fi
else
  fail "MCP pod not ready for Redis env var verification"
fi

# Phase 4: Verify MCP Delegation
verify_mcp_delegation "$RECIPE_NAME" "$MCP_ID" "$BACKEND_PORT"

# Phase 5: Verify Mock MCP Server pod
verify_mcp_server_pod "$MCP_ID"

# Phase 6: NetworkPolicy enforcement
verify_networkpolicy "$MCP_ID" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: mcp-proxy tool contract
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID" "add" \
  '{"a":42,"b":58}' \
  "100"

# Results
print_results
