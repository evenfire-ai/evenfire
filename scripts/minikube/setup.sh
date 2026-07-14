#!/usr/bin/env bash
# ======================================================================
# Minikube Setup Orchestrator
# ======================================================================
#
# 12-step deployment of all Clerum services to minikube.
# Sources .env if present for real API keys, channel credentials, and
# model provider configuration.
#
# Usage:
#   ./scripts/minikube/setup.sh
#   ./scripts/minikube/setup.sh --build   # Also build images (step 6)
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_DIR="${PROJECT_DIR}/deploy/minikube"

# Load .env if present (API keys, provider config, channel credentials)
if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  source "${PROJECT_DIR}/.env"
  set +a
fi

PROFILE="clerum-test"
BUILD_IMAGES=false

for arg in "$@"; do
  case "$arg" in
    --build) BUILD_IMAGES=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log() { echo -e "${CYAN}[SETUP]${NC} $*"; }
ok()  { echo -e "${GREEN}  OK${NC} -- $*"; }
err() { echo -e "${RED}  ERROR${NC} -- $*"; }

KC="kubectl --context=${PROFILE}"

# ---- Step 1: Verify cluster -----------------------------------------
echo -e "\n${BOLD}=== Step 1/12: Verify Cluster ===${NC}"
if ! $KC cluster-info &>/dev/null; then
  err "Cluster '${PROFILE}' not reachable."
  echo "  Start with: minikube start -p ${PROFILE} --cni=calico --memory=10240 --cpus=6 --driver=docker"
  exit 1
fi
ok "Cluster '${PROFILE}' reachable"

# ---- Step 2: Create namespaces --------------------------------------
echo -e "\n${BOLD}=== Step 2/12: Create Namespaces ===${NC}"
$KC apply -f "${DEPLOY_DIR}/namespaces.yaml"
ok "7 namespaces created"

# ---- Step 3: Install CRDs -------------------------------------------
echo -e "\n${BOLD}=== Step 3/12: Install CRDs ===${NC}"
$KC apply -f "${PROJECT_DIR}/charts/clerum-crds/crds/"
ok "All CRDs installed"

# ---- Step 4: Generate JWT signing keys ------------------------------
echo -e "\n${BOLD}=== Step 4/12: Generate JWT Signing Keys ===${NC}"
bash "${SCRIPT_DIR}/generate-keys.sh" --apply
ok "JWT signing keys generated and applied"

# ---- Step 5: Apply secrets & configmaps ------------------------------
echo -e "\n${BOLD}=== Step 5/12: Apply Secrets & ConfigMaps ===${NC}"

# LLM API keys — override from .env if present
$KC create secret generic chatllm-api-keys \
  --namespace=mcp-host \
  --from-literal=openai-api-key="${OPENAI_API_KEY:-sk-test-placeholder-openai-key-00000000000000000000}" \
  --from-literal=claude-api-key="${CLAUDE_API_KEY:-sk-ant-api03-test-placeholder-claude-key-000000000000000000000000000000000000000000000000000000}" \
  --from-literal=zai-api-key="${ZAI_API_KEY:-zai-test-placeholder-zai-key-00000000000000000000}" \
  --from-literal=bailian-api-key="${BAILIAN_API_KEY:-sk-test-placeholder-bailian-key-00000000000000000000}" \
  --dry-run=client -o yaml | $KC apply -f -
ok "LLM API keys"

# Channel credentials — retired in #273. The legacy static
# `clerum-channel-reader-credentials` Secret used to be minted here for the
# static channel-reader Deployment. With per-Host pods now owning the
# channel-reader role, credentials are written via control-api's
# /admin/channel-secrets endpoint (Control UI) per Host. No bootstrap-time
# Secret needed.
$KC apply -f "${DEPLOY_DIR}/secrets/inter-service-tokens.yaml"
ok "Inter-service tokens + postgres secret"

# ConfigMaps
$KC apply -f "${DEPLOY_DIR}/configmaps/mcp-host-config.yaml"
$KC apply -f "${DEPLOY_DIR}/configmaps/control-api-config.yaml"
$KC apply -f "${DEPLOY_DIR}/configmaps/channel-reader-config.yaml"
$KC apply -f "${DEPLOY_DIR}/services/rpc-proxy/configmap.yaml"
ok "All ConfigMaps applied"

# Note: clerum-model-secret-mapping ConfigMap is declarative now — it lives in
# deploy/base/mcp-host/model-secret-mapping.yaml and is applied by kustomize
# during the mcp-host deploy step below. Post-refactor (WRC Secret Broker),
# the ConfigMap lives in the mcp-host namespace, not control-plane.
ok "Model secret mapping will be applied declaratively via kustomize"

# ---- Step 6: Build & load images (optional) -------------------------
echo -e "\n${BOLD}=== Step 6/12: Docker Images ===${NC}"
if [ "$BUILD_IMAGES" = true ]; then
  bash "${SCRIPT_DIR}/build-images.sh"
  ok "All images built and loaded"
else
  log "Skipping image build (use --build to build). Assuming images are pre-loaded."
fi

# ---- Step 7: Deploy operators (HCC + WRC) ---------------------------
echo -e "\n${BOLD}=== Step 7/12: Deploy Operators ===${NC}"

# Apply RBAC from existing deploy dirs (serviceaccounts, rbac)
for svc_dir in host-context-controller workflow-recipes mcp-host mcp-proxy control-api channel-reader rpc-proxy; do
  svc_deploy="${PROJECT_DIR}/${svc_dir}/deploy"
  if [ -f "${svc_deploy}/serviceaccount.yaml" ]; then
    $KC apply -f "${svc_deploy}/serviceaccount.yaml" 2>/dev/null || true
  fi
  if [ -f "${svc_deploy}/rbac.yaml" ]; then
    $KC apply -f "${svc_deploy}/rbac.yaml" 2>/dev/null || true
  fi
done
ok "ServiceAccounts and RBAC applied"

$KC apply -f "${DEPLOY_DIR}/services/hcc/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/hcc/service.yaml"
ok "HCC deployed"

$KC apply -f "${DEPLOY_DIR}/services/wrc/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/wrc/service.yaml"
ok "WRC deployed"

# ---- Step 8: Deploy MCP stack (mcp-host + mcp-proxy) ----------------
echo -e "\n${BOLD}=== Step 8/12: Deploy MCP Stack ===${NC}"
$KC apply -f "${DEPLOY_DIR}/services/mcp-host/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/mcp-host/service.yaml"
ok "MCP Host deployed"

$KC apply -f "${DEPLOY_DIR}/services/mcp-proxy/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/mcp-proxy/service.yaml"
ok "MCP Proxy deployed"

# ---- Step 9: Deploy profiles stack (control-api + external-rest-api) -
echo -e "\n${BOLD}=== Step 9/12: Deploy Profiles Stack ===${NC}"
$KC apply -f "${DEPLOY_DIR}/services/control-api/postgres-pvc.yaml"
$KC apply -f "${DEPLOY_DIR}/services/control-api/postgres-deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/control-api/postgres-service.yaml"
ok "Control Postgres deployed"

$KC apply -f "${DEPLOY_DIR}/services/control-api/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/control-api/service.yaml"
ok "Control API deployed"

$KC apply -f "${DEPLOY_DIR}/services/external-rest-api/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/external-rest-api/service.yaml"
ok "External REST API deployed"

# ---- Step 10: Deploy channels stack ----------------------------------
echo -e "\n${BOLD}=== Step 10/12: Deploy Channels Stack ===${NC}"
$KC apply -f "${DEPLOY_DIR}/services/channel-reader/mailpit-deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/channel-reader/mailpit-service.yaml"
ok "Mailpit deployed"

$KC apply -f "${DEPLOY_DIR}/services/channel-reader/deployment.yaml"
ok "Channel Reader deployed"

# ---- Step 11: Deploy RPC Proxy + apply CRD instances -----------------
echo -e "\n${BOLD}=== Step 11/12: Deploy RPC Proxy & CRD Instances ===${NC}"
$KC apply -f "${DEPLOY_DIR}/services/rpc-proxy/deployment.yaml"
$KC apply -f "${DEPLOY_DIR}/services/rpc-proxy/service.yaml"
ok "RPC Proxy deployed"

# Apply all shared CRD instances first. Host is applied again below so env
# overrides still win over the static instance manifest.
$KC apply -f "${DEPLOY_DIR}/instances/"
ok "Base CRD instances applied"

# Override Host CRD model from .env if present
if [ -n "${CLERUM_MODEL_PROVIDER:-}" ] || [ -n "${CLERUM_MODEL_NAME:-}" ]; then
  log "Applying Host CRD with .env overrides (provider=${CLERUM_MODEL_PROVIDER:-zai}, model=${CLERUM_MODEL_NAME:-glm-5.1})..."
  cat <<HOSTEOF | $KC apply -f -
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
    name: ${CLERUM_MODEL_NAME:-glm-5.1}
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
else
  $KC apply -f "${DEPLOY_DIR}/instances/host.yaml"
fi
ok "Host CRD applied"

# ---- Step 12: Wait for readiness ------------------------------------
echo -e "\n${BOLD}=== Step 12/12: Wait for Readiness ===${NC}"
CORE_DEPLOYS=(
  "control-plane:host-context-controller"
  "control-plane:workflow-recipes"
  "control-plane:control-api"
  "control-plane:control-postgres"
  "mcp-host:mcp-host"
  "mcp-server:mcp-proxy"
  "profiles:external-rest-api"
  "rpc-proxy:rpc-proxy"
  "channels:mailpit"
  # (#273) The static clerum-channel-reader Deployment is gone — per-Host
  # channel-reader-<host> Deployments are created by HCC when a Host CRD
  # is applied, not at bootstrap.
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
    $KC get pods -n "$ns" -l "app=${name}" 2>/dev/null || true
    all_ready=false
  fi
done

# ---- Summary ---------------------------------------------------------
echo ""
echo -e "${BOLD}================================================================${NC}"
if [ "$all_ready" = true ]; then
  echo -e "${GREEN}${BOLD}  Minikube setup complete! All services ready.${NC}"
else
  echo -e "${YELLOW}${BOLD}  Setup partially complete. Some services need attention.${NC}"
  echo -e "  Check: ${CYAN}kubectl --context=${PROFILE} get pods -A${NC}"
fi
echo -e "${BOLD}================================================================${NC}"
