#!/usr/bin/env bash
#
# Configure minikube for LLM benchmark tests.
#
# This script:
#   1. Patches the mcp-host ConfigMap for benchmark mode (no approval, high limits)
#   2. Verifies API keys are present in the secret
#   3. Ensures the workspace directory exists
#   4. Restarts the mcp-host pod to pick up ConfigMap changes
#   5. Waits for readiness and health check
#
# Usage:
#   bash tests/e2e/benchmark/setup/configure-benchmark.sh
#

set -euo pipefail

NS_MCP="mcp-host"
NS_CTRL="control-plane"
HOST_CRD="chatllm"
CONFIGMAP="mcp-host-config"
SECRET="mcp-host-keys"

echo "============================================"
echo "  Clerum LLM Benchmark — Minikube Setup"
echo "============================================"
echo ""

# ---- 1. Patch ConfigMap ----
echo "[1/5] Patching ConfigMap ${CONFIGMAP} for benchmark mode..."

kubectl patch configmap "${CONFIGMAP}" -n "${NS_MCP}" --type=merge -p '{
  "data": {
    "CLERUM_ENABLE_APPROVAL": "false",
    "CLERUM_AGENT_MAX_TOOL_CALLS": "200",
    "CLERUM_AGENT_MAX_TASK_DURATION": "600000",
    "CLERUM_SHELL_TIMEOUT": "120000",
    "CLERUM_MEMORY_ENABLED": "true",
    "CLERUM_ENABLE_NUDGE": "false"
  }
}'
echo "  ConfigMap patched."

# ---- 2. Verify API keys ----
echo ""
echo "[2/5] Verifying API keys in secret ${SECRET}..."

KEYS_PRESENT=0
for KEY in openai-api-key claude-api-key zai-api-key bailian-api-key; do
  VAL=$(kubectl get secret "${SECRET}" -n "${NS_MCP}" -o jsonpath="{.data.${KEY}}" 2>/dev/null || echo "")
  if [ -n "${VAL}" ] && [ "${VAL}" != "" ]; then
    # Decode and check it's not a placeholder
    DECODED=$(echo "${VAL}" | base64 -d 2>/dev/null || echo "")
    if [ -n "${DECODED}" ] && [[ "${DECODED}" != *"your-"* ]]; then
      echo "  ✓ ${KEY}: present"
      KEYS_PRESENT=$((KEYS_PRESENT + 1))
    else
      echo "  ✗ ${KEY}: placeholder value (update the secret)"
    fi
  else
    echo "  ✗ ${KEY}: missing"
  fi
done

if [ "${KEYS_PRESENT}" -lt 1 ]; then
  echo ""
  echo "ERROR: No valid API keys found. At least one provider key is required."
  echo "Create the secret:"
  echo "  kubectl create secret generic ${SECRET} -n ${NS_MCP} \\"
  echo "    --from-literal=openai-api-key=sk-xxx \\"
  echo "    --from-literal=claude-api-key=sk-ant-xxx \\"
  echo "    --from-literal=zai-api-key=zai-xxx \\"
  echo "    --from-literal=bailian-api-key=sk-xxx"
  exit 1
fi

echo "  ${KEYS_PRESENT}/4 API keys configured."

# ---- 3. Ensure workspace directory ----
echo ""
echo "[3/5] Ensuring /workspace/benchmark/ directory exists..."

# Get the mcp-host pod name
MCP_HOST_DEPLOYMENT="${E2E_MCP_HOST_DEPLOYMENT:-chatllm}"
if ! kubectl get deployment "${MCP_HOST_DEPLOYMENT}" -n "${NS_MCP}" >/dev/null 2>&1; then
  MCP_HOST_DEPLOYMENT="mcp-host"
fi

POD=$(kubectl get pods -n "${NS_MCP}" -l "app=${MCP_HOST_DEPLOYMENT}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "${POD}" ]; then
  kubectl exec "${POD}" -n "${NS_MCP}" -- mkdir -p /workspace/benchmark 2>/dev/null || true
  echo "  Workspace directory ready."
else
  echo "  Warning: mcp-host pod not found (will be created after restart)."
fi

# ---- 4. Restart mcp-host ----
echo ""
echo "[4/5] Restarting mcp-host to pick up ConfigMap changes..."

kubectl rollout restart "deployment/${MCP_HOST_DEPLOYMENT}" -n "${NS_MCP}"
echo "  Restart triggered."

# ---- 5. Wait for readiness ----
echo ""
echo "[5/5] Waiting for mcp-host to be ready..."

kubectl rollout status "deployment/${MCP_HOST_DEPLOYMENT}" -n "${NS_MCP}" --timeout=120s

# Wait a bit more for the pod to fully initialize
sleep 5

# Get new pod name after restart
NEW_POD=$(kubectl get pods -n "${NS_MCP}" -l "app=${MCP_HOST_DEPLOYMENT}" -o jsonpath='{.items[0].metadata.name}')
echo "  Pod: ${NEW_POD}"

# Ensure workspace dir on new pod
kubectl exec "${NEW_POD}" -n "${NS_MCP}" -- mkdir -p /workspace/benchmark 2>/dev/null || true

# Health check via kubectl exec (no port-forward needed)
HEALTH=$(kubectl exec "${NEW_POD}" -n "${NS_MCP}" -- wget -qO- http://localhost:8080/v1/runtime/health 2>/dev/null || echo "")
if echo "${HEALTH}" | grep -q '"ok"'; then
  echo "  Health check: PASSED"
else
  echo "  Health check: WARNING — could not verify (may need port-forward)"
fi

echo ""
echo "============================================"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Start port-forward:"
echo "       kubectl port-forward -n mcp-host svc/${MCP_HOST_DEPLOYMENT} 8080:8080"
echo ""
echo "    2. Run benchmark:"
echo "       cd tests/e2e && npx vitest run benchmark/benchmark.test.ts"
echo ""
echo "    3. Filter providers (optional):"
echo "       BENCHMARK_PROVIDERS=openai,claude npx vitest run benchmark/benchmark.test.ts"
echo ""
echo "    4. Generate report:"
echo "       npx tsx tests/e2e/benchmark/report.ts"
echo "============================================"
