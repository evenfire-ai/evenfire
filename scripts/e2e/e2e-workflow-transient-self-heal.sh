#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — WRC transient-failure self-heal
# ═══════════════════════════════════════════════════════════════════════
#
# Proves the production behavior that was missing when a controller↔API-server
# blip (connect ETIMEDOUT) latched healthy WorkflowRecipes into the terminal
# `failed` phase with no self-recovery:
#
#   1. A recipe latched `failed` by a *persisted Kubernetes API timeout* message
#      self-heals back to `active` on the next reconcile (no human intervention,
#      no status edit beyond seeding the failure we are recovering from).
#   2. A recipe latched `failed` for a *genuine* reason (non-transient message)
#      STAYS `failed` — the self-heal must not mask real failures.
#
# This is the deterministic, behavioral counterpart to the unit coverage in
# workflow-recipes/src/reconciler/{reconciler,k8sErrors}.test.ts and
# workflow-recipes/src/workflow/workflowReconciler.test.ts.
#
# It only ever writes the `.status` subresource (the documented manual
# workaround) and restores the recipe's original status on exit. The shared
# LIVE DEV cluster is gated behind an explicit opt-in (see below) because a
# wrong auto-selected target or a failed restore can latch a real recipe
# `failed`; disposable minikube/branch profiles need no opt-in.
#
# Usage:
#   CONTEXT=clerum-test ./scripts/e2e/e2e-workflow-transient-self-heal.sh
#   CONTEXT=clerum-detached-<topic> ./scripts/e2e/e2e-workflow-transient-self-heal.sh
#   # Live dev — explicit disposable fixture + opt-in required:
#   E2E_RECIPE_NAME=mongodb-mcp-stack \
#     ALLOW_LIVE_DEV_STATUS_MUTATION=i-understand-the-risk \
#     CONTEXT=gke_your-gcp-project_us-central1-a_example-dev \
#     ./scripts/e2e/e2e-workflow-transient-self-heal.sh
#
# Environment:
#   CONTEXT                          (REQUIRED) kubectl context — must be an allowed Clerum context.
#   E2E_RECIPE_NS                    (default: sandbox-recipes)
#   E2E_RECIPE_NAME                  (default: auto-detect first `active` recipe; REQUIRED on live dev)
#   E2E_TIMEOUT_SECS                 (default: 60) max wait for self-heal
#   E2E_GENUINE_LATCH_SECS           (default: 9) wait for the genuine-failure reconcile in Case 2
#                                    (bump on slow clusters so the assertion reflects a real re-confirm)
#   ALLOW_LIVE_DEV_STATUS_MUTATION   (live dev only) must be `i-understand-the-risk` to run
#                                    against gke_..._example-dev; E2E_RECIPE_NAME is also required there.
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${YELLOW}•${NC} $1"; }
FAILURES=0

NS="${E2E_RECIPE_NS:-sandbox-recipes}"
TIMEOUT_SECS="${E2E_TIMEOUT_SECS:-60}"

# ─── Context safety (CLAUDE.md: never rely on current-context) ────────
if [[ -z "${CONTEXT:-}" ]]; then
  echo -e "${RED}ERROR:${NC} CONTEXT is required (e.g. CONTEXT=clerum-test)."
  exit 2
fi
case "$CONTEXT" in
  clerum-test|clerum-codex-*|clerum-detached-*|gke_your-gcp-project_us-central1-a_example-dev) ;;
  *)
    echo -e "${RED}ERROR:${NC} refusing to run against non-allowed context '$CONTEXT'."
    exit 2
    ;;
esac

# ─── Live-dev mutation gate (P1 safety) ───────────────────────────────
# This script mutates `.status.phase` of a real WorkflowRecipe and relies on an
# EXIT trap to restore it. Against the SHARED live dev cluster a wrong auto-
# selected target or a failed restore leaves a genuine recipe latched `failed`.
# Disposable minikube/branch profiles (clerum-test, clerum-codex-*, clerum-*)
# are safe with no opt-in; the live dev context requires BOTH an explicit
# opt-in AND an explicit target recipe (no auto-select on shared dev).
LIVE_DEV_CONTEXT="gke_your-gcp-project_us-central1-a_example-dev"
if [[ "$CONTEXT" == "$LIVE_DEV_CONTEXT" ]]; then
  case "${ALLOW_LIVE_DEV_STATUS_MUTATION:-}" in
    i-understand-the-risk) ;;
    *)
      echo -e "${RED}ERROR:${NC} refusing to mutate live dev cluster '$CONTEXT' by default."
      echo -e "${RED}ERROR:${NC} This patches a real recipe's .status.phase; a wrong target or a failed"
      echo -e "${RED}ERROR:${NC} restore trap latches it failed. Prefer a disposable profile:"
      echo -e "${YELLOW}•${NC}   CONTEXT=clerum-detached-<topic> ./scripts/e2e/e2e-workflow-transient-self-heal.sh"
      echo -e "${RED}ERROR:${NC} To override on live dev, set an explicit disposable target + the opt-in:"
      echo -e "${YELLOW}•${NC}   E2E_RECIPE_NAME=<disposable-recipe> \\"
      echo -e "${YELLOW}•${NC}   ALLOW_LIVE_DEV_STATUS_MUTATION=i-understand-the-risk \\"
      echo -e "${YELLOW}•${NC}   CONTEXT=$LIVE_DEV_CONTEXT ./scripts/e2e/e2e-workflow-transient-self-heal.sh"
      exit 2
      ;;
  esac
  if [[ -z "${E2E_RECIPE_NAME:-}" ]]; then
    echo -e "${RED}ERROR:${NC} E2E_RECIPE_NAME is REQUIRED on live dev ('$CONTEXT') — refusing to"
    echo -e "${RED}ERROR:${NC} auto-select the first active recipe on a shared cluster."
    exit 2
  fi
  info "LIVE DEV opt-in active — will mutate recipe '$E2E_RECIPE_NAME' on $CONTEXT."
fi

KUBECTL=(kubectl --context="$CONTEXT")

# Transport-shaped timeout message (matches the anchored isRetryableInfraError).
TRANSIENT_MSG='FetchError: request to https://10.96.0.1/apis/clerum.io/v1alpha1/namespaces/mcp-server/contexts/context1 failed, reason: connect ETIMEDOUT 10.96.0.1:443'
GENUINE_MSG='Invalid spec: workload "x" image is required'

wr_phase() { "${KUBECTL[@]}" get wr "$1" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null; }

patch_status() { # name phase message
  "${KUBECTL[@]}" patch wr "$1" -n "$NS" --subresource=status --type=merge \
    -p "{\"status\":{\"phase\":\"$2\",\"message\":$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}}" >/dev/null
}

trigger_reconcile() { # name
  "${KUBECTL[@]}" annotate wr "$1" -n "$NS" "clerum.io/e2e-self-heal=$(date +%s%N)" --overwrite >/dev/null
}

wait_for_phase() { # name expected_phase
  local name="$1" want="$2" waited=0
  while [[ $waited -lt $TIMEOUT_SECS ]]; do
    [[ "$(wr_phase "$name")" == "$want" ]] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

# ─── Resolve target recipe ────────────────────────────────────────────
RECIPE="${E2E_RECIPE_NAME:-}"
if [[ -z "$RECIPE" ]]; then
  RECIPE="$("${KUBECTL[@]}" get wr -n "$NS" \
    -o jsonpath='{range .items[?(@.status.phase=="active")]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
    | head -1)"
fi
if [[ -z "$RECIPE" ]]; then
  echo -e "${RED}ERROR:${NC} no active WorkflowRecipe found in $NS on $CONTEXT (set E2E_RECIPE_NAME)."
  exit 2
fi
info "Target recipe: $RECIPE (ns=$NS, context=$CONTEXT)"

ORIG_PHASE="$(wr_phase "$RECIPE")"
ORIG_MSG="$("${KUBECTL[@]}" get wr "$RECIPE" -n "$NS" -o jsonpath='{.status.message}' 2>/dev/null)"
if [[ "$ORIG_PHASE" != "active" ]]; then
  echo -e "${RED}ERROR:${NC} recipe '$RECIPE' is '$ORIG_PHASE', expected 'active' to run this test safely."
  exit 2
fi

restore() {
  patch_status "$RECIPE" "${ORIG_PHASE:-active}" "${ORIG_MSG:-All workloads deployed}" || true
  "${KUBECTL[@]}" annotate wr "$RECIPE" -n "$NS" "clerum.io/e2e-self-heal-" >/dev/null 2>&1 || true
  info "Restored '$RECIPE' to phase=$ORIG_PHASE."
}
trap restore EXIT

# ─── Case 1: transient-latched recipe self-heals ──────────────────────
info "Case 1 — latching '$RECIPE' failed with a transient API-timeout message…"
patch_status "$RECIPE" failed "$TRANSIENT_MSG"
[[ "$(wr_phase "$RECIPE")" == "failed" ]] && pass "seeded transient failure" || fail "could not seed failure"
trigger_reconcile "$RECIPE"
if wait_for_phase "$RECIPE" active; then
  pass "transient-latched recipe self-healed to active within ${TIMEOUT_SECS}s"
else
  fail "recipe did NOT self-heal (still $(wr_phase "$RECIPE")) — transient self-heal regression"
fi

# ─── Case 2: genuine failure stays failed ─────────────────────────────
info "Case 2 — latching '$RECIPE' failed with a genuine (non-transient) message…"
patch_status "$RECIPE" failed "$GENUINE_MSG"
trigger_reconcile "$RECIPE"
# Wait for the annotation-triggered reconcile to run and re-confirm the genuine
# failure. Under high cluster load 9s may not be enough for the reconcile to
# land, which would let the assertion pass trivially (recipe still failed from
# the seed, not because self-heal correctly kept it failed) — bump
# E2E_GENUINE_LATCH_SECS on slow environments.
sleep "${E2E_GENUINE_LATCH_SECS:-9}"
if [[ "$(wr_phase "$RECIPE")" == "failed" ]]; then
  pass "genuine failure correctly stayed failed (self-heal did not mask it)"
else
  fail "genuine failure was incorrectly cleared to $(wr_phase "$RECIPE") — self-heal too aggressive"
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}PASS${NC} — WRC transient self-heal behaves correctly (heals transient, keeps genuine)."
  exit 0
else
  echo -e "${RED}FAIL${NC} — $FAILURES assertion(s) failed."
  exit 1
fi
