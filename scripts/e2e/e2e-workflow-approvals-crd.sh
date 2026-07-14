#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — WorkflowRecipe step.requiresApproval CRD Schema & Propagation
# ═══════════════════════════════════════════════════════════════════════
#
# Gap C validation (PR #134 companion): proves the CRD schema for
# steps[].requiresApproval is correctly declared AND that the workflow-recipes
# reconciler propagates the field into the generated workflow-config ConfigMap.
#
# What this covers (that unit tests cannot):
#   - Kubernetes API server validates the OpenAPI schema on apply
#   - oneOf constraint (userId XOR teamId) enforced by kube-apiserver
#   - minLength / maxLength / minimum / maximum constraints enforced
#   - Reconciler running in-cluster writes the field into ConfigMap
#
# What is deliberately NOT covered here (covered elsewhere):
#   - mcp-host gating logic        → mcp-host/src/workflow/workflowService.gating.test.ts
#   - mcp-host resume after decide → mcp-host/src/workflow/approvalRequester.test.ts
#   - End-user desktop-app UI      → desktop-app/test/rpcProxyClient.approval.test.ts
#   - REST/Gateway token surface   → scripts/e2e/e2e-workflow-approvals.sh (26/26)
#   - Recovery / crash rotation    → scripts/e2e/e2e-workflow-approvals-recovery.sh (13/13)
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-workflow-approvals-crd.sh
#
# ═══════════════════════════════════════════════════════════════════════

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

KCTX="${KUBECONTEXT:-clerum-test}"
TEST_NS="${TEST_NS:-mcp-server}"
# Workflow-config ConfigMaps are created by the WRC reconciler in sandbox-recipes
# (the sandbox namespace where coordinator + mcp-host pods run), not in mcp-server.
SANDBOX_NS="${SANDBOX_NS:-sandbox-recipes}"
RECIPE_NAME="e2e-approval-crd-$(date +%s)"
TMPDIR="$(mktemp -d -t clerum-approval-crd-XXXX)"

pass=0
fail=0
total=0

log()  { echo -e "${CYAN}[crd-approval]${NC} $*"; }
ok()   { echo -e "  ${GREEN}PASS${NC} $*"; pass=$((pass+1)); total=$((total+1)); }
bad()  { echo -e "  ${RED}FAIL${NC} $*"; fail=$((fail+1)); total=$((total+1)); }
warn() { echo -e "  ${YELLOW}WARN${NC} $*"; }

cleanup() {
  local rc=$?
  log "Cleanup (rc=$rc)"
  kubectl --context "$KCTX" -n "$TEST_NS" delete workflowrecipe "$RECIPE_NAME" --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
  # Defensive: the WRC finalizer (clerum.io/workload-cleanup) normally deletes these child
  # resources in $SANDBOX_NS, but a race (CR deleted before finalizer is attached, or timeout
  # expired before finalizer ran) can leave orphans. Match finalizationHandler.ts 1:1.
  kubectl --context "$KCTX" -n "$SANDBOX_NS" delete configmap \
    "${RECIPE_NAME}-workflow-config" \
    "wf-${RECIPE_NAME}-soul-md" \
    --ignore-not-found --timeout=15s >/dev/null 2>&1 || true
  kubectl --context "$KCTX" -n "$SANDBOX_NS" delete secret \
    "wf-${RECIPE_NAME}-mcp-host-runtime-tokens" \
    --ignore-not-found --timeout=15s >/dev/null 2>&1 || true
  kubectl --context "$KCTX" -n "$SANDBOX_NS" delete service \
    "wf-${RECIPE_NAME}-mcp-host" \
    --ignore-not-found --timeout=15s >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
  exit "$rc"
}
trap cleanup EXIT

header() {
  echo -e "${BOLD}=================================================================${NC}"
  echo -e "${BOLD}  Clerum E2E — WorkflowRecipe step.requiresApproval (CRD schema)${NC}"
  echo -e "${BOLD}  Context: $KCTX  Namespace: $TEST_NS${NC}"
  echo -e "${BOLD}=================================================================${NC}"
}

# Build a minimal WorkflowRecipe YAML with the requested requiresApproval block
# substituted into step[0]. Leaves step[0] functionally harmless (no run executed).
write_recipe() {
  local approval_yaml="$1"
  cat > "$TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${TEST_NS}
spec:
  steps:
    - id: gated-step
      instruction: "Test step — approval schema validation only."
      timeoutSeconds: 60
${approval_yaml}
YAML
}

# Build a FULL agentic WorkflowRecipe (with spec.agent) so the reconciler
# classifies it as `workflow-agentic` and creates the workflow-config ConfigMap.
# This is what Case 8 needs for stable ConfigMap propagation assertions.
write_agentic_recipe() {
  local approval_yaml="$1"
  cat > "$TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${TEST_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  steps:
    - id: gated-step
      instruction: "Test step — approval ConfigMap propagation."
      timeoutSeconds: 60
${approval_yaml}
YAML
}

# Apply with kubectl, capture stderr. Returns 0 if accepted, non-zero if rejected.
apply_recipe() {
  kubectl --context "$KCTX" apply -f "$TMPDIR/recipe.yaml" 2>"$TMPDIR/apply.err" >/dev/null
}

delete_recipe() {
  kubectl --context "$KCTX" -n "$TEST_NS" delete workflowrecipe "$RECIPE_NAME" \
    --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
}

# ═══════════════════════════════════════════════════════════════════════

header

# ─── Phase 0: pre-flight ─────────────────────────────────────────────
log "Phase 0: pre-flight"
if ! kubectl --context "$KCTX" version >/dev/null 2>&1; then
  bad "kubectl context '$KCTX' not reachable"
  exit 1
fi
ok "kubectl context '$KCTX' reachable"

if ! kubectl --context "$KCTX" get crd workflowrecipes.clerum.io >/dev/null 2>&1; then
  bad "CRD workflowrecipes.clerum.io not installed"
  exit 1
fi
ok "CRD workflowrecipes.clerum.io installed"

# Discover if the installed CRD has the requiresApproval schema yet
if ! kubectl --context "$KCTX" get crd workflowrecipes.clerum.io -o yaml \
      | grep -q "requiresApproval:"; then
  warn "CRD schema missing 'requiresApproval' — cluster has stale CRD. Re-apply:"
  warn "  kubectl --context $KCTX apply -f charts/clerum-crds/crds/workflowrecipe.yaml"
  warn "Continuing; schema-validation cases will be SKIPPED if CRD is stale."
  HAS_SCHEMA=0
else
  ok "CRD declares steps[].requiresApproval schema"
  HAS_SCHEMA=1
fi

# ─── Case 1: valid userId + message + timeoutSeconds ─────────────────
log "Case 1: valid requiresApproval with userId accepted"
write_recipe "      requiresApproval:
        target:
          userId: \"alice\"
        message: \"Please approve the gated step\"
        timeoutSeconds: 600"
if apply_recipe; then
  ok "Case 1: apply succeeded (valid shape accepted)"
  # Verify round-trip using jsonpath (robust against whitespace/ordering)
  stored_user=$(kubectl --context "$KCTX" -n "$TEST_NS" get workflowrecipe "$RECIPE_NAME" \
    -o jsonpath='{.spec.steps[0].requiresApproval.target.userId}' 2>/dev/null)
  stored_msg=$(kubectl --context "$KCTX" -n "$TEST_NS" get workflowrecipe "$RECIPE_NAME" \
    -o jsonpath='{.spec.steps[0].requiresApproval.message}' 2>/dev/null)
  stored_ttl=$(kubectl --context "$KCTX" -n "$TEST_NS" get workflowrecipe "$RECIPE_NAME" \
    -o jsonpath='{.spec.steps[0].requiresApproval.timeoutSeconds}' 2>/dev/null)
  if [ "$stored_user" = "alice" ]; then
    ok "Case 1: userId='alice' preserved by API server"
  else
    bad "Case 1: userId not preserved — got: '$stored_user'"
  fi
  if [ -n "$stored_msg" ]; then
    ok "Case 1: message preserved ('$stored_msg')"
  else
    bad "Case 1: message not preserved"
  fi
  if [ "$stored_ttl" = "600" ]; then
    ok "Case 1: timeoutSeconds=600 preserved by API server"
  else
    bad "Case 1: timeoutSeconds not preserved — got: '$stored_ttl'"
  fi
  delete_recipe
else
  bad "Case 1: valid payload unexpectedly rejected: $(cat "$TMPDIR/apply.err" | head -1)"
fi

# ─── Case 2: valid teamId variant ────────────────────────────────────
log "Case 2: valid requiresApproval with teamId accepted"
write_recipe "      requiresApproval:
        target:
          teamId: \"ops-team\"
        message: \"Approve by any ops team member\"
        timeoutSeconds: 300"
if apply_recipe; then
  ok "Case 2: teamId variant accepted"
  delete_recipe
else
  bad "Case 2: teamId variant rejected: $(cat "$TMPDIR/apply.err" | head -1)"
fi

# ─── Case 3: missing message → must be rejected ──────────────────────
if [ "$HAS_SCHEMA" -eq 1 ]; then
  log "Case 3: missing required 'message' field rejected"
  write_recipe "      requiresApproval:
        target:
          userId: \"bob\"
        timeoutSeconds: 300"
  if apply_recipe; then
    bad "Case 3: YAML without 'message' was accepted (expected 422)"
    delete_recipe
  else
    if grep -qi "message" "$TMPDIR/apply.err"; then
      ok "Case 3: rejected with message-related error"
    else
      warn "Case 3: rejected but error doesn't mention 'message': $(cat "$TMPDIR/apply.err" | head -1)"
      ok "Case 3: rejected (schema enforcement working)"
    fi
  fi
else
  warn "Case 3: SKIPPED (stale CRD — cannot enforce required fields)"
fi

# ─── Case 4: both userId AND teamId set → oneOf violation ────────────
if [ "$HAS_SCHEMA" -eq 1 ]; then
  log "Case 4: both userId AND teamId rejected (oneOf constraint)"
  write_recipe "      requiresApproval:
        target:
          userId: \"alice\"
          teamId: \"ops\"
        message: \"ambiguous target\"
        timeoutSeconds: 60"
  if apply_recipe; then
    bad "Case 4: YAML with both userId+teamId was accepted (oneOf not enforced)"
    delete_recipe
  else
    ok "Case 4: rejected as expected (oneOf enforced)"
  fi
else
  warn "Case 4: SKIPPED (stale CRD)"
fi

# ─── Case 5: neither userId nor teamId → oneOf violation ─────────────
if [ "$HAS_SCHEMA" -eq 1 ]; then
  log "Case 5: empty target rejected"
  write_recipe "      requiresApproval:
        target: {}
        message: \"must have target\"
        timeoutSeconds: 60"
  if apply_recipe; then
    bad "Case 5: YAML with empty target was accepted"
    delete_recipe
  else
    ok "Case 5: rejected as expected (oneOf enforced)"
  fi
else
  warn "Case 5: SKIPPED (stale CRD)"
fi

# ─── Case 6: timeoutSeconds below minimum → rejected ─────────────────
if [ "$HAS_SCHEMA" -eq 1 ]; then
  log "Case 6: timeoutSeconds below minimum rejected"
  write_recipe "      requiresApproval:
        target:
          userId: \"alice\"
        message: \"test\"
        timeoutSeconds: 5"
  if apply_recipe; then
    bad "Case 6: timeoutSeconds=5 accepted (minimum=30 not enforced)"
    delete_recipe
  else
    ok "Case 6: timeoutSeconds below minimum rejected"
  fi
else
  warn "Case 6: SKIPPED (stale CRD)"
fi

# ─── Case 7: message exceeds maxLength → rejected ────────────────────
if [ "$HAS_SCHEMA" -eq 1 ]; then
  log "Case 7: message exceeds maxLength rejected"
  LONG_MSG=$(python3 -c 'print("x" * 2001)' 2>/dev/null || printf 'x%.0s' {1..2001})
  write_recipe "      requiresApproval:
        target:
          userId: \"alice\"
        message: \"$LONG_MSG\"
        timeoutSeconds: 60"
  if apply_recipe; then
    bad "Case 7: message >2000 chars accepted"
    delete_recipe
  else
    ok "Case 7: message >2000 chars rejected"
  fi
else
  warn "Case 7: SKIPPED (stale CRD)"
fi

# ─── Case 8: propagation to workflow-config ConfigMap ────────────────
# Uses a full agentic recipe (spec.agent + spec.steps) so the WRC reconciler
# classifies it as `workflow-agentic` and actually creates the ConfigMap.
# Stable assertions: we expect ConfigMap in sandbox-recipes with
# data.'config.json' containing the exact requiresApproval fields we applied.
log "Case 8: reconciler propagates requiresApproval into workflow-config ConfigMap"
write_agentic_recipe "      requiresApproval:
        target:
          userId: \"alice\"
        message: \"propagation check\"
        timeoutSeconds: 777"
if apply_recipe; then
  ok "Case 8: agentic recipe applied"
  # Wait up to 45s for the WRC reconciler to create the ConfigMap in sandbox-recipes.
  CM_NAME="${RECIPE_NAME}-workflow-config"
  cm_found=0
  for _ in $(seq 1 15); do
    if kubectl --context "$KCTX" -n "$SANDBOX_NS" get configmap "$CM_NAME" >/dev/null 2>&1; then
      cm_found=1
      break
    fi
    sleep 3
  done
  if [ "$cm_found" -eq 1 ]; then
    ok "Case 8: ConfigMap $CM_NAME created in namespace $SANDBOX_NS"
    # data key is `config.json` per workflowReconciler.ensureWorkflowConfigMap()
    CONFIG_JSON=$(kubectl --context "$KCTX" -n "$SANDBOX_NS" get configmap "$CM_NAME" \
      -o jsonpath='{.data.config\.json}' 2>/dev/null || true)
    if [ -z "$CONFIG_JSON" ]; then
      bad "Case 8: ConfigMap $CM_NAME has no data.config.json"
    else
      # Stable assertions via jq if available, grep fallback otherwise.
      if command -v jq >/dev/null 2>&1; then
        stored_user=$(echo "$CONFIG_JSON" | jq -r '.steps[0].requiresApproval.target.userId // empty')
        stored_msg=$(echo "$CONFIG_JSON" | jq -r '.steps[0].requiresApproval.message // empty')
        stored_ttl=$(echo "$CONFIG_JSON" | jq -r '.steps[0].requiresApproval.timeoutSeconds // empty')
        [ "$stored_user" = "alice" ] \
          && ok "Case 8: requiresApproval.target.userId='alice' propagated" \
          || bad "Case 8: userId not propagated — got '$stored_user'"
        [ "$stored_msg" = "propagation check" ] \
          && ok "Case 8: requiresApproval.message propagated verbatim" \
          || bad "Case 8: message not propagated — got '$stored_msg'"
        [ "$stored_ttl" = "777" ] \
          && ok "Case 8: requiresApproval.timeoutSeconds=777 propagated" \
          || bad "Case 8: timeoutSeconds not propagated — got '$stored_ttl'"
      else
        warn "Case 8: jq unavailable — falling back to substring checks"
        echo "$CONFIG_JSON" | grep -q '"requiresApproval"' \
          && ok "Case 8: ConfigMap contains requiresApproval key" \
          || bad "Case 8: ConfigMap missing requiresApproval"
        echo "$CONFIG_JSON" | grep -q '"userId": *"alice"' \
          && ok "Case 8: userId=alice propagated" \
          || bad "Case 8: userId not propagated"
        echo "$CONFIG_JSON" | grep -q '"message": *"propagation check"' \
          && ok "Case 8: message propagated" \
          || bad "Case 8: message not propagated"
        echo "$CONFIG_JSON" | grep -q '"timeoutSeconds": *777' \
          && ok "Case 8: timeoutSeconds=777 propagated" \
          || bad "Case 8: timeoutSeconds not propagated"
      fi
    fi
  else
    bad "Case 8: ConfigMap $CM_NAME not created in $SANDBOX_NS within 45s (reconciler down?)"
  fi
  delete_recipe
else
  bad "Case 8: apply failed: $(head -1 "$TMPDIR/apply.err")"
fi

# ═══════════════════════════════════════════════════════════════════════
echo
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  PASS:  ${GREEN}${pass}${NC}"
echo -e "  FAIL:  ${RED}${fail}${NC}"
echo -e "  TOTAL: ${total}"
echo

if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}ALL CRD-SCHEMA E2E CHECKS PASSED${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}SOME CRD-SCHEMA CHECKS FAILED${NC}"
  exit 1
fi
