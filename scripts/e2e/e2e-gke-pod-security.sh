#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Pod Security Compliance — E2E validation for pod hardening
# ═══════════════════════════════════════════════════════════════════════
#
# Validates that all Clerum deployments comply with pod security best
# practices: non-root execution, capability dropping, no privilege
# escalation, resource limits, and versioned image tags.
#
# Usage:
#   ./scripts/e2e/e2e-gke-pod-security.sh
#   ./scripts/e2e/e2e-gke-pod-security.sh --verbose
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

log()   { echo -e "${CYAN}[pod-security]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*"; }

# ── Deployments under test ────────────────────────────────────────────
# Format: "namespace/deployment-name"
DEPLOYMENTS=(
  "channels/clerum-channel-reader"
  "control-plane/control-api"
  "control-plane/control-ui"
  "control-plane/workflow-recipes"
  "control-plane/host-context-controller"
  "mcp-server/mcp-proxy"
  "profiles/external-rest-api"
  "profiles/profile-ui"
  "profiles/profile-control-funnel"
  "rpc-proxy/rpc-proxy"
)

# Deployments that may legitimately lack runAsNonRoot (e.g., nginx)
SKIP_NON_ROOT=(
  "profiles/profile-control-funnel"
)

# Deployments allowed to use :latest tag (known exceptions)
ALLOW_LATEST=()

# ── Helper: check if a deployment exists ──────────────────────────────
deployment_exists() {
  local ns="$1" dep="$2"
  kubectl get deployment "$dep" -n "$ns" >/dev/null 2>&1
}

# ── Helper: check if value is in array ────────────────────────────────
in_array() {
  local needle="$1"; shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE Pod Security Compliance${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 1: Pods Run as Non-Root
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: Pods Run as Non-Root"

for pair in "${DEPLOYMENTS[@]}"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"

  if ! deployment_exists "$ns" "$dep"; then
    skip "$ns/$dep: deployment not found"
    continue
  fi

  if in_array "$pair" "${SKIP_NON_ROOT[@]}"; then
    skip "$ns/$dep: runAsNonRoot not expected (nginx-based)"
    continue
  fi

  value=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null)

  if [[ "$value" == "true" ]]; then
    pass "$ns/$dep: runAsNonRoot=true"
  else
    fail "$ns/$dep: runAsNonRoot=${value:-<unset>}"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 2: Capabilities Dropped (ALL)
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: Capabilities Dropped"

for pair in "${DEPLOYMENTS[@]}"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"

  if ! deployment_exists "$ns" "$dep"; then
    skip "$ns/$dep: deployment not found"
    continue
  fi

  value=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].securityContext.capabilities.drop[0]}' 2>/dev/null)

  if [[ "$value" == "ALL" ]]; then
    pass "$ns/$dep: capabilities.drop=[ALL]"
  else
    fail "$ns/$dep: capabilities.drop=[${value:-<unset>}] (expected ALL)"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 3: No Privilege Escalation
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: No Privilege Escalation"

for pair in "${DEPLOYMENTS[@]}"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"

  if ! deployment_exists "$ns" "$dep"; then
    skip "$ns/$dep: deployment not found"
    continue
  fi

  value=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation}' 2>/dev/null)

  if [[ "$value" == "false" ]]; then
    pass "$ns/$dep: allowPrivilegeEscalation=false"
  else
    fail "$ns/$dep: allowPrivilegeEscalation=${value:-<unset>} (expected false)"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 4: Resource Limits Set
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: Resource Limits Set"

for pair in "${DEPLOYMENTS[@]}"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"

  if ! deployment_exists "$ns" "$dep"; then
    skip "$ns/$dep: deployment not found"
    continue
  fi

  mem_limit=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}' 2>/dev/null)
  cpu_limit=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.limits.cpu}' 2>/dev/null)

  if [[ -n "$mem_limit" && -n "$cpu_limit" ]]; then
    pass "$ns/$dep: limits cpu=$cpu_limit memory=$mem_limit"
  elif [[ -n "$mem_limit" ]]; then
    fail "$ns/$dep: memory=$mem_limit but cpu limit missing"
  elif [[ -n "$cpu_limit" ]]; then
    fail "$ns/$dep: cpu=$cpu_limit but memory limit missing"
  else
    fail "$ns/$dep: no resource limits set"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 5: Image Version Tags (no :latest)
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: Image Version Tags (no :latest)"

for pair in "${DEPLOYMENTS[@]}"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"

  if ! deployment_exists "$ns" "$dep"; then
    skip "$ns/$dep: deployment not found"
    continue
  fi

  image=$(kubectl get deployment "$dep" -n "$ns" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)

  if [[ -z "$image" ]]; then
    fail "$ns/$dep: no image found"
    continue
  fi

  # Check for :latest or missing tag (no colon after last slash = implicit latest)
  image_after_slash="${image##*/}"
  if [[ "$image_after_slash" == *":latest" ]]; then
    if in_array "$pair" "${ALLOW_LATEST[@]+"${ALLOW_LATEST[@]}"}"; then
      skip "$ns/$dep: :latest allowed (known exception) — $image"
    else
      fail "$ns/$dep: uses :latest tag — $image"
    fi
  elif [[ "$image_after_slash" != *":"* ]]; then
    # No tag at all = implicit :latest
    if in_array "$pair" "${ALLOW_LATEST[@]+"${ALLOW_LATEST[@]}"}"; then
      skip "$ns/$dep: implicit :latest allowed (known exception) — $image"
    else
      fail "$ns/$dep: no tag (implicit :latest) — $image"
    fi
  else
    tag="${image_after_slash##*:}"
    pass "$ns/$dep: tagged :$tag"
    detail "$image"
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
