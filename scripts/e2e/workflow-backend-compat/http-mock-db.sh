#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Test: mock-mcp-with-db — PostgreSQL + Mock MCP Server
# ═══════════════════════════════════════════════════════════════════════
#
# Validates:
#   1. PostgreSQL StatefulSet with PVC in sandbox-recipes
#   2. Mock MCP Server Deployment in mcp-server via MCP Delegation
#   3. Cross-namespace NetworkPolicies via bindings
#   4. mcp-proxy tool listing and tool execution
#
# Usage: ./scripts/e2e/workflow-backend-compat/http-mock-db.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

# ─── Recipe config ─────────────────────────────────────────────────
RECIPE_FILE="workflow-recipes/samples/mock-mcp-with-db.yaml"
RECIPE_NAME="mock-mcp-with-db"
BACKEND_ID="db"
BACKEND_PORT=5432
BACKEND_TYPE="statefulset"
MCP_ID="mcp-api"

# ─── Handle --cleanup-only ────────────────────────────────────────
if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  E2E: mock-mcp-with-db — PostgreSQL + Mock MCP Server      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Cleanup
cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"

# Phase 2: Apply WorkflowRecipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: Verify PostgreSQL StatefulSet
verify_backend_statefulset "$BACKEND_ID" "$BACKEND_PORT"

# Test backend PostgreSQL readiness under the workload security UID.
log "Testing PostgreSQL readiness via pg_isready..."
if kctl exec db-0 -n "$SANDBOX_NS" -- pg_isready -U postgres 2>/dev/null | grep -q "accepting connections"; then
  ok "PostgreSQL is ready and accepting connections (runAsUser: 70)"
else
  fail "PostgreSQL not ready on port 5432"
fi

# Phase 4: Verify MCP Delegation
verify_mcp_delegation "$RECIPE_NAME" "$MCP_ID" "$BACKEND_PORT"

# Phase 5: Verify Mock MCP Server pod
verify_mcp_server_pod "$MCP_ID"

# Phase 6: NetworkPolicy enforcement
verify_networkpolicy "$MCP_ID" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: mcp-proxy tool contract
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID" "echo" \
  '{"text":"mock-mcp-with-db E2E test passed"}' \
  "mock-mcp-with-db E2E test passed"

# Results
print_results
