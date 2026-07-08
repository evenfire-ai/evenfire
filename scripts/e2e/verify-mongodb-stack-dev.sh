#!/usr/bin/env bash
# Verify MongoDB WorkflowRecipe stack is fully operational on clerum-dev:
#   1. StatefulSet pod Ready
#   2. MCP Deployment Ready
#   3. McpServer CRD present + listed in context1 allowlist
#   4. chatllm logs show "Connected to N MCP server(s)" including mongodb
set -eo pipefail
umask 077

KCTX="${KUBECONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum-dev}"
MCP_NS="mcp-server"
SANDBOX_NS="sandbox-recipes"
WORKFLOW_RECIPE_NS="$SANDBOX_NS"
CONTEXT_NAME="context1"
RECIPE_NAME="mongodb-mcp-stack"

log() { echo "[verify] $*" >&2; }

log "=== 1. StatefulSet pod status ==="
kubectl --context "$KCTX" -n "$SANDBOX_NS" get statefulset mongodb 2>&1 || true
kubectl --context "$KCTX" -n "$SANDBOX_NS" get pod mongodb-0 -o wide 2>&1 || true

log "=== 2. MCP Deployment status ==="
kubectl --context "$KCTX" -n "$MCP_NS" get deployments 2>&1 | grep -E "mongodb|NAME" || true

log "=== 3. McpServer CRD + Context allowlist ==="
kubectl --context "$KCTX" -n "$MCP_NS" get mcpservers 2>&1 || true
echo "--- Context1 allowlist: ---"
kubectl --context "$KCTX" -n "$MCP_NS" get context "$CONTEXT_NAME" \
  -o jsonpath='{.spec.mcpServers}' 2>&1; echo

log "=== 4. WorkflowRecipe phase ==="
kubectl --context "$KCTX" -n "$WORKFLOW_RECIPE_NS" get workflowrecipe "$RECIPE_NAME" \
  -o jsonpath='{.status.phase}' 2>&1; echo

log "=== 5. chatllm MCP discovery logs ==="
POD=$(kubectl --context "$KCTX" -n mcp-host get pods -l app=chatllm \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>&1) || true
if [[ -z "$POD" ]]; then
  log "WARN: no chatllm pod found"
else
  echo "--- chatllm pod: $POD ---"
  kubectl --context "$KCTX" -n mcp-host logs "$POD" --tail=150 2>&1 \
    | grep -iE "Found [0-9]+ McpServer|Connecting to|Connected successfully|Added server|Connected to [0-9]+ MCP|Total tools available|mongodb|error|failed" \
    | head -40
fi

log "Done."
