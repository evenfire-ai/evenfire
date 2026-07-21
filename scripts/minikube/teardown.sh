#!/usr/bin/env bash
# ======================================================================
# Minikube Teardown
# ======================================================================
#
# Deletes all Clerum deployments, services, secrets, configmaps, RBAC,
# NetworkPolicies, and PVCs from the minikube cluster.
# Preserves namespaces and CRDs by default.
#
# Usage:
#   ./scripts/minikube/teardown.sh
#   ./scripts/minikube/teardown.sh --all   # Also delete namespaces and CRDs
# ======================================================================

set -euo pipefail

PROFILE="clerum-test"
DELETE_ALL=false

for arg in "$@"; do
  case "$arg" in
    --all) DELETE_ALL=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log() { echo -e "${CYAN}[TEARDOWN]${NC} $*"; }
ok()  { echo -e "${GREEN}  OK${NC} -- $*"; }

KC="kubectl --context=${PROFILE}"

if ! $KC cluster-info &>/dev/null; then
  echo -e "${RED}Cluster '${PROFILE}' not reachable.${NC}"
  exit 1
fi

NAMESPACES=(control-plane mcp-host mcp-server sandbox-recipes rpc-proxy profiles channels registry)

# ---- Delete CRD instances -------------------------------------------
echo -e "\n${BOLD}=== Delete CRD Instances ===${NC}"
$KC delete communicationchannel --all -n channels 2>/dev/null || true
$KC delete host --all -n mcp-host 2>/dev/null || true
$KC delete context --all -n mcp-server 2>/dev/null || true
$KC delete mcpserver --all -n mcp-server 2>/dev/null || true
$KC delete workflowrecipe --all -n mcp-server 2>/dev/null || true
$KC delete workflowrecipe --all -n sandbox-recipes 2>/dev/null || true
ok "CRD instances deleted"

# ---- Delete deployments & services ----------------------------------
echo -e "\n${BOLD}=== Delete Deployments & Services ===${NC}"

# control-plane (includes nginx gateways and UI)
for name in host-context-controller workflow-recipes control-api control-postgres control-ui \
            nginx-workflow-approval-gateway host-context-controller-api-gateway control-api-rpc-gateway; do
  $KC delete deployment "$name" -n control-plane 2>/dev/null || true
  $KC delete service "$name" -n control-plane 2>/dev/null || true
done
ok "control-plane workloads"

# mcp-host
$KC delete deployment mcp-host -n mcp-host 2>/dev/null || true
$KC delete service mcp-host -n mcp-host 2>/dev/null || true
ok "mcp-host workloads"

# mcp-server
$KC delete deployment mcp-proxy -n mcp-server 2>/dev/null || true
$KC delete service mcp-proxy -n mcp-server 2>/dev/null || true
ok "mcp-server workloads"

# profiles
for name in external-rest-api profile-control-funnel profile-ui; do
  $KC delete deployment "$name" -n profiles 2>/dev/null || true
  $KC delete service "$name" -n profiles 2>/dev/null || true
done
ok "profiles workloads"

# rpc-proxy
$KC delete deployment rpc-proxy -n rpc-proxy 2>/dev/null || true
$KC delete service rpc-proxy -n rpc-proxy 2>/dev/null || true
ok "rpc-proxy workloads"

# channels
for name in clerum-channel-reader mailpit; do
  $KC delete deployment "$name" -n channels 2>/dev/null || true
  $KC delete service "$name" -n channels 2>/dev/null || true
done
ok "channels workloads"

# registry
for name in registry-api registry-minio registry-postgres; do
  $KC delete deployment "$name" -n registry 2>/dev/null || true
  $KC delete service "$name" -n registry 2>/dev/null || true
done
ok "registry workloads"

# ---- Delete PodDisruptionBudgets ------------------------------------
echo -e "\n${BOLD}=== Delete PodDisruptionBudgets ===${NC}"
for ns in "${NAMESPACES[@]}"; do
  $KC delete pdb --all -n "$ns" 2>/dev/null || true
done
ok "PDBs deleted"

# ---- Delete secrets & configmaps ------------------------------------
echo -e "\n${BOLD}=== Delete Secrets & ConfigMaps ===${NC}"

# Secrets
$KC delete secret chatllm-api-keys -n mcp-host 2>/dev/null || true
$KC delete secret clerum-wrc-signing-key -n control-plane 2>/dev/null || true
$KC delete secret control-api-secrets -n control-plane 2>/dev/null || true
$KC delete secret control-postgres -n control-plane 2>/dev/null || true
$KC delete secret inter-service-tokens -n control-plane 2>/dev/null || true
$KC delete secret clerum-channel-reader-credentials -n channels 2>/dev/null || true
$KC delete secret external-rest-api-secrets -n profiles 2>/dev/null || true
$KC delete secret rpc-proxy-secrets -n rpc-proxy 2>/dev/null || true
$KC delete secret registry-api-secrets -n registry 2>/dev/null || true
$KC delete secret registry-postgres -n registry 2>/dev/null || true
$KC delete secret search-api-keys -n mcp-server 2>/dev/null || true
$KC delete secret mcp-mongodb-credentials -n mcp-server 2>/dev/null || true
$KC delete secret mcp-airtable-credentials -n mcp-server 2>/dev/null || true
$KC delete secret control-api-internal-tokens -n control-plane 2>/dev/null || true
$KC delete secret workflow-recipes-secrets -n control-plane 2>/dev/null || true
ok "Secrets deleted"

# ConfigMaps
$KC delete configmap mcp-host-config -n mcp-host 2>/dev/null || true
$KC delete configmap control-api-config -n control-plane 2>/dev/null || true
$KC delete configmap control-api-rpc-gateway -n control-plane 2>/dev/null || true
$KC delete configmap nginx-workflow-approval-gateway -n control-plane 2>/dev/null || true
$KC delete configmap host-context-controller-api-gateway -n control-plane 2>/dev/null || true
$KC delete configmap control-api-public-key -n control-plane 2>/dev/null || true
$KC delete configmap clerum-wrc-public-key -n control-plane 2>/dev/null || true
$KC delete configmap clerum-model-secret-mapping -n mcp-host 2>/dev/null || true
# Legacy cleanup: pre-refactor, the ConfigMap lived in control-plane.
# This line can be removed after all clusters are cut over.
$KC delete configmap clerum-model-secret-mapping -n control-plane 2>/dev/null || true
$KC delete configmap clerum-channel-reader-config -n channels 2>/dev/null || true
$KC delete configmap rpc-proxy-config -n rpc-proxy 2>/dev/null || true
$KC delete configmap registry-api-config -n registry 2>/dev/null || true
$KC delete configmap profile-control-funnel-nginx -n profiles 2>/dev/null || true
$KC delete configmap clerum-wrc-public-key -n sandbox-recipes 2>/dev/null || true
ok "ConfigMaps deleted"

# ---- Delete NetworkPolicies -----------------------------------------
echo -e "\n${BOLD}=== Delete NetworkPolicies ===${NC}"
for ns in "${NAMESPACES[@]}"; do
  $KC delete networkpolicy --all -n "$ns" 2>/dev/null || true
done
ok "NetworkPolicies deleted"

# ---- Delete RBAC (namespace-scoped) ---------------------------------
echo -e "\n${BOLD}=== Delete RBAC ===${NC}"
for ns in "${NAMESPACES[@]}"; do
  $KC get serviceaccount -n "$ns" --no-headers 2>/dev/null \
    | awk '$1 != "default" {print $1}' \
    | xargs -r $KC delete serviceaccount -n "$ns" 2>/dev/null || true
  $KC delete role --all -n "$ns" 2>/dev/null || true
  $KC delete rolebinding --all -n "$ns" 2>/dev/null || true
done
ok "ServiceAccounts, Roles, RoleBindings deleted"

# Cluster-scoped RBAC (Clerum-specific only). The obsolete wrc-trigger names
# remain here only so teardown also cleans profiles created by older releases.
for name in clerum-channel-reader control-api workflow-recipes-cluster-watch wrc-trigger-role control-api-pod-reader; do
  $KC delete clusterrole "$name" 2>/dev/null || true
done
for name in clerum-channel-reader control-api workflow-recipes-cluster-watch wrc-trigger-binding control-api-pod-reader; do
  $KC delete clusterrolebinding "$name" 2>/dev/null || true
done
ok "ClusterRoles & ClusterRoleBindings deleted"

# ---- Delete PVCs ----------------------------------------------------
# Scale down PVC-owning deployments first so PVCs are released (not stuck
# in Terminating while pods still hold the volume mount).
echo -e "\n${BOLD}=== Delete PVCs ===${NC}"
log "Scaling down PVC-owning deployments..."
$KC scale deployment mcp-host          -n mcp-host      --replicas=0 2>/dev/null || true
$KC scale deployment control-postgres  -n control-plane --replicas=0 2>/dev/null || true
$KC scale deployment registry-postgres -n registry      --replicas=0 2>/dev/null || true
$KC scale deployment registry-minio    -n registry      --replicas=0 2>/dev/null || true
log "Waiting for pods to terminate (max 30s)..."
$KC wait pods -l "app=mcp-host"           -n mcp-host      --for=delete --timeout=30s 2>/dev/null || true
$KC wait pods -l "app=control-postgres"   -n control-plane --for=delete --timeout=30s 2>/dev/null || true
$KC wait pods -l "app=registry-postgres"  -n registry      --for=delete --timeout=30s 2>/dev/null || true
$KC wait pods -l "app=registry-minio"     -n registry      --for=delete --timeout=30s 2>/dev/null || true
$KC delete pvc mcp-host-workspace     -n mcp-host      2>/dev/null || true
$KC delete pvc control-postgres-data  -n control-plane 2>/dev/null || true
$KC delete pvc registry-postgres-data -n registry      2>/dev/null || true
$KC delete pvc registry-minio-data    -n registry      2>/dev/null || true
$KC delete pvc --all -n sandbox-recipes 2>/dev/null || true
ok "PVCs deleted"

# ---- Optionally delete namespaces & CRDs ----------------------------
if [ "$DELETE_ALL" = true ]; then
  echo -e "\n${BOLD}=== Delete Namespaces & CRDs ===${NC}"
  for ns in "${NAMESPACES[@]}"; do
    $KC delete namespace "$ns" 2>/dev/null || true
  done
  ok "Namespaces deleted"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  $KC delete -f "${PROJECT_DIR}/charts/clerum-crds/crds/" 2>/dev/null || true
  ok "CRDs deleted"
fi

# ---- Wait for pods to terminate & recover from stuck CNI -------------
echo -e "\n${BOLD}=== Waiting for pods to terminate ===${NC}"
STUCK_TIMEOUT=15
log "Waiting ${STUCK_TIMEOUT}s for pods to finish terminating..."
sleep "$STUCK_TIMEOUT"

stuck_pods() {
  $KC get pods -A --no-headers 2>/dev/null \
    | grep -v '^kube-system' \
    | grep -E 'Terminating|ContainerCreating' \
    || true
}

STUCK=$(stuck_pods)
if [ -n "$STUCK" ]; then
  echo -e "${YELLOW}  Detected stuck pods — restarting calico-node to fix CNI auth...${NC}"
  $KC rollout restart daemonset calico-node -n kube-system 2>/dev/null || true
  $KC rollout status daemonset calico-node -n kube-system --timeout=60s 2>/dev/null || true
  log "Waiting 15s for stuck pods to clear after Calico restart..."
  sleep 15

  STUCK=$(stuck_pods)
  if [ -n "$STUCK" ]; then
    echo -e "${YELLOW}  Still stuck — force-deleting remaining pods...${NC}"
    echo "$STUCK" | awk '{print $2, $1}' | while read -r pod ns; do
      $KC delete pod "$pod" -n "$ns" --force --grace-period=0 2>/dev/null || true
    done
  fi
fi
ok "All pods terminated"

echo ""
echo -e "${GREEN}${BOLD}Teardown complete.${NC}"
if [ "$DELETE_ALL" = false ]; then
  echo -e "Namespaces and CRDs preserved. Use ${CYAN}--all${NC} to delete everything."
fi
