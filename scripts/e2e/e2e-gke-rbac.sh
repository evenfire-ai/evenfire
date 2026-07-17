#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE RBAC Enforcement Test — Validates Kubernetes RBAC configuration
# ═══════════════════════════════════════════════════════════════════════
#
# Verifies ClusterRoles, ClusterRoleBindings, ServiceAccounts, and
# per-SA permission boundaries (positive + negative checks) on GKE.
#
# Usage:
#   ./scripts/e2e/e2e-gke-rbac.sh
#   ./scripts/e2e/e2e-gke-rbac.sh --verbose
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

log()   { echo -e "${CYAN}[rbac]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*"; }

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE RBAC Enforcement Test${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 1: ClusterRoles Exist
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: ClusterRoles Exist"

for role in control-api-cluster-role control-api-pod-reader wrc-trigger-role host-context-controller-role; do
  if kubectl get clusterrole "$role" >/dev/null 2>&1; then
    pass "ClusterRole $role exists"
    detail "$(kubectl get clusterrole "$role" -o jsonpath='{.metadata.creationTimestamp}')"
  else
    fail "ClusterRole $role missing"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 2: ClusterRoleBindings Exist
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: ClusterRoleBindings Exist"

for binding in control-api-cluster-binding control-api-pod-reader-binding wrc-trigger-binding host-context-controller-binding; do
  if kubectl get clusterrolebinding "$binding" >/dev/null 2>&1; then
    pass "ClusterRoleBinding $binding exists"
    detail "$(kubectl get clusterrolebinding "$binding" -o jsonpath='{.roleRef.name}')"
  else
    fail "ClusterRoleBinding $binding missing"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 3: ServiceAccounts Exist
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: ServiceAccounts Exist"

declare -A SA_MAP=(
  ["control-plane/control-api"]="control-api in control-plane"
  ["mcp-host/mcp-host"]="mcp-host in mcp-host"
  ["channels/clerum-channel-reader"]="clerum-channel-reader in channels"
)

for key in "${!SA_MAP[@]}"; do
  ns="${key%%/*}"
  sa="${key##*/}"
  label="${SA_MAP[$key]}"
  if kubectl get serviceaccount "$sa" -n "$ns" >/dev/null 2>&1; then
    pass "ServiceAccount $label exists"
    detail "$(kubectl get serviceaccount "$sa" -n "$ns" -o jsonpath='{.metadata.creationTimestamp}')"
  else
    fail "ServiceAccount $label missing"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 4: Positive RBAC Checks (authorized actions)
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: Positive RBAC Checks (authorized actions)"

# Helper: assert CAN
assert_can() {
  local sa_fqn="$1" verb="$2" resource="$3" label="$4"
  local ns_flag="${5:-}"
  local result
  if [[ -n "$ns_flag" ]]; then
    result=$(kubectl auth can-i "$verb" "$resource" --as="$sa_fqn" -n "$ns_flag" 2>&1) || true
  else
    result=$(kubectl auth can-i "$verb" "$resource" --as="$sa_fqn" 2>&1) || true
  fi
  if [[ "$result" == "yes" ]]; then
    pass "$label"
    detail "kubectl auth can-i $verb $resource --as=$sa_fqn → yes"
  else
    fail "$label (got: $result)"
    detail "kubectl auth can-i $verb $resource --as=$sa_fqn → $result"
  fi
}

# control-api SA CAN list hosts.clerum.io
assert_can \
  "system:serviceaccount:control-plane:control-api" \
  "list" "hosts.clerum.io" \
  "control-api CAN list hosts.clerum.io"

# control-api SA CAN get secrets in control-plane
assert_can \
  "system:serviceaccount:control-plane:control-api" \
  "get" "secrets" \
  "control-api CAN get secrets in control-plane" \
  "control-plane"

# mcp-host SA CAN list mcpservers.clerum.io
assert_can \
  "system:serviceaccount:mcp-host:mcp-host" \
  "list" "mcpservers.clerum.io" \
  "mcp-host CAN list mcpservers.clerum.io"

echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 5: Negative RBAC Checks (least privilege enforcement)
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: Negative RBAC Checks (least privilege enforcement)"

# Helper: assert CANNOT
assert_cannot() {
  local sa_fqn="$1" verb="$2" resource="$3" label="$4"
  local ns_flag="${5:-}"
  local result
  if [[ -n "$ns_flag" ]]; then
    result=$(kubectl auth can-i "$verb" "$resource" --as="$sa_fqn" -n "$ns_flag" 2>&1) || true
  else
    result=$(kubectl auth can-i "$verb" "$resource" --as="$sa_fqn" 2>&1) || true
  fi
  if [[ "$result" == "no" ]]; then
    pass "$label (denied as expected)"
    detail "kubectl auth can-i $verb $resource --as=$sa_fqn → no"
  else
    fail "$label (ALLOWED — should be denied! got: $result)"
    detail "kubectl auth can-i $verb $resource --as=$sa_fqn → $result"
  fi
}

# default SA in channels CANNOT create clusterrolebindings
assert_cannot \
  "system:serviceaccount:channels:default" \
  "create" "clusterrolebindings" \
  "channels/default CANNOT create clusterrolebindings"

# default SA in mcp-server CANNOT delete secrets in control-plane
assert_cannot \
  "system:serviceaccount:mcp-server:default" \
  "delete" "secrets" \
  "mcp-server/default CANNOT delete secrets in control-plane" \
  "control-plane"

# default SA in profiles CANNOT exec into pods in control-plane
assert_cannot \
  "system:serviceaccount:profiles:default" \
  "create" "pods/exec" \
  "profiles/default CANNOT exec into pods in control-plane" \
  "control-plane"

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
