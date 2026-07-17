#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Test: mcp-postgres — PostgreSQL + MCP with Template Interpolation
# ═══════════════════════════════════════════════════════════════════════
#
# Validates:
#   1. PostgreSQL StatefulSet with PVC in sandbox-recipes
#   2. Mock MCP Server with {{inputs.*}} and {{postgres:host}} templates
#   3. Cross-namespace NetworkPolicies via bindings
#   4. mcp-proxy tool listing and tool execution
#
# This recipe uniquely tests template interpolation:
#   - {{inputs.db_password}} / {{inputs.db_name}} → input defaults
#   - {{postgres:host}} / {{postgres:port}} → cross-workload references
#
# Usage: ./scripts/e2e/workflow-backend-compat/http-postgres.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

# ─── Recipe config ─────────────────────────────────────────────────
RECIPE_FILE="workflow-recipes/samples/mcp-postgres.yaml"
RECIPE_NAME="mcp-postgres"
BACKEND_ID="postgres"
BACKEND_PORT=5432
BACKEND_TYPE="statefulset"
MCP_ID="pg-mcp"

# ─── Handle --cleanup-only ────────────────────────────────────────
if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  E2E: mcp-postgres — PostgreSQL + MCP (Template Interp.)   ║"
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
if kctl exec postgres-0 -n "$SANDBOX_NS" -- pg_isready -U postgres 2>/dev/null | grep -q "accepting connections"; then
  ok "PostgreSQL is ready and accepting connections (runAsUser: 70)"
else
  fail "PostgreSQL not ready on port 5432"
fi

# Verify template interpolation — check env vars in MCP pod
header "Phase 3b — Template Interpolation Verification"
log "Checking {{inputs.*}} and {{workload:field}} resolution..."

if wait_for_pod "$RECIPE_NS" "app=${MCP_ID}" "$TIMEOUT_POD"; then
  mcp_pod=$(kctl get pod -n "$RECIPE_NS" -l "app=${MCP_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  pg_host_env=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- printenv POSTGRES_HOST 2>/dev/null || echo "")
  if echo "$pg_host_env" | grep -q "postgres.*sandbox-recipes.*svc"; then
    ok "Template {{postgres:host}} resolved to '${pg_host_env}'"
  else
    fail "POSTGRES_HOST='${pg_host_env}' (expected K8s DNS)"
  fi

  pg_port_env=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- printenv POSTGRES_PORT 2>/dev/null || echo "")
  if [ "$pg_port_env" = "5432" ]; then
    ok "Template {{postgres:port}} resolved to '5432'"
  else
    fail "POSTGRES_PORT='${pg_port_env}' (expected 5432)"
  fi

  pg_pass_env=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- printenv POSTGRES_PASSWORD 2>/dev/null || echo "")
  if [ "$pg_pass_env" = "changeme" ]; then
    ok "Template {{inputs.db_password}} resolved to default 'changeme'"
  else
    fail "POSTGRES_PASSWORD='${pg_pass_env}' (expected 'changeme')"
  fi
else
  fail "MCP pod not ready for env var verification"
fi

# Phase 4: Verify MCP Delegation
verify_mcp_delegation "$RECIPE_NAME" "$MCP_ID" "$BACKEND_PORT"

# Phase 5: Verify Mock MCP Server pod
verify_mcp_server_pod "$MCP_ID"

# Phase 6: NetworkPolicy enforcement
verify_networkpolicy "$MCP_ID" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: mcp-proxy tool contract
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID" "echo" \
  '{"text":"mcp-postgres template interpolation works"}' \
  "mcp-postgres template interpolation works"

# Results
print_results
