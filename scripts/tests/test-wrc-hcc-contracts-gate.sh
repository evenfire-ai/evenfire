#!/usr/bin/env bash
# Static source-contract assertions intentionally use literal shell syntax.
# shellcheck disable=SC2016
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-hcc-contracts.sh"
RUNTIME_GATE="${ROOT}/scripts/e2e/e2e-wrc-hcc-context-noop-resync.sh"
MAKEFILE="${ROOT}/Makefile"
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

if bash -n "$GATE"; then
  pass "WRC-HCC contracts gate has valid bash syntax"
else
  fail "WRC-HCC contracts gate has invalid bash syntax"
fi

if bash -n "$RUNTIME_GATE"; then
  pass "WRC-HCC Context no-op/resync gate has valid bash syntax"
else
  fail "WRC-HCC Context no-op/resync gate has invalid bash syntax"
fi

# The Phase 2 fixture has steps, so the admission policy requires an explicit
# trigger. Keep this immediately alongside the fixture's agent/steps contract
# so the E2E cannot regress into an admission-only false negative.
phase_two_fixture="$(sed -n '/^header "Phase 2 - WRC toolsCalled args status contract"$/,/^YAML$/p' "$GATE")"
if [[ "$phase_two_fixture" == *$'  triggers:\n    onDemand: {}'* ]] &&
   [[ "$phase_two_fixture" == *$'  steps:'* ]]; then
  pass "WRC-HCC Phase 2 fixture declares its required on-demand trigger"
else
  fail "WRC-HCC Phase 2 fixture can be rejected before its status contract runs"
fi

if grep -Fq 'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"' "$RUNTIME_GATE" &&
   grep -Fq 'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"' "$RUNTIME_GATE" &&
   grep -Fq 'require_branch_owned_hcc_gate "$HCC_NS"' "$RUNTIME_GATE" &&
   grep -Fq 'acquire_hcc_watch_gate_lock' "$RUNTIME_GATE" &&
   grep -Fq 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$RUNTIME_GATE" &&
   grep -Fq 'E2E_WRC_HCC_CONTEXT_FAULT_INJECTION' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate owns and acknowledges its branch-scoped fault window"
else
  fail "WRC-HCC runtime gate can mutate HCC without branch ownership, lock, or acknowledgement"
fi

runtime_acquire_line="$(grep -nF 'acquire_hcc_watch_gate_lock ||' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_fixture_mutation_line="$(grep -nF 'CONTEXT_CREATED=1' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
runtime_hcc_mutation_line="$(grep -nF 'HCC_ENV_MUTATED=1' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
runtime_restore_line="$(grep -nF 'restore_hcc_resync_config >/dev/null' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_finalize_line="$(grep -nF 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_pass_line="$(grep -nF 'header "WRC/HCC Context no-op and periodic resync gate passed"' "$RUNTIME_GATE" | cut -d: -f1)"
if [ -n "$runtime_acquire_line" ] && [ -n "$runtime_fixture_mutation_line" ] &&
   [ -n "$runtime_hcc_mutation_line" ] &&
   [ "$runtime_acquire_line" -lt "$runtime_fixture_mutation_line" ] &&
   [ "$runtime_acquire_line" -lt "$runtime_hcc_mutation_line" ] &&
   [ -n "$runtime_restore_line" ] && [ -n "$runtime_finalize_line" ] &&
   [ -n "$runtime_pass_line" ] &&
   [ "$runtime_restore_line" -lt "$runtime_finalize_line" ] &&
   [ "$runtime_finalize_line" -lt "$runtime_pass_line" ]; then
  pass "WRC-HCC runtime gate acquires before mutation and restores/finalizes before PASS"
else
  fail "WRC-HCC runtime gate mutation, restoration, lock, or PASS ordering is unsafe"
fi

if grep -Fq 'kind: WorkflowRecipe' "$RUNTIME_GATE" &&
   grep -Fq 'contextRef: ${CONTEXT_NAME}' "$RUNTIME_GATE" &&
   grep -Fq 'transport:' "$RUNTIME_GATE" &&
   grep -Fq 'context_projection_converged' "$RUNTIME_GATE" &&
   grep -Fq 'WORKLOAD_SELECTOR="clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=mock-tools"' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_workload_deployment_json' "$RUNTIME_GATE" &&
   ! grep -Fq 'kctl patch context' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate follows the real WorkflowRecipe projection and its assigned workload identity"
else
  fail "WRC-HCC runtime gate bypasses WRC or invents the assigned workload identity"
fi

if grep -Fq 'wrc_reconciled_after "$reconciles_before"' "$RUNTIME_GATE" &&
   grep -Fq 'context_identity_is_original' "$RUNTIME_GATE" &&
   grep -Fq 'a recipe-only change emitted a no-op Context PUT' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate proves WRC ran while Context resourceVersion stayed fixed"
else
  fail "WRC-HCC runtime gate can claim no-op without proving the reconcile ran or RV stayed fixed"
fi

if grep -Fq 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${RESYNC_SECONDS}' "$RUNTIME_GATE" &&
   grep -Fq 'kctl delete networkpolicy "$CONTEXT_POLICY"' "$RUNTIME_GATE" &&
   grep -Fq 'probe_mcp_tcp_connectivity' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_runtime_still_ready' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_data_plane_is_policy_blocked' "$RUNTIME_GATE" &&
   grep -Fq 'limits: {cpu: 50m, memory: 128Mi}' "$RUNTIME_GATE" &&
   grep -Fq 'context_policy_recreated_from_snapshot' "$RUNTIME_GATE" &&
   grep -Fq 'hcc_identity_is_stable' "$RUNTIME_GATE" &&
   grep -Fq 'restore_hcc_resync_config' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate attributes real policy loss and proves in-process periodic recovery with exact restoration"
else
  fail "WRC-HCC runtime gate can pass without attributed policy loss, stable HCC identity, or config restoration"
fi

if grep -Fq 'name:"add",arguments:{a:19,b:23}' "$RUNTIME_GATE" &&
   grep -Fq 'add result did not contain 42' "$RUNTIME_GATE" &&
   grep -Fq 'businessSignal:"add(19,23)=42"' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate carries a non-vacuous MCP business signal across the fault"
else
  fail "WRC-HCC runtime gate checks only policy presence and lacks a business signal"
fi

if grep -Fq '.PHONY: test-e2e-wrc-hcc-context-noop-resync' "$MAKEFILE" &&
   grep -Fq 'E2E_WRC_HCC_CONTEXT_FAULT_INJECTION=1' "$MAKEFILE" &&
   grep -Fq 'MINIKUBE_PROFILE=$(E2E_KUBECONTEXT)' "$MAKEFILE"; then
  pass "Makefile exposes the WRC-HCC runtime gate only through an explicit branch-profile target"
else
  fail "Makefile does not expose the WRC-HCC runtime gate with explicit profile ownership"
fi

exit "$FAIL"
