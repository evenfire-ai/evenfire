#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Smoke Test — Lightweight E2E for production clusters
# ═══════════════════════════════════════════════════════════════════════
#
# Validates all Clerum services are operational on GKE without deploying
# heavy workloads (no MongoDB, PostgreSQL, or WorkflowRecipes).
#
# Tests: health endpoints, cross-service connectivity, NetworkPolicy
# enforcement, CRD availability, and auth chain readiness.
#
# Usage:
#   ./scripts/e2e/e2e-gke-smoke.sh
#   ./scripts/e2e/e2e-gke-smoke.sh --verbose
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

VERBOSE="${1:-}"
PASS=0
FAIL=0
SKIP=0
TOTAL=0

log()   { echo -e "${CYAN}[smoke]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*"; }

# ── Helper: check health endpoint from within a pod ──────────────────
check_health() {
  local ns="$1" deploy="$2" target_url="$3" label="$4"
  local result
  result=$(kubectl exec -n "$ns" "deployment/$deploy" -- \
    wget -qO- --timeout=5 "$target_url" 2>&1) && {
    pass "$label"
    detail "$result"
    return 0
  } || {
    # Check if it's a connection issue vs HTTP error
    if echo "$result" | grep -qi "timed out\|ETIMEDOUT\|Network is unreachable"; then
      fail "$label (timeout — NetworkPolicy blocking?)"
    elif echo "$result" | grep -qi "Connection refused"; then
      fail "$label (connection refused — service down?)"
    elif echo "$result" | grep -qi "server returned error"; then
      pass "$label (reachable, HTTP error response)"
    else
      fail "$label: $result"
    fi
    return 1
  }
}

# ── Helper: require a successful HTTP response from within a pod ─────
check_http_ok() {
  local ns="$1" deploy="$2" target_url="$3" label="$4"
  local result
  result=$(kubectl exec -n "$ns" "deployment/$deploy" -- \
    wget -qO- --timeout=5 "$target_url" 2>&1) && {
    pass "$label"
    detail "$result"
    return 0
  } || {
    if echo "$result" | grep -qi "timed out\|ETIMEDOUT\|Network is unreachable"; then
      fail "$label (timeout — NetworkPolicy blocking?)"
    elif echo "$result" | grep -qi "Connection refused"; then
      fail "$label (connection refused — service down?)"
    elif echo "$result" | grep -qi "server returned error"; then
      fail "$label (backend reachable but not ready)"
    else
      fail "$label: $result"
    fi
    return 1
  }
}

# ── Helper: check pod readiness ──────────────────────────────────────
check_ready() {
  local ns="$1" deploy="$2"
  local ready
  ready=$(kubectl get deployment "$deploy" -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  local desired
  desired=$(kubectl get deployment "$deploy" -n "$ns" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
  if [[ "$ready" == "$desired" && "$ready" != "0" ]]; then
    pass "$ns/$deploy: $ready/$desired ready"
    return 0
  else
    fail "$ns/$deploy: $ready/$desired ready"
    return 1
  fi
}

# ── Helper: check blocked connectivity (expect timeout) ──────────────
check_blocked() {
  local ns="$1" deploy="$2" target_url="$3" label="$4"
  kubectl exec -n "$ns" "deployment/$deploy" -- \
    wget -qO- --timeout=3 "$target_url" >/dev/null 2>&1 && {
    fail "$label (REACHABLE — should be blocked!)"
    return 1
  } || {
    pass "$label (blocked as expected)"
    return 0
  }
}

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE Smoke Test${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 1: Pod Readiness
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: Pod Readiness"

check_ready channels clerum-channel-reader
check_ready control-plane control-api
check_ready control-plane control-ui
check_ready control-plane host-context-controller
check_ready control-plane host-context-controller-api-gateway
check_ready control-plane workflow-recipes
check_ready mcp-host chatllm
check_ready mcp-server mcp-proxy
check_ready profiles external-rest-api
check_ready profiles profile-ui
check_ready rpc-proxy rpc-proxy
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 2: Health Endpoints (from within cluster)
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: Health Endpoints (in-cluster)"

check_health control-plane control-api \
  "http://localhost:8090/health" \
  "control-api /health (localhost)"

check_health control-plane host-context-controller \
  "http://localhost:8081/health" \
  "host-context-controller /health (localhost)"

check_health mcp-host chatllm \
  "http://localhost:8080/v1/runtime/health" \
  "mcp-host /v1/runtime/health (localhost)"

check_health mcp-server mcp-proxy \
  "http://localhost:8083/health" \
  "mcp-proxy /health (localhost)"

check_health mcp-server mcp-proxy \
  "http://localhost:8083/ready" \
  "mcp-proxy /ready (localhost)"

check_health rpc-proxy rpc-proxy \
  "http://localhost:8094/health" \
  "rpc-proxy /health (localhost)"

check_health profiles external-rest-api \
  "http://localhost:8091/health" \
  "external-rest-api /health (localhost)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 3: Cross-Service Connectivity (allowed paths)
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: Cross-Service Connectivity (allowed paths)"

check_health control-plane control-api \
  "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health" \
  "control-api → rpc-proxy:8094 (SSE path)"

check_health profiles external-rest-api \
  "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health" \
  "external-rest-api → rpc-proxy:8094 (SSE path)"

check_health rpc-proxy rpc-proxy \
  "http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/health" \
  "rpc-proxy → mcp-host:8080 (message relay)"

check_http_ok mcp-host chatllm \
  "http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081/ready" \
  "mcp-host → HCC API Gateway:8081 (context discovery ready)"

check_http_ok mcp-server mcp-proxy \
  "http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081/ready" \
  "mcp-proxy → HCC API Gateway:8081 (server polling ready)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 4: NetworkPolicy Enforcement (blocked paths)
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: NetworkPolicy Enforcement (blocked paths)"

# deny-all-mcp-host was added in v0.9.6 security hardening.
# chatllm should NOT be able to reach rpc-proxy or control-api directly.
check_blocked mcp-host chatllm \
  "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health" \
  "mcp-host → rpc-proxy (reverse blocked by deny-all)"

check_blocked mcp-host chatllm \
  "http://control-api.control-plane.svc.cluster.local:8090/health" \
  "mcp-host → control-api (no direct access)"

check_blocked control-plane control-api \
  "http://chatllm.mcp-host.svc.cluster.local:8080/health" \
  "control-api → mcp-host (must go through rpc-proxy)"

check_blocked profiles external-rest-api \
  "http://chatllm.mcp-host.svc.cluster.local:8080/health" \
  "external-rest-api → mcp-host (must go through rpc-proxy)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 5: CRD Availability
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: CRD Availability"

for crd in communicationchannels.clerum.io contexts.clerum.io hosts.clerum.io mcpservers.clerum.io workflowrecipes.clerum.io workflowrecipepolicies.clerum.io; do
  if kubectl get crd "$crd" >/dev/null 2>&1; then
    pass "CRD $crd exists"
  else
    fail "CRD $crd missing"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 6: Image Version Verification
# ═════════════════════════════════════════════════════════════════════
log "Phase 6: Image Version Verification"

EXPECTED_TAG="${EXPECTED_TAG:-0.9.5}"
for pair in "channels/clerum-channel-reader" "control-plane/control-api" "control-plane/control-ui" "control-plane/host-context-controller" "control-plane/workflow-recipes" "mcp-host/chatllm" "mcp-server/mcp-proxy" "profiles/external-rest-api" "profiles/profile-ui" "rpc-proxy/rpc-proxy"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"
  image=$(kubectl get deployment "$dep" -n "$ns" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)
  if echo "$image" | grep -q ":${EXPECTED_TAG}$"; then
    pass "$ns/$dep: $EXPECTED_TAG"
  else
    fail "$ns/$dep: expected $EXPECTED_TAG, got $(echo "$image" | grep -o ':[^:]*$')"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 7: RBAC Validation
# ═════════════════════════════════════════════════════════════════════
log "Phase 7: RBAC Validation"

for cr in control-api control-api-pod-reader wrc-trigger-role clerum-channel-reader workflow-recipes-cluster-watch; do
  if kubectl get clusterrole "$cr" >/dev/null 2>&1; then
    pass "ClusterRole $cr exists"
  else
    fail "ClusterRole $cr missing"
  fi
done

for crb in control-api control-api-pod-reader wrc-trigger-binding clerum-channel-reader workflow-recipes-cluster-watch; do
  if kubectl get clusterrolebinding "$crb" >/dev/null 2>&1; then
    pass "ClusterRoleBinding $crb exists"
  else
    fail "ClusterRoleBinding $crb missing"
  fi
done

for pair in "control-plane/control-api" "mcp-host/mcp-host" "channels/clerum-channel-reader" "control-plane/workflow-recipes"; do
  ns="${pair%%/*}"
  sa="${pair##*/}"
  if kubectl get serviceaccount "$sa" -n "$ns" >/dev/null 2>&1; then
    pass "ServiceAccount $ns/$sa exists"
  else
    fail "ServiceAccount $ns/$sa missing"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 8: Secrets & ConfigMaps Presence
# ═════════════════════════════════════════════════════════════════════
log "Phase 8: Secrets & ConfigMaps Presence"

for pair in "control-plane/control-api-secrets" "rpc-proxy/rpc-proxy-secrets" "profiles/external-rest-api-secrets" "control-plane/clerum-wrc-signing-key"; do
  ns="${pair%%/*}"
  name="${pair##*/}"
  if kubectl get secret "$name" -n "$ns" >/dev/null 2>&1; then
    pass "Secret $ns/$name exists"
  else
    fail "Secret $ns/$name missing"
  fi
done

for pair in "mcp-host/mcp-host-config" "control-plane/control-api-config" "mcp-host/clerum-model-secret-mapping" "sandbox-recipes/clerum-wrc-public-key"; do
  ns="${pair%%/*}"
  name="${pair##*/}"
  if kubectl get configmap "$name" -n "$ns" >/dev/null 2>&1; then
    pass "ConfigMap $ns/$name exists"
  else
    fail "ConfigMap $ns/$name missing"
  fi
done

# Auth config validation
auth_enabled=$(kubectl get configmap mcp-host-config -n mcp-host -o jsonpath='{.data.CLERUM_ENABLE_AUTH}' 2>/dev/null)
if [[ "$auth_enabled" == "true" ]]; then
  pass "CLERUM_ENABLE_AUTH=true"
else
  fail "CLERUM_ENABLE_AUTH=${auth_enabled:-missing} (expected true)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 9: Pod Security Compliance
# ═════════════════════════════════════════════════════════════════════
log "Phase 9: Pod Security Compliance (spot checks)"

for pair in "channels/clerum-channel-reader" "control-plane/control-api" "control-plane/workflow-recipes" "mcp-server/mcp-proxy" "rpc-proxy/rpc-proxy" "profiles/external-rest-api"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"
  non_root=$(kubectl get deployment "$dep" -n "$ns" -o jsonpath='{.spec.template.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null)
  caps=$(kubectl get deployment "$dep" -n "$ns" -o jsonpath='{.spec.template.spec.containers[0].securityContext.capabilities.drop[0]}' 2>/dev/null)
  if [[ "$non_root" == "true" ]]; then
    pass "$ns/$dep: runAsNonRoot=true"
  else
    fail "$ns/$dep: runAsNonRoot=${non_root:-missing}"
  fi
  if [[ "$caps" == "ALL" ]]; then
    pass "$ns/$dep: capabilities.drop=[ALL]"
  else
    fail "$ns/$dep: capabilities.drop=${caps:-missing}"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 10: deny-all NetworkPolicies (all namespaces)
# ═════════════════════════════════════════════════════════════════════
log "Phase 10: deny-all NetworkPolicies"

for ns in channels profiles control-plane mcp-host mcp-server rpc-proxy sandbox-recipes; do
  nps=$(kubectl get networkpolicy -n "$ns" -o name 2>/dev/null || echo "")
  if echo "$nps" | grep -qi "deny-all"; then
    pass "$ns: deny-all NetworkPolicy present"
  else
    fail "$ns: deny-all NetworkPolicy MISSING"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ALL PASSED: $PASS/$TOTAL tests passed ($SKIP skipped)${NC}"
else
  echo -e "${RED}${BOLD}  FAILURES: $FAIL/$TOTAL tests failed ($PASS passed, $SKIP skipped)${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

exit $FAIL
