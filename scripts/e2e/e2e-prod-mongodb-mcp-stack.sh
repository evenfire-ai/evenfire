#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Production Test: MongoDB MCP Stack — Full Integration on DO Cluster
# ═══════════════════════════════════════════════════════════════════════
#
# Production variant of the MongoDB HTTP MCP compatibility flow.
#
# DIFFERENCES from minikube E2E:
#   - Phase 0-P: HCC config validation (runtimeNamespaces, hostImage)
#   - Phase P1:  Real mcp-proxy routing (MCP initialize handshake)
#   - Phase P2:  channel-reader → mcp-host cross-namespace NP test
#   - Phase P3:  Existing MCP server smoke test (survive upgrade)
#   - Phase P4:  Tool-calling via cluster network (not localhost bypass)
#   - Phase P5:  Version consistency check across all deployments
#
# Prerequisites:
#   - kubectl configured for production cluster (DO Kubernetes)
#   - CRDs installed, all operators running v1.0.0-wrc
#   - curl image pullable from registry (curlimages/curl:8.5.0)
#
# Usage:
#   ./scripts/e2e-prod-mongodb-mcp-stack.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"
source "${SCRIPT_DIR}/e2e-prod-lib.sh"

RECIPE_FILE="workflow-recipes/samples/prod/mongodb-mcp-stack.yaml"
RECIPE_NAME="mongodb-mcp-stack"
BACKEND_ID="mongodb"
BACKEND_PORT=27017
BACKEND_TYPE="statefulset"
MCP_ID="mongodb-mcp-server"
MCP_SERVER_NAME="${RECIPE_NAME}-${MCP_ID}"
EXPECTED_VERSION="${EXPECTED_VERSION:-v1.0.0-wrc}"
# DO PVC provisioning + MongoDB first start takes longer than minikube
TIMEOUT_POD=180

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  header "Cleanup"
  kubectl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --grace-period=5 2>/dev/null || true
  sleep 5
  kubectl delete statefulset "$BACKEND_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete svc "$BACKEND_ID" "${BACKEND_ID}-headless" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  kubectl delete deployment "$MCP_ID" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
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

# Phase 3: MongoDB backend
verify_backend_statefulset "$BACKEND_ID" "$BACKEND_PORT"

# Custom: MongoDB connectivity tests
log "Testing MongoDB ping..."
if kubectl exec "${BACKEND_ID}-0" -n "$SANDBOX_NS" -- \
  mongosh --eval "db.runCommand({ping:1})" --quiet 2>/dev/null | grep -q '"ok" : 1\|ok: 1'; then
  ok "MongoDB responds to ping"
else
  fail "MongoDB does not respond to ping"
fi

log "Testing MongoDB write/read..."
write_result=$(kubectl exec "${BACKEND_ID}-0" -n "$SANDBOX_NS" -- mongosh --eval "
  db = db.getSiblingDB('clerum');
  db.e2e_prod.insertOne({test: 'prod-stack', ts: new Date()});
  JSON.stringify(db.e2e_prod.findOne({test: 'prod-stack'}));
" --quiet 2>/dev/null || echo "")
if echo "$write_result" | grep -q '"test":"prod-stack"'; then
  ok "MongoDB write/read verified"
else
  fail "MongoDB write/read failed"
fi

# Phase 4: MCP Delegation
verify_mcp_delegation "$RECIPE_NAME" "$MCP_ID" "$BACKEND_PORT"

# Phase 5: MCP Server pod
verify_mcp_server_pod "$MCP_ID"

# Phase 6: NetworkPolicy enforcement
verify_networkpolicy "$MCP_ID" "$BACKEND_ID" "$BACKEND_PORT"

# Phase 7: MCP Host discovery
verify_mcp_host_discovery "$RECIPE_NAME" "$MCP_ID"

# ═══════════════════════════════════════════════════════════════════════
# PRODUCTION-SPECIFIC PHASES (from e2e-prod-lib.sh)
# ═══════════════════════════════════════════════════════════════════════

# Phase P1: Real proxy routing — MCP initialize handshake through proxy
verify_proxy_routing "$MCP_SERVER_NAME"

# Phase P2: channel-reader → mcp-host cross-namespace NP validation
verify_channel_reader_connectivity

# Phase P3: Existing MCP servers survive the deployment
verify_existing_servers

# Phase P4: Full tool-calling through cluster network (not localhost)
verify_tool_calling_via_network "List all MongoDB databases"

# ═══════════════════════════════════════════════════════════════════════
# Cleanup test data (but leave recipe for inspection)
# ═══════════════════════════════════════════════════════════════════════
log "Cleaning up test data from MongoDB..."
kubectl exec "${BACKEND_ID}-0" -n "$SANDBOX_NS" -- \
  mongosh --eval "db.getSiblingDB('clerum').e2e_prod.drop()" --quiet 2>/dev/null || true

# Results
print_results
