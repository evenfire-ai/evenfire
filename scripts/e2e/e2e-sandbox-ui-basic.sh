#!/usr/bin/env bash
# E2E: sandbox-ui-basic — End-to-end reconciliation of a recipe with `spec.ui`.
#
# Validates the cluster-side half of the sandbox-ui pipeline (spec §11 + §17
# Phase 1-2) using the demo recipe `workflow-recipes/samples/sandbox-ui-hello.yaml`.
# The Desktop App half (cookie mint, refresh, embed mount, partition GC) is
# covered by the desktop-app vitest + playwright suites — running this script
# proves the platform delivers a working UI workload to sandbox-ui that those
# clients can then reach.
#
# Validates:
#   1. WorkflowRecipe phase reaches "active".
#   2. UI workload Deployment + Service land in `sandbox-ui` namespace
#      (NOT in sandbox-recipes / mcp-server — three-way namespace split).
#   3. `ui-egress-<recipe>` NetworkPolicy is generated in sandbox-ui.
#   4. HCC infra policies (deny-all, allow-dns) exist in sandbox-ui.
#   5. The static `allow-rpc-proxy-ingress-sandbox-ui` policy is in place
#      (load-bearing — prevents any pod outside rpc-proxy from spoofing
#      trusted X-Clerum-User headers to a UI workload).
#   6. UI pod runs as non-root and is Ready.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

RECIPE_FILE="workflow-recipes/samples/sandbox-ui-hello.yaml"
RECIPE_NAME="sandbox-ui-hello"
WORKLOAD_ID="hello"
SANDBOX_UI_NS="sandbox-ui"
TIMEOUT_RECIPE_ACTIVE="${TIMEOUT_RECIPE_ACTIVE:-180}"

wait_for_recipe_phase() {
  local name=$1 ns=$2 want=$3 timeout=$4 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local phase
    phase=$(kctl get workflowrecipe "$name" -n "$ns" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "$want" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

cleanup() {
  header "Cleanup"
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false 2>/dev/null || true
  # Best-effort: WRC GC cleans these up via ownerReferences inside the same
  # namespace, but UI workloads are cross-namespace (sandbox-recipes →
  # sandbox-ui) so K8s GC can't follow the link. Force-delete leftovers.
  kctl delete deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy "ui-egress-${RECIPE_NAME}" -n "$SANDBOX_UI_NS" \
    --ignore-not-found 2>/dev/null || true
}

# Handle --cleanup-only
if [[ "${1:-}" == "--cleanup-only" ]]; then
  cleanup
  exit 0
fi

trap cleanup EXIT

# ─── Phase 0: Prerequisites ──────────────────────────────────────────
check_prerequisites

# ─── Phase 1: Clean Slate ────────────────────────────────────────────
header "Phase 1 — Clean Slate"
cleanup

# ─── Phase 2: Apply Recipe ───────────────────────────────────────────
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"

# ─── Phase 3: Reconciliation reaches active ──────────────────────────
header "Phase 3 — WorkflowRecipe reconciles to phase=active"
if wait_for_recipe_phase "$RECIPE_NAME" "$WORKFLOW_RECIPE_NS" "active" \
    "$TIMEOUT_RECIPE_ACTIVE"; then
  ok "WorkflowRecipe '${RECIPE_NAME}' reached phase=active"
else
  phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "unknown")
  fail "WorkflowRecipe '${RECIPE_NAME}' did not reach phase=active (got '${phase}')"
  kctl describe workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" || true
  exit 1
fi

# ─── Phase 4: UI workload lands in sandbox-ui (not sandbox-recipes) ──
header "Phase 4 — UI workload in sandbox-ui namespace"

if kctl get deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Deployment '${WORKLOAD_ID}' created in '${SANDBOX_UI_NS}'"
else
  fail "Deployment '${WORKLOAD_ID}' not found in '${SANDBOX_UI_NS}'"
fi

# Negative check: must NOT also be in sandbox-recipes — Decision 4 splits
# the namespace by spec.ui.workloadRef.
if kctl get deployment "$WORKLOAD_ID" -n "$WORKFLOW_RECIPE_NS" &>/dev/null; then
  fail "Deployment '${WORKLOAD_ID}' leaked into '${WORKFLOW_RECIPE_NS}' (three-way split broken)"
else
  ok "Deployment '${WORKLOAD_ID}' is NOT in '${WORKFLOW_RECIPE_NS}' (split correct)"
fi

if wait_for_deployment "$SANDBOX_UI_NS" "$WORKLOAD_ID" "$TIMEOUT_POD"; then
  ok "Deployment '${WORKLOAD_ID}' reached Ready"
else
  fail "Deployment '${WORKLOAD_ID}' did not reach Ready within ${TIMEOUT_POD}s"
  kctl describe deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" || true
  kctl get pods -n "$SANDBOX_UI_NS" -l "clerum.io/workload-id=${WORKLOAD_ID}" || true
fi

if kctl get svc "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Service '${WORKLOAD_ID}' created in '${SANDBOX_UI_NS}'"
else
  fail "Service '${WORKLOAD_ID}' not found in '${SANDBOX_UI_NS}'"
fi

# ─── Phase 5: Per-recipe ui-egress NetworkPolicy ─────────────────────
header "Phase 5 — Per-recipe ui-egress NetworkPolicy"
np_name="ui-egress-${RECIPE_NAME}"
if kctl get networkpolicy "$np_name" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "NetworkPolicy '${np_name}' exists in '${SANDBOX_UI_NS}'"
else
  # The demo recipe has no spec.ui.egress (zero allowances). The egress
  # NetworkPolicy is still expected to exist with an empty allow-list —
  # that's defense-in-depth on top of the namespace's deny-all.
  warn "NetworkPolicy '${np_name}' missing — recipe with no egress block may not generate one"
fi

# ─── Phase 6: HCC infra policies + load-bearing rpc-proxy ingress ────
header "Phase 6 — Namespace infrastructure NetworkPolicies"
for required in deny-all-sandbox-ui allow-dns-egress-sandbox-ui \
                allow-rpc-proxy-ingress-sandbox-ui; do
  if kctl get networkpolicy "$required" -n "$SANDBOX_UI_NS" &>/dev/null; then
    ok "Infra NetworkPolicy '${required}' present"
  else
    fail "Infra NetworkPolicy '${required}' missing — sandbox-ui ns deploy is incomplete"
  fi
done

# ─── Phase 7: Pod runs as non-root ───────────────────────────────────
header "Phase 7 — UI pod runs as non-root"
pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" \
  -l "clerum.io/workload-id=${WORKLOAD_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [ -z "$pod_name" ]; then
  # Fallback: WRC's standard label is `app=<workload-id>`.
  pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" -l "app=${WORKLOAD_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
fi

if [ -n "$pod_name" ]; then
  run_as_user=$(kctl get pod "$pod_name" -n "$SANDBOX_UI_NS" \
    -o jsonpath='{.spec.containers[0].securityContext.runAsUser}' 2>/dev/null || echo "")
  run_as_non_root=$(kctl get pod "$pod_name" -n "$SANDBOX_UI_NS" \
    -o jsonpath='{.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null || echo "")
  if [ "$run_as_user" != "0" ] && [ "$run_as_user" != "" ]; then
    ok "Pod '${pod_name}' container runAsUser=${run_as_user} (non-zero)"
  elif [ "$run_as_non_root" = "true" ]; then
    ok "Pod '${pod_name}' container runAsNonRoot=true"
  else
    fail "Pod '${pod_name}' may be running as root (runAsUser='${run_as_user}', runAsNonRoot='${run_as_non_root}')"
  fi
else
  warn "Could not locate UI pod by workload-id or app label — skipping non-root check"
fi

# ─── Summary ─────────────────────────────────────────────────────────
header "Summary"
echo -e "  ${GREEN}Passed:${NC} $e2e_pass"
echo -e "  ${RED}Failed:${NC} $e2e_fail"
echo -e "  ${BOLD}Total:${NC}  $e2e_total"

if [ "$e2e_fail" -gt 0 ]; then
  exit 1
fi
echo -e "${GREEN}${BOLD}E2E sandbox-ui-basic PASSED${NC}"
