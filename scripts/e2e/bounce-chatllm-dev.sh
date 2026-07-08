#!/usr/bin/env bash
set -eo pipefail
umask 077
KCTX="${KUBECONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum-dev}"

log() { echo "[chatllm] $*" >&2; }

log "=== Rolling restart chatllm ==="
kubectl --context "$KCTX" -n mcp-host rollout restart deployment/chatllm
kubectl --context "$KCTX" -n mcp-host rollout status deployment/chatllm --timeout=120s 2>&1 | tail -5

log "=== Validating discovery (20s settle) ==="
sleep 20
POD=$(kubectl --context "$KCTX" -n mcp-host get pods -l app=chatllm \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
echo "--- chatllm pod: $POD ---"
kubectl --context "$KCTX" -n mcp-host logs "$POD" --tail=200 2>&1 \
  | grep -iE "Found [0-9]+ McpServer|Connected successfully|Added server|Connected to [0-9]+ MCP|Total tools|error|failed" \
  | head -30
log "Done."
