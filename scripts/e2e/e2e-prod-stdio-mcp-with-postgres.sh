#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Production Test: stdio MCP + PostgreSQL — Full Integration on DO Cluster
# ═══════════════════════════════════════════════════════════════════════
#
# Production variant of the stdio PostgreSQL compatibility flow.
#
# DIFFERENCES from minikube E2E:
#   - Phase 0-P: HCC config validation (runtimeNamespaces, hostImage)
#   - Phase P1:  Real mcp-proxy routing for stdio-bridge sidecar
#   - Phase P2:  channel-reader → mcp-host cross-namespace NP test
#   - Phase P3:  Existing MCP server smoke test (survive upgrade)
#   - Phase P4:  Tool-calling via cluster network (not localhost bypass)
#   - Phase P5:  Version consistency check across all deployments
#
# This suite validates the stdio transport chain:
#   mcp-host → mcp-proxy → stdio-bridge:3000 → stdio MCP server (stdin/stdout)
#
# Prerequisites:
#   - kubectl configured for production cluster (DO Kubernetes)
#   - CRDs installed, all operators running v1.0.0-wrc
#   - stdio-bridge image loaded in registry
#   - curl image pullable (curlimages/curl:8.5.0)
#
# Usage:
#   ./scripts/e2e/e2e-prod-stdio-mcp-with-postgres.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"
source "${SCRIPT_DIR}/e2e-prod-lib.sh"

RECIPE_FILE="workflow-recipes/samples/prod/stdio-mcp-with-postgres.yaml"
RECIPE_NAME="stdio-mcp-with-postgres"
BACKEND_ID="postgres"
BACKEND_PORT=5432
BACKEND_TYPE="statefulset"
MCP_ID="pg-stdio-mcp"
MCP_SERVER_NAME="${RECIPE_NAME}-${MCP_ID}"
EXPECTED_VERSION="${EXPECTED_VERSION:-v1.0.0-wrc}"

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  header "Cleanup"
  kubectl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --grace-period=5 2>/dev/null || true
  sleep 5
  kubectl delete statefulset "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete svc "$BACKEND_ID" "${BACKEND_ID}-headless" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete deployment "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete svc "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete networkpolicy -n "$RECIPE_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kubectl delete networkpolicy -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  kubectl delete networkpolicy -n "$MCP_HOST_NS" -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
# STANDARD PHASES (from e2e-lib.sh)
# ═══════════════════════════════════════════════════════════════════════

# Phase 0: Production prerequisites (chatllm/agent2, not mcp-host)
check_prerequisites_prod

# Phase 0-P: Production-specific HCC configuration
verify_hcc_config

# Phase P5: Version consistency (early — detect mismatches before deploying)
verify_version_consistency "$EXPECTED_VERSION"

# Phase 1: Clean slate
cleanup_recipe "$RECIPE_NAME" "$BACKEND_ID" "$MCP_ID" "$BACKEND_TYPE"

# Phase 2: Apply recipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: PostgreSQL backend
verify_backend_statefulset "$BACKEND_ID" "$BACKEND_PORT"

# Custom: PostgreSQL connectivity
log "Testing PostgreSQL readiness..."
pg_pod=$(kubectl get pods -n "$SANDBOX_NS" -l "app=${BACKEND_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$pg_pod" ]; then
  pg_ready=$(kubectl exec -n "$SANDBOX_NS" "$pg_pod" -- \
    pg_isready -U postgres 2>/dev/null || echo "not ready")
  if echo "$pg_ready" | grep -q "accepting connections"; then
    ok "PostgreSQL accepting connections"
  else
    fail "PostgreSQL not accepting connections: ${pg_ready}"
  fi

  # Write/read test
  log "Testing PostgreSQL write/read..."
  pg_wr=$(kubectl exec -n "$SANDBOX_NS" "$pg_pod" -- \
    psql -U postgres -t -c "
      CREATE TABLE IF NOT EXISTS e2e_prod (id serial, val text, ts timestamptz DEFAULT now());
      INSERT INTO e2e_prod (val) VALUES ('prod-stdio-test');
      SELECT val FROM e2e_prod WHERE val='prod-stdio-test' LIMIT 1;
    " 2>/dev/null || echo "")
  if echo "$pg_wr" | grep -q "prod-stdio-test"; then
    ok "PostgreSQL write/read verified"
  else
    fail "PostgreSQL write/read failed"
  fi
fi

# Phase 4: MCP Delegation (stdio — managed=true)
header "Phase 4 — MCP Delegation (stdio McpServer CRD + Service)"
sleep 10

if kubectl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" &>/dev/null; then
  ok "McpServer CRD '${MCP_SERVER_NAME}' auto-created"
else
  fail "McpServer CRD '${MCP_SERVER_NAME}' not found"
fi

managed=$(kubectl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
if [ "$managed" = "true" ]; then
  ok "McpServer managed=true (HCC manages stdio-bridge deployment)"
else
  fail "McpServer managed='$managed' (expected: true for stdio)"
fi

# Verify recipe-bindings annotation
bindings_ann=$(kubectl get mcpserver "$MCP_SERVER_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
if echo "$bindings_ann" | grep -q "\"port\":${BACKEND_PORT}"; then
  ok "McpServer has recipe-bindings (port ${BACKEND_PORT})"
else
  warn "McpServer recipe-bindings annotation incomplete"
fi

# Verify Context allowlist
ctx=$(kubectl get context "$CONTEXT_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "")
if echo "$ctx" | grep -q "$MCP_SERVER_NAME"; then
  ok "Context allowlist includes '${MCP_SERVER_NAME}'"
else
  fail "Context does not include '${MCP_SERVER_NAME}'"
fi

# Phase 5: stdio-bridge sidecar pod
verify_stdio_mcp_server_pod "$MCP_ID" "$MCP_SERVER_NAME"

# Custom: Verify stdio-bridge HTTP endpoint is responsive
log "Testing stdio-bridge HTTP endpoint..."
stdio_pod=$(kubectl get pods -n "$RECIPE_NS" -l "app=${MCP_SERVER_NAME}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$stdio_pod" ]; then
  bridge_health=$(kubectl exec "$stdio_pod" -n "$RECIPE_NS" -c stdio-bridge -- \
    node -e "
const http = require('http');
http.get('http://localhost:3000/health', (res) => {
  let b=''; res.on('data',c=>b+=c);
  res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body:b})));
}).on('error', e => process.stdout.write(JSON.stringify({status:0,error:e.message})));
" 2>/dev/null || echo '{"status":0}')
  local_status=$(echo "$bridge_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',0))" 2>/dev/null || echo "0")
  if [ "$local_status" = "200" ]; then
    ok "stdio-bridge responds on :3000/health"
  else
    warn "stdio-bridge health check returned status ${local_status}"
  fi
fi

# Phase 6: NetworkPolicy enforcement
verify_networkpolicy "$MCP_SERVER_NAME" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: MCP Host discovery
verify_mcp_host_discovery "$RECIPE_NAME" "$MCP_ID"

# ═══════════════════════════════════════════════════════════════════════
# PRODUCTION-SPECIFIC PHASES (from e2e-prod-lib.sh)
# ═══════════════════════════════════════════════════════════════════════

# Phase P1: Real proxy routing — MCP initialize through proxy → stdio-bridge
verify_proxy_routing "$MCP_SERVER_NAME"

# Phase P2: channel-reader → mcp-host cross-namespace NP validation
verify_channel_reader_connectivity

# Phase P3: Existing MCP servers survive the deployment
verify_existing_servers

# Phase P4: Full tool-calling through cluster network (stdio pipeline)
verify_tool_calling_via_network "Use the read_env tool to read the PG_HOST environment variable"

# ═══════════════════════════════════════════════════════════════════════
# Cleanup test data
# ═══════════════════════════════════════════════════════════════════════
if [ -n "${pg_pod:-}" ]; then
  log "Cleaning up test data from PostgreSQL..."
  kubectl exec -n "$SANDBOX_NS" "$pg_pod" -- \
    psql -U postgres -c "DROP TABLE IF EXISTS e2e_prod;" 2>/dev/null || true
fi

# Results
print_results
