#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Bootstrap Clerum E2E Cluster
# ═══════════════════════════════════════════════════════════════════════
#
# Deploys ALL infrastructure on a fresh minikube cluster:
#   1. Namespaces
#   2. CRDs
#   3. Build & load Docker images
#   4. Deploy HCC, WRC, MCP Host, MCP Proxy
#   5. Apply Context + Host CRDs
#   6. Wait for readiness
#
# Usage:
#   ./scripts/bootstrap-cluster.sh
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if present (API keys, provider config)
if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  source "${PROJECT_DIR}/.env"
  set +a
fi
PROFILE="clerum-test"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log() { echo -e "${CYAN}[BOOTSTRAP]${NC} $*"; }
ok()  { echo -e "${GREEN}  OK${NC} — $*"; }
err() { echo -e "${RED}  ERROR${NC} — $*"; }

KC="kubectl --context=${PROFILE}"

# ─── Step 1: Verify cluster ───────────────────────────────────────
echo -e "\n${BOLD}═══ Step 1: Verify Cluster ═══${NC}"
if ! $KC cluster-info &>/dev/null; then
  err "Cluster '${PROFILE}' not reachable"
  exit 1
fi
ok "Cluster '${PROFILE}' reachable"

# ─── Step 2: Create namespaces ────────────────────────────────────
echo -e "\n${BOLD}═══ Step 2: Create Namespaces ═══${NC}"
for ns in control-plane mcp-host mcp-server sandbox-recipes rpc-proxy; do
  $KC create namespace "$ns" --dry-run=client -o yaml | $KC apply -f - 2>/dev/null
  # Add metadata label needed by NetworkPolicy selectors
  $KC label namespace "$ns" kubernetes.io/metadata.name="$ns" --overwrite 2>/dev/null
  ok "Namespace '$ns'"
done

# ─── Step 3: Install CRDs ────────────────────────────────────────
echo -e "\n${BOLD}═══ Step 3: Install CRDs ═══${NC}"
$KC apply -f "${PROJECT_DIR}/charts/clerum-crds/crds/"
ok "All CRDs installed"

# ─── Step 4: Build & load images ─────────────────────────────────
echo -e "\n${BOLD}═══ Step 4: Build & Load Docker Images ═══${NC}"

build_and_load() {
  local name=$1 dir=$2 tag=$3 dockerfile=${4:-}
  log "Building ${tag}..."
  if [ -n "$dockerfile" ]; then
    docker build -f "$dockerfile" -t "$tag" "$dir" 2>&1 | tail -2
  else
    docker build -t "$tag" "$dir" 2>&1 | tail -2
  fi
  log "Loading ${tag} into minikube..."
  docker save "$tag" | minikube -p "$PROFILE" image load --daemon=false - 2>/dev/null
  ok "$tag loaded"
}

# Core services. hcc/wrc/mcp-host consume shared @clerum/* packages via
# file:../packages/..., so they build from the REPO ROOT context with an
# explicit -f (their Dockerfiles COPY packages/ alongside the service).
build_and_load "hcc" "${PROJECT_DIR}" "clerum/host-context-controller:test" "${PROJECT_DIR}/host-context-controller/Dockerfile"
build_and_load "wrc" "${PROJECT_DIR}" "clerum/workflow-recipes:test" "${PROJECT_DIR}/workflow-recipes/Dockerfile"
build_and_load "mcp-host" "${PROJECT_DIR}" "your-registry.example.com/evenfire/mcp-host:0.4.3" "${PROJECT_DIR}/mcp-host/Dockerfile"
build_and_load "mcp-proxy" "${PROJECT_DIR}/mcp-proxy" "your-registry.example.com/evenfire/mcp-proxy:0.1.0"

# Mock MCP server for E2E tests (HTTP)
if [ -d "${PROJECT_DIR}/tests/e2e/fixtures/mock-mcp-server" ]; then
  build_and_load "mock-mcp" "${PROJECT_DIR}/tests/e2e/fixtures/mock-mcp-server" "clerum/mock-mcp-server:test"
fi

# Mock stdio MCP server for E2E tests (stdio transport)
if [ -d "${PROJECT_DIR}/tests/e2e/fixtures/mock-stdio-mcp-server" ]; then
  build_and_load "mock-stdio-mcp" "${PROJECT_DIR}/tests/e2e/fixtures/mock-stdio-mcp-server" "clerum/mock-stdio-mcp-server:test"
fi

# stdio-bridge sidecar image — used by HCC to wrap stdio MCP servers
if [ -d "${PROJECT_DIR}/stdio-bridge" ]; then
  build_and_load "stdio-bridge" "${PROJECT_DIR}/stdio-bridge" "clerum/stdio-bridge:0.1.0"
fi

# Public images needed by E2E recipes
log "Loading public images..."
PUBLIC_IMAGES=(
  "nginx:1.30.1-alpine"
  "postgres:16-alpine"
  "redis:7-alpine"
  "curlimages/curl:8.7.1"
  "mongodb/mongodb-community-server:7.0-ubi8"
)
for img in "${PUBLIC_IMAGES[@]}"; do
  if minikube -p "$PROFILE" image list 2>/dev/null | grep -q "${img%%:*}"; then
    log "Image '$img' already loaded"
  else
    log "Pulling '$img'..."
    docker pull "$img" 2>/dev/null
    docker save "$img" | minikube -p "$PROFILE" image load --daemon=false - 2>/dev/null
    ok "$img loaded"
  fi
done

# ─── Step 5: Deploy Host Context Controller ──────────────────────
echo -e "\n${BOLD}═══ Step 5: Deploy Host Context Controller ═══${NC}"
HCC_DIR="${PROJECT_DIR}/host-context-controller/deploy"
$KC apply -f "$HCC_DIR/serviceaccount.yaml"
$KC apply -f "$HCC_DIR/rbac.yaml"
$KC apply -f "$HCC_DIR/service.yaml"
$KC apply -f "$HCC_DIR/networkpolicy.yaml"
$KC apply -f "$HCC_DIR/networkpolicy-mcp-server.yaml"
$KC apply -f "$HCC_DIR/deployment.yaml"
# API Gateway
$KC apply -f "$HCC_DIR/api-gateway-configmap.yaml"
$KC apply -f "$HCC_DIR/api-gateway-deployment.yaml"
$KC apply -f "$HCC_DIR/api-gateway-service.yaml"
ok "HCC deployed"
# Patch HCC to use local stdio-bridge image (minikube doesn't have registry credentials)
$KC set image deployment/host-context-controller \
  host-context-controller=clerum/host-context-controller:test \
  -n control-plane 2>/dev/null || true
$KC patch deployment host-context-controller -n control-plane \
  --type=json \
  -p='[
    {"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"},
    {"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE","value":"clerum/stdio-bridge:0.1.0"}},
    {"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"CONTEXT_MAPPER_STDIO_BRIDGE_PULL_POLICY","value":"IfNotPresent"}}
  ]' 2>/dev/null || true
ok "HCC patched for local stdio-bridge image"

# ─── Step 6: Deploy Workload Recipes Operator ────────────────────
echo -e "\n${BOLD}═══ Step 6: Deploy Workload Recipes Operator ═══${NC}"
WRC_DIR="${PROJECT_DIR}/workflow-recipes/deploy"
$KC apply -f "$WRC_DIR/namespace.yaml"
$KC apply -f "$WRC_DIR/serviceaccount.yaml"
$KC apply -f "$WRC_DIR/rbac.yaml"
$KC apply -f "$WRC_DIR/service.yaml"
$KC apply -f "$WRC_DIR/deployment.yaml"
ok "WRC Operator deployed"
# Patch WRC to use local image (minikube doesn't have registry credentials)
$KC set image deployment/workflow-recipes \
  workflow-recipes=clerum/workflow-recipes:test \
  -n control-plane 2>/dev/null || true
$KC patch deployment workflow-recipes -n control-plane \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"workflow-recipes","imagePullPolicy":"IfNotPresent"}]}}}}' 2>/dev/null || true
ok "WRC patched for local image"

# ─── Step 7: Deploy MCP Host ─────────────────────────────────────
echo -e "\n${BOLD}═══ Step 7: Deploy MCP Host ═══${NC}"
MH_DIR="${PROJECT_DIR}/mcp-host/deploy"
$KC apply -f "$MH_DIR/namespace.yaml"
$KC apply -f "$MH_DIR/configmap.yaml"
$KC apply -f "$MH_DIR/serviceaccount.yaml"
$KC apply -f "$MH_DIR/rbac.yaml"
$KC apply -f "$MH_DIR/networkpolicy.yaml"
$KC apply -f "$MH_DIR/pvc.yaml"
$KC apply -f "$MH_DIR/service.yaml"
$KC apply -f "$MH_DIR/deployment.yaml"

# Create API key secret (use env var or dummy for E2E)
$KC create secret generic chatllm-api-keys \
  --namespace=mcp-host \
  --from-literal=openai-api-key="${OPENAI_API_KEY:-sk-test-dummy}" \
  --from-literal=claude-api-key="${CLAUDE_API_KEY:-sk-ant-test-dummy}" \
  --from-literal=zai-api-key="${ZAI_API_KEY:-zai-test-dummy}" \
  --from-literal=bailian-api-key="${BAILIAN_API_KEY:-sk-test-dummy}" \
  --dry-run=client -o yaml | $KC apply -f -
ok "MCP Host deployed"

# ─── Step 8: Deploy MCP Proxy ────────────────────────────────────
echo -e "\n${BOLD}═══ Step 8: Deploy MCP Proxy ═══${NC}"
MP_DIR="${PROJECT_DIR}/mcp-proxy/deploy"
$KC apply -f "$MP_DIR/rbac.yaml"
$KC apply -f "$MP_DIR/service.yaml"
$KC apply -f "$MP_DIR/networkpolicy.yaml"
$KC apply -f "$MP_DIR/deployment.yaml"
ok "MCP Proxy deployed"

# ─── Step 8b: Bootstrap JWT signing keys ─────────────────────────
echo -e "\n${BOLD}═══ Step 8b: Bootstrap JWT Signing Keys ═══${NC}"
bash "${SCRIPT_DIR}/bootstrap-signing-keys.sh" 2>/dev/null || true
# Note: clerum-model-secret-mapping ConfigMap is declarative — lives in
# deploy/base/mcp-host/model-secret-mapping.yaml (mcp-host namespace,
# post-refactor single source of truth). No imperative create needed here.
ok "JWT signing keys ready"

# ─── Step 9: Apply CRD Instances ─────────────────────────────────
echo -e "\n${BOLD}═══ Step 9: Apply CRD Instances ═══${NC}"
# Context (goes to mcp-server namespace as defined in example)
$KC apply -f "${PROJECT_DIR}/charts/clerum-crds/examples/context1.yaml"
# Host — must go in mcp-host namespace (where mcp-host deployment looks for it)
$KC apply -f - <<HOSTEOF
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: ${CLERUM_MODEL_PROVIDER:-zai}
    name: ${CLERUM_MODEL_NAME:-glm-4.7}
  workflowControl:
    scopes:
      - workflow:list
      - workflow:read
      - workflow:trigger
      - workflow:approval:resolve
      - workflow:approval:decide
  channels:
    - all-channels
  approval:
    defaultPolicy: channel_users
    channels:
      telegram:
        enabled: true
HOSTEOF
ok "Context + Host CRDs applied"

# ─── Step 10: Wait for core services ─────────────────────────────
echo -e "\n${BOLD}═══ Step 10: Wait for Core Services ═══${NC}"
CORE_DEPLOYS=(
  "control-plane:host-context-controller"
  "control-plane:host-context-controller-api-gateway"
  "control-plane:workflow-recipes"
  "mcp-host:mcp-host"
)

all_ready=true
for entry in "${CORE_DEPLOYS[@]}"; do
  ns="${entry%%:*}"
  name="${entry##*:}"
  log "Waiting for ${ns}/${name} (120s)..."
  if $KC rollout status deployment/"$name" -n "$ns" --timeout=120s 2>/dev/null; then
    ok "${ns}/${name} ready"
  else
    err "${ns}/${name} NOT ready"
    $KC get pods -n "$ns" -l "app=${name}" 2>/dev/null
    $KC describe pod -n "$ns" -l "app=${name}" 2>/dev/null | tail -15
    all_ready=false
  fi
done

# ─── Summary ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
if [ "$all_ready" = true ]; then
  echo -e "${GREEN}${BOLD}  Cluster bootstrap complete! All services ready.${NC}"
  echo -e "  Run E2E tests: ${CYAN}bash scripts/e2e/e2e-workflow-runtime-gate.sh${NC}"
else
  echo -e "${YELLOW}${BOLD}  Cluster bootstrap partially complete. Some services need attention.${NC}"
  echo -e "  Check: ${CYAN}kubectl --context=${PROFILE} get pods -A${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
