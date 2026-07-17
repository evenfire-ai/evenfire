#!/bin/bash
set -euo pipefail

PROFILE="clerum-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRC_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$WRC_DIR")"
HCC_DIR="${REPO_ROOT}/host-context-controller"

# Validate prerequisites
for cmd in minikube helm docker kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' is required but not found in PATH."; exit 1; }
done

echo "=== Creating minikube cluster: ${PROFILE} ==="
minikube start --profile "${PROFILE}" --cpus 2 --memory 4096 --driver docker

# Point kubectl to minikube
eval "$(minikube -p "${PROFILE}" docker-env)"
export KUBECONFIG="$(minikube -p "${PROFILE}" kubeconfig)"

echo "=== Creating namespaces ==="
for NS in control-plane mcp-server mcp-host sandbox-recipes rpc-proxy; do
  kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
  kubectl label namespace "${NS}" kubernetes.io/metadata.name="${NS}" --overwrite
done

# Phase 8: L0 deny-all policies are now created dynamically by HCC via
# ensureDefaultDeny() with name "deny-all-{ns}" and label "default-deny".
# Remove legacy static policies if they exist from previous setup runs.
echo "=== Cleaning up legacy L0 deny-all NetworkPolicies ==="
for NS in control-plane mcp-server mcp-host sandbox-recipes rpc-proxy; do
  kubectl delete networkpolicy default-deny-all -n "${NS}" --ignore-not-found 2>/dev/null || true
done

echo "=== Installing CRDs via Helm ==="
helm install clerum-crds "${REPO_ROOT}/charts/clerum-crds" --wait 2>/dev/null \
  || helm upgrade clerum-crds "${REPO_ROOT}/charts/clerum-crds" --wait

echo "=== Building images in minikube ==="
# Pin Docker API version to match minikube's embedded Docker daemon
export DOCKER_API_VERSION=1.41
docker build -t clerum/workflow-recipes:test "${WRC_DIR}"
docker build -t clerum/host-context-controller:test "${HCC_DIR}"

# Build mock MCP server for E2E operational tests
echo "Building mock-mcp-server..."
docker build -t clerum/mock-mcp-server:test "${REPO_ROOT}/tests/e2e/fixtures/mock-mcp-server"

echo "=== Deploying HCC (must run before WRC — creates L0/L1 policies) ==="
kubectl apply -f "${HCC_DIR}/deploy/"
# Override image to use locally-built version (deploy uses registry.digitalocean.com)
kubectl set image deployment/host-context-controller \
  host-context-controller=clerum/host-context-controller:test \
  -n control-plane
kubectl patch deployment host-context-controller -n control-plane \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"host-context-controller","imagePullPolicy":"Never"}]}}}}'
echo "=== Waiting for HCC pod to be ready ==="
kubectl rollout status deployment/host-context-controller -n control-plane --timeout=120s

echo "=== Deploying WRC ==="
kubectl apply -f "${WRC_DIR}/deploy/"
echo "=== Waiting for WRC pod to be ready ==="
kubectl wait --for=condition=Ready pod -l app=workflow-recipes -n control-plane --timeout=120s

# Give HCC time to create L0 deny-all and L1 infrastructure policies
echo "=== Waiting for HCC to reconcile L0/L1 NetworkPolicies ==="
sleep 5
for NS in mcp-server mcp-host sandbox-recipes rpc-proxy; do
  kubectl wait --for=jsonpath='{.metadata.name}'="deny-all-${NS}" \
    networkpolicy "deny-all-${NS}" -n "${NS}" --timeout=30s 2>/dev/null || \
    echo "WARNING: deny-all-${NS} not yet created (HCC may need more time)"
done

echo "=== Minikube cluster ready ==="
echo "Profile: ${PROFILE}"
echo "HCC pod: $(kubectl get pod -l app=host-context-controller -n control-plane -o name)"
echo "WRC pod: $(kubectl get pod -l app=workflow-recipes -n control-plane -o name)"
echo ""
echo "=== Set KUBECONFIG in your shell before running tests ==="
echo "eval \$(minikube -p ${PROFILE} docker-env)"
echo "export KUBECONFIG=\$(minikube -p ${PROFILE} kubeconfig)"
