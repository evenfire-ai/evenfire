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
runtime_wrc_restore_line="$(grep -nF 'restore_wrc_log_level_config >/dev/null' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_restore_line="$(grep -nF 'restore_hcc_resync_config >/dev/null' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_finalize_line="$(grep -nF 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_summary_line="$(grep -nF 'if ! persist_final_summary; then' "$RUNTIME_GATE" | cut -d: -f1)"
runtime_pass_line="$(grep -nF 'header "WRC/HCC Context no-op and periodic resync gate passed"' "$RUNTIME_GATE" | cut -d: -f1)"
if [ -n "$runtime_acquire_line" ] && [ -n "$runtime_fixture_mutation_line" ] &&
   [ -n "$runtime_hcc_mutation_line" ] &&
   [ "$runtime_acquire_line" -lt "$runtime_fixture_mutation_line" ] &&
   [ "$runtime_acquire_line" -lt "$runtime_hcc_mutation_line" ] &&
   [ -n "$runtime_wrc_restore_line" ] && [ -n "$runtime_restore_line" ] &&
   [ -n "$runtime_finalize_line" ] && [ -n "$runtime_summary_line" ] &&
   [ -n "$runtime_pass_line" ] &&
   [ "$runtime_wrc_restore_line" -lt "$runtime_finalize_line" ] &&
   [ "$runtime_restore_line" -lt "$runtime_finalize_line" ] &&
   [ "$runtime_finalize_line" -lt "$runtime_summary_line" ] &&
   [ "$runtime_summary_line" -lt "$runtime_pass_line" ]; then
  pass "WRC-HCC runtime gate acquires before mutation and restores/finalizes before PASS"
else
  fail "WRC-HCC runtime gate mutation, restoration, lock, or PASS ordering is unsafe"
fi

if grep -Fq 'kind: WorkflowRecipe' "$RUNTIME_GATE" &&
   grep -Fq 'contextRef: ${CONTEXT_NAME}' "$RUNTIME_GATE" &&
   grep -Fq 'transport:' "$RUNTIME_GATE" &&
   grep -Fq 'context_projection_converged' "$RUNTIME_GATE" &&
   grep -Fq 'WORKLOAD_SELECTOR="clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=mock-tools"' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_workload_deployment_named_json' "$RUNTIME_GATE" &&
   ! grep -Fq 'kind: Context' "$RUNTIME_GATE" &&
   ! grep -Fq 'kctl patch context' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate makes WRC create the shared Context and follows its assigned workload identity"
else
  fail "WRC-HCC runtime gate pre-creates/bypasses Context or invents the assigned workload identity"
fi

if grep -Fq 'kind:"Host"' "$RUNTIME_GATE" &&
   grep -Fq 'SOURCE_HOST_NAME="${E2E_WRC_HCC_SOURCE_HOST:-chatllm}"' "$RUNTIME_GATE" &&
   grep -Fq 'second_workload_patch=' "$RUNTIME_GATE" &&
   grep -Fq 'expanded_context_projection_converged' "$RUNTIME_GATE" &&
   grep -Fq 'context_after_real_generation" -ne $((context_before_real_generation + 1))' "$RUNTIME_GATE" &&
   grep -Fq 'wait_for_positive_host_fanout 90 "$fanout_window_start" "$host_urgent_before"' "$RUNTIME_GATE" &&
   grep -Fq 'target_witnesses" = 1' "$RUNTIME_GATE" &&
   grep -Fq 'all_witnesses" = 1' "$RUNTIME_GATE" &&
   grep -Fq 'fleet" -gt 0' "$RUNTIME_GATE" &&
   grep -Fq 'failures" -gt 0' "$RUNTIME_GATE" &&
   grep -Fq 'context_netpol_failure_count' "$RUNTIME_GATE" &&
   grep -Fq 'probe_host_mcp_business_signal "$SECOND_MCP_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'real WRC Context change fanned out to a stable, Ready Host' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate witnesses a real WRC Context change in a correctly configured Host"
else
  fail "WRC-HCC runtime gate lacks a real Host, urgent completion, or positive business witness"
fi

if grep -Fq 'kctl annotate context "$CONTEXT_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC=0' "$RUNTIME_GATE" &&
   grep -Fq 'kctl rollout restart deployment/"$HCC_DEPLOY"' "$RUNTIME_GATE" &&
   grep -Fq 'HCC startup NetworkPolicy pass did not drain before metadata-only proof' "$RUNTIME_GATE" &&
   grep -Fq 'hcc_metadata_only_event_after "$metadata_events_before"' "$RUNTIME_GATE" &&
   grep -Fq 'kctl delete networkpolicy "$SECOND_RPC_EGRESS_POLICY"' "$RUNTIME_GATE" &&
   grep -Fq 'policy_recreated_from_snapshot "$RPC_PROXY_NS" "$SECOND_RPC_EGRESS_POLICY"' "$RUNTIME_GATE" &&
   grep -Fq 'METADATA_DRAIN_POLICY="rpc-egress-${CONTEXT_NAME}-${METADATA_DRAIN_SERVER}"' "$RUNTIME_GATE" &&
   grep -Fq 'metadata-only scoped reconcile final-lane drain sentinel' "$RUNTIME_GATE" &&
   grep -Fq 'netpol_full_pass_count_since "$metadata_window_start"' "$RUNTIME_GATE" &&
   grep -Fq 'target_host_activity_stays_absent "$metadata_window_start" 30' "$RUNTIME_GATE" &&
   grep -Fq 'host_reconcile_witness_count_since "$metadata_window_start" "$HOST_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'metadata_context_after_generation" = "$metadata_context_before_generation' "$RUNTIME_GATE" &&
   grep -Fq 'metadata-only NetworkPolicy convergence failed and made the Host skip inconclusive' "$RUNTIME_GATE" &&
   grep -Fq 'metadata-only Context MODIFIED interrupted the real Host-to-MCP path' "$RUNTIME_GATE" &&
   grep -Fq 'metadata-only Context MODIFIED kept the real Host stable' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate proves metadata-only MODIFIED runs scoped NP without Host fan-out"
else
  fail "WRC-HCC runtime gate can miss or misattribute the metadata-only Host skip boundary"
fi

if grep -Fq 'enable_wrc_debug_logging' "$RUNTIME_GATE" &&
   grep -Fq 'kctl rollout restart deployment/"$WRC_DEPLOY"' "$RUNTIME_GATE" &&
   grep -Fq 'wait_for_wrc_context_noop_completion 120 "$wrc_noop_window_start"' "$RUNTIME_GATE" &&
   grep -Fq 'starts" = 1' "$RUNTIME_GATE" &&
   grep -Fq 'skips" = 2' "$RUNTIME_GATE" &&
   grep -Fq 'writes" = 0' "$RUNTIME_GATE" &&
   grep -Fq 'context_identity_is_original' "$RUNTIME_GATE" &&
   grep -Fq 'both WRC Context planners completed without replace or persisted Context mutation' "$RUNTIME_GATE" &&
   grep -Fq 'restore_wrc_log_level_config' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate observes both completed WRC planner skips and stable persisted Context identity"
else
  fail "WRC-HCC runtime gate can claim no-op before both planners complete or without restoring WRC logging"
fi

if grep -Fq 'CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${RESYNC_SECONDS}' "$RUNTIME_GATE" &&
   grep -Fq 'kctl delete networkpolicy "$CONTEXT_POLICY"' "$RUNTIME_GATE" &&
   grep -Fq 'probe_mcp_tcp_connectivity' "$RUNTIME_GATE" &&
   grep -Fq '[ "$connectivity_rc" = 42 ]' "$RUNTIME_GATE" &&
   grep -Fq 'probe_mcp_business_signal "$SECOND_MCP_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_runtime_still_ready' "$RUNTIME_GATE" &&
   grep -Fq 'PROBE_BASELINE_IDENTITY="$(' "$RUNTIME_GATE" &&
   grep -Fq 'selector_runtime_identity "$HOST_NS" "app=${PROBE_NAME}" "$PROBE_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'PRIMARY_MCP_BASELINE_IDENTITY="$(selector_runtime_identity' "$RUNTIME_GATE" &&
   grep -Fq 'SECOND_MCP_BASELINE_IDENTITY="$(selector_runtime_identity' "$RUNTIME_GATE" &&
   grep -Fq 'mcp_data_plane_is_policy_blocked' "$RUNTIME_GATE" &&
   grep -Fq 'timer_tick_due_epoch=' "$RUNTIME_GATE" &&
   grep -Fq 'FAULT_WINDOW_SECONDS=$((RESYNC_SECONDS / 3))' "$RUNTIME_GATE" &&
   grep -Fq 'timer_window_attempt" -le 3' "$RUNTIME_GATE" &&
   grep -Fq 'timer_tick_due_epoch - timer_now_epoch)) -ge "$FAULT_WINDOW_SECONDS"' "$RUNTIME_GATE" &&
   grep -Fq 'context_policy_recreated_from_snapshot' "$RUNTIME_GATE" &&
   grep -Fq 'hcc_netpol_certified_after "$netpol_certified_before_fault"' "$RUNTIME_GATE" &&
   grep -Fq 'netpol_desired_inventory_snapshot' "$RUNTIME_GATE" &&
   grep -Fq 'del(."clerum.io/network-ready")' "$RUNTIME_GATE" &&
   grep -Fq 'netpol_watch_recovery_count_since "$fault_window_start"' "$RUNTIME_GATE" &&
   grep -Fq 'more than one NetworkPolicy pass ran in the timer attribution window' "$RUNTIME_GATE" &&
   grep -Fq 'policy recovered before the armed periodic tick' "$RUNTIME_GATE" &&
   grep -Fq 'hcc_identity_is_stable' "$RUNTIME_GATE" &&
   grep -Fq 'restore_hcc_resync_config' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate attributes policy loss to a post-fault timer pass with stable runtimes"
else
  fail "WRC-HCC runtime gate can pass without timer attribution, stable identities, or config restoration"
fi

if grep -Fq 'name:"add",arguments:{a:19,b:23}' "$RUNTIME_GATE" &&
   grep -Fq 'content[0]?.text !== "42"' "$RUNTIME_GATE" &&
   grep -Fq 'probe_host_mcp_business_signal "$MCP_NAME"' "$RUNTIME_GATE" &&
   grep -Fq 'businessSignal:"real-host-and-probe:add(19,23)=42"' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime gate carries an exact MCP signal through the real Host and fault probe"
else
  fail "WRC-HCC runtime gate lacks an exact real-Host MCP business signal"
fi

real_change_line="$(grep -nF 'kctl patch workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_NS" --type=json' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
positive_host_line="$(grep -nF 'wait_for_positive_host_fanout 90 "$fanout_window_start" "$host_urgent_before"' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
noop_completion_line="$(grep -nF 'wait_for_wrc_context_noop_completion 120 "$wrc_noop_window_start"' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
metadata_event_line="$(grep -nF 'kctl annotate context "$CONTEXT_NAME"' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
metadata_drain_line="$(grep -nF 'metadata-only scoped reconcile final-lane drain sentinel' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
metadata_guard_line="$(grep -nF 'target_host_activity_stays_absent "$metadata_window_start" 30' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
fault_line="$(grep -nF 'kctl delete networkpolicy "$CONTEXT_POLICY"' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
blocked_line="$(grep -nF 'mcp_data_plane_is_policy_blocked ||' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
recovery_line="$(grep -nF 'context_policy_recreated_from_snapshot ||' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
certified_line="$(grep -nF 'hcc_netpol_certified_after "$netpol_certified_before_fault"' "$RUNTIME_GATE" | tail -1 | cut -d: -f1)"
if [ -n "$real_change_line" ] && [ -n "$positive_host_line" ] &&
   [ -n "$noop_completion_line" ] && [ -n "$metadata_event_line" ] &&
   [ -n "$metadata_drain_line" ] && [ -n "$metadata_guard_line" ] &&
   [ -n "$fault_line" ] && [ -n "$blocked_line" ] &&
   [ -n "$recovery_line" ] && [ -n "$certified_line" ] &&
   [ "$real_change_line" -lt "$positive_host_line" ] &&
   [ "$positive_host_line" -lt "$noop_completion_line" ] &&
   [ "$noop_completion_line" -lt "$metadata_event_line" ] &&
   [ "$metadata_event_line" -lt "$metadata_drain_line" ] &&
   [ "$metadata_drain_line" -lt "$metadata_guard_line" ] &&
   [ "$metadata_guard_line" -lt "$fault_line" ] &&
   [ "$fault_line" -lt "$blocked_line" ] &&
   [ "$blocked_line" -lt "$recovery_line" ] &&
   [ "$recovery_line" -lt "$certified_line" ]; then
  pass "WRC-HCC runtime phases are ordered from real change through negative guard and timed recovery"
else
  fail "WRC-HCC runtime assertions can execute outside their causal phase ordering"
fi

if grep -Fq -- '--ignore-not-found -o name' "$RUNTIME_GATE" &&
   grep -Fq 'resource_collection_absent replicaset "$MCP_NS" "$WORKLOAD_SELECTOR"' "$RUNTIME_GATE" &&
   grep -Fq 'resource_collection_absent replicaset "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR"' "$RUNTIME_GATE" &&
   grep -Fq 'resource_collection_absent pod "$HOST_NS" "app=${PROBE_NAME}"' "$RUNTIME_GATE" &&
   grep -Fq 'wrc_managed_resources_absent' "$RUNTIME_GATE" &&
   grep -Fq 'resource_absent networkpolicy "$METADATA_DRAIN_POLICY"' "$RUNTIME_GATE" &&
   grep -Fq 'clerum.io/recipe=${RECIPE_NAME}' "$RUNTIME_GATE" &&
   grep -Fq 'deployment,replicaset,pod,service,serviceaccount' "$RUNTIME_GATE" &&
   grep -Fq '.local-notes/infra/runs/wrc-hcc-context-noop-resync' "$RUNTIME_GATE" &&
   grep -Fq 'chmod 600 "$tmp"' "$RUNTIME_GATE"; then
  pass "WRC-HCC runtime absence and cleanup checks fail closed across dependent workloads"
else
  fail "WRC-HCC runtime cleanup can hide API errors or leave dependent Pods/ReplicaSets"
fi

if grep -Fq '.PHONY: test-e2e-wrc-hcc-context-noop-resync' "$MAKEFILE" &&
   grep -Fq 'E2E_WRC_HCC_CONTEXT_FAULT_INJECTION=1' "$MAKEFILE" &&
   grep -Fq 'MINIKUBE_PROFILE=$(E2E_KUBECONTEXT)' "$MAKEFILE"; then
  pass "Makefile exposes the WRC-HCC runtime gate only through an explicit branch-profile target"
else
  fail "Makefile does not expose the WRC-HCC runtime gate with explicit profile ownership"
fi

exit "$FAIL"
