#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Complete E2E Suite — runs all GKE validation tests in sequence
# ═══════════════════════════════════════════════════════════════════════
#
# Phases:
#   1. Smoke Test — infrastructure validation (pods, health, NP, CRDs, versions)
#   2. Workflow E2E — 2-step + 4-step workflows with artifact generation
#   3. Security: Secrets & ConfigMaps validation
#   4. Security: JWT auth chain validation
#   5. Security: RBAC enforcement validation
#   6. Security: Pod security compliance
#
# Usage:
#   ./scripts/e2e/e2e-gke-all.sh                 # Run all phases
#   ./scripts/e2e/e2e-gke-all.sh --smoke-only    # Only infrastructure
#   ./scripts/e2e/e2e-gke-all.sh --workflow-only  # Only workflows
#   ./scripts/e2e/e2e-gke-all.sh --skip-workflow  # Skip workflows (faster)
#
# Prerequisites:
#   - GKE cluster connected (kubectl context set)
#   - All Clerum services running v0.9.5+
#   - control-api port-forwarded on :8090
#   - clerum-model-secret-mapping ConfigMap in mcp-host + chatllm-api-keys Secret populated
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

RUN_SMOKE=true
RUN_WORKFLOW=true
RUN_SECURITY=true
for arg in "$@"; do
  case "$arg" in
    --smoke-only) RUN_WORKFLOW=false; RUN_SECURITY=false ;;
    --workflow-only) RUN_SMOKE=false; RUN_SECURITY=false ;;
    --security-only) RUN_SMOKE=false; RUN_WORKFLOW=false ;;
    --skip-workflow) RUN_WORKFLOW=false ;;
    --skip-security) RUN_SECURITY=false ;;
  esac
done

TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS=()

run_suite() {
  local name="$1" script="$2"
  echo ""
  echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║  $name${NC}"
  echo -e "${BOLD}╚═══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  local start_time exit_code
  start_time=$(date +%s)

  if bash "$script" > /tmp/gke-e2e-suite-output.txt 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  local end_time duration
  end_time=$(date +%s)
  duration=$((end_time - start_time))

  # Extract pass/fail counts from output
  local pass_count fail_count
  pass_count=$(grep -c "PASS" /tmp/gke-e2e-suite-output.txt 2>/dev/null || echo "0")
  fail_count=$(grep -c "FAIL" /tmp/gke-e2e-suite-output.txt 2>/dev/null || echo "0")

  # Show last 20 lines (summary area)
  tail -20 /tmp/gke-e2e-suite-output.txt | sed 's/\x1b\[[0-9;]*m//g'

  TOTAL_PASS=$((TOTAL_PASS + pass_count))
  TOTAL_FAIL=$((TOTAL_FAIL + fail_count))

  if [ $exit_code -eq 0 ]; then
    RESULTS+=("${GREEN}PASS${NC} $name ($pass_count tests, ${duration}s)")
  else
    RESULTS+=("${RED}FAIL${NC} $name ($fail_count failures, ${duration}s)")
  fi
}

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE — Complete E2E Test Suite${NC}"
echo -e "${BOLD}  Cluster: $(kubectl config current-context 2>/dev/null || echo 'unknown')${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

# Phase 1: Smoke Test
if [ "$RUN_SMOKE" = true ]; then
  run_suite "Phase 1: Infrastructure Smoke Test" "$SCRIPT_DIR/e2e-gke-smoke.sh"
fi

# Phase 2: Workflow E2E
if [ "$RUN_WORKFLOW" = true ]; then
  run_suite "Phase 2: Workflow E2E (2-step + 4-step)" "$SCRIPT_DIR/e2e-gke-workflow.sh"
fi

# Phase 3-6: Security E2E
if [ "$RUN_SECURITY" = true ]; then
  run_suite "Phase 3: Secrets & ConfigMaps Validation" "$SCRIPT_DIR/e2e-gke-secrets.sh"
  run_suite "Phase 4: JWT Auth Chain Validation" "$SCRIPT_DIR/e2e-gke-auth-chain.sh"
  run_suite "Phase 5: RBAC Enforcement Validation" "$SCRIPT_DIR/e2e-gke-rbac.sh"
  run_suite "Phase 6: Pod Security Compliance" "$SCRIPT_DIR/e2e-gke-pod-security.sh"
fi

# Final Summary
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  FINAL RESULTS${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
for result in "${RESULTS[@]}"; do
  echo -e "  $result"
done
echo ""
echo -e "  Total: ${GREEN}$TOTAL_PASS passed${NC}, ${RED}$TOTAL_FAIL failed${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

if [ $TOTAL_FAIL -gt 0 ]; then
  exit 1
fi
