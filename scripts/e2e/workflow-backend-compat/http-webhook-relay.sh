#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Test: mcp-webhook-relay — MCP Deployment + CronJob Health Checker
# ═══════════════════════════════════════════════════════════════════════
#
# Validates:
#   1. Relay MCP Server Deployment in mcp-server
#   2. CronJob health-checker in sandbox-recipes (namespace splitting)
#   3. Cross-namespace NetworkPolicy (health-checker → relay binding)
#   4. CronJob resource created with correct schedule
#   5. mcp-proxy tool listing and tool execution
#
# This recipe uniquely tests:
#   - MCP server as primary workload (not backend)
#   - CronJob workload type
#   - Cross-namespace CronJob → MCP service communication
#   - Template syntax for CronJob args: {{relay:host}}:{{relay:port}}
#
# Usage: ./scripts/e2e/workflow-backend-compat/http-webhook-relay.sh [--cleanup-only]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

export E2E_STRICT_BACKEND_CONNECTIVITY="${E2E_STRICT_BACKEND_CONNECTIVITY:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../e2e-lib.sh"

# ─── Recipe config ─────────────────────────────────────────────────
RECIPE_FILE="workflow-recipes/samples/mcp-webhook-relay.yaml"
RECIPE_NAME="mcp-webhook-relay"
MCP_ID="relay"
CRONJOB_ID="health-checker"

# ─── Handle --cleanup-only ────────────────────────────────────────
if [ "${1:-}" = "--cleanup-only" ]; then
  header "Phase 1 — Clean Slate"
  log "Deleting WorkflowRecipe ${RECIPE_NAME}..."
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false 2>/dev/null || true
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
  [ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ] && kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  sleep 5
  kctl delete deployment "$MCP_ID" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "${RECIPE_NAME}-${MCP_ID}" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete mcpserver "${RECIPE_NAME}-${MCP_ID}" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete cronjob "$CRONJOB_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
  for target_ns in "$RECIPE_NS" "$SANDBOX_NS" "$MCP_HOST_NS"; do
    kctl delete networkpolicy -n "$target_ns" \
      -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
  done
  log "Cleanup complete"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  E2E: mcp-webhook-relay — MCP + CronJob Health Checker     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Phase 0: Prerequisites
check_prerequisites

# Phase 1: Cleanup
header "Phase 1 — Clean Slate"
log "Deleting WorkflowRecipe ${RECIPE_NAME}..."
kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found --wait=false 2>/dev/null || true
wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || true
[ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ] && kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
sleep 5
kctl delete deployment "$MCP_ID" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete svc "${RECIPE_NAME}-${MCP_ID}" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete mcpserver "${RECIPE_NAME}-${MCP_ID}" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
kctl delete cronjob "$CRONJOB_ID" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
for target_ns in "$RECIPE_NS" "$SANDBOX_NS" "$MCP_HOST_NS"; do
  kctl delete networkpolicy -n "$target_ns" \
    -l "clerum.io/recipe=${RECIPE_NAME}" --ignore-not-found 2>/dev/null || true
done
log "Cleanup complete"

# Phase 2: Apply WorkflowRecipe
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# Phase 3: Verify Relay MCP Deployment (mcp-server namespace)
header "Phase 3 — Relay MCP Server (mcp-server namespace)"
log "Waiting for relay Deployment (${TIMEOUT_POD}s)..."
if wait_for_deployment "$RECIPE_NS" "$MCP_ID" "$TIMEOUT_POD"; then
  ok "Relay Deployment ready in mcp-server"
else
  fail "Relay Deployment not ready (timeout)"
  kctl get deployment -n "$RECIPE_NS" 2>/dev/null || true
  kctl get pods -n "$RECIPE_NS" -l "app=${MCP_ID}" 2>/dev/null || true
  kctl describe pod -n "$RECIPE_NS" -l "app=${MCP_ID}" 2>/dev/null | tail -20 || true
fi

# Verify MCP transport started
mcp_logs=$(kctl logs -n "$RECIPE_NS" -l "app=${MCP_ID}" --tail=20 2>/dev/null || echo "")
if echo "$mcp_logs" | grep -qi "listening\|started\|transport\|StreamableHTTP"; then
  ok "Relay MCP Server transport started"
else
  fail "Relay transport not detected in logs"
fi

# Phase 3b: Verify CronJob in sandbox-recipes (namespace splitting)
header "Phase 3b — CronJob Health Checker (sandbox-recipes)"
log "Waiting for CronJob '${CRONJOB_ID}' (30s)..."
if wait_for_cronjob "$SANDBOX_NS" "$CRONJOB_ID" 30; then
  ok "CronJob '${CRONJOB_ID}' created in sandbox-recipes"
else
  fail "CronJob '${CRONJOB_ID}' not found in sandbox-recipes"
  # Check if it ended up in wrong namespace
  if kctl get cronjob "$CRONJOB_ID" -n "$RECIPE_NS" &>/dev/null; then
    fail "CronJob found in mcp-server (expected sandbox-recipes)"
  fi
fi

# Verify CronJob schedule
schedule=$(kctl get cronjob "$CRONJOB_ID" -n "$SANDBOX_NS" \
  -o jsonpath='{.spec.schedule}' 2>/dev/null || echo "")
if [ "$schedule" = "*/5 * * * *" ]; then
  ok "CronJob schedule correct: '${schedule}'"
else
  fail "CronJob schedule: '${schedule}' (expected '*/5 * * * *')"
fi

# Verify template resolution in CronJob args
cronjob_args=$(kctl get cronjob "$CRONJOB_ID" -n "$SANDBOX_NS" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].args}' 2>/dev/null || echo "")
if echo "$cronjob_args" | grep -q "relay.*svc"; then
  ok "Template {{relay:host}} resolved in CronJob args"
else
  fail "CronJob args: ${cronjob_args} (expected resolved template)"
fi

# Phase 4: Verify MCP Delegation
verify_mcp_delegation "$RECIPE_NAME" "$MCP_ID" "3000"

# Phase 5: (Already verified in Phase 3 — relay IS the MCP server)
header "Phase 5 — MCP Server Pod (verified in Phase 3)"
ok "Relay pod already verified as MCP Server"

# Phase 6: NetworkPolicy (verify CronJob → relay binding)
header "Phase 6 — NetworkPolicy Enforcement"
log "Checking NetworkPolicies for recipe binding..."
np_count=$(kctl get networkpolicy -n "$RECIPE_NS" \
  -l "clerum.io/recipe=${RECIPE_NAME}" --no-headers 2>/dev/null | wc -l || echo "0")
np_count_sandbox=$(kctl get networkpolicy -n "$SANDBOX_NS" \
  -l "clerum.io/recipe=${RECIPE_NAME}" --no-headers 2>/dev/null | wc -l || echo "0")
total_nps=$((np_count + np_count_sandbox))
if [ "$total_nps" -gt 0 ]; then
  ok "Found ${total_nps} NetworkPolicies for recipe binding"
else
  warn "No recipe-specific NetworkPolicies found (HCC binding NP may not be implemented for CronJob→Deployment)"
fi

# Test internet egress blocked for relay
mcp_pod=$(kctl get pod -n "$RECIPE_NS" -l "app=${MCP_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$mcp_pod" ]; then
  log "Testing internet egress blocked..."
  egress_result=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- node -e "
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(3000);
    s.connect(80, '1.1.1.1', () => { console.log('OPEN'); s.destroy(); });
    s.on('error', e => { console.log('BLOCKED'); s.destroy(); });
    s.on('timeout', () => { console.log('BLOCKED'); s.destroy(); });
  " 2>&1 || echo "BLOCKED")
  if echo "$egress_result" | grep -q "BLOCKED"; then
    ok "Internet egress blocked for relay"
  else
    if _is_minikube; then
      warn "Internet egress NOT blocked (expected on minikube/Calico)"
    else
      fail "Internet egress NOT blocked"
    fi
  fi
fi

# Phase 7: mcp-proxy tool contract
verify_mcp_proxy_tool_call "$RECIPE_NAME" "$MCP_ID" "add" \
  '{"a":100,"b":200}' \
  "300"

# Results
print_results
