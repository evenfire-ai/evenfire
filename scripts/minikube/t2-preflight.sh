#!/usr/bin/env bash
# Read-only validation and state-transition planner for local Evenfire Minikube.
# This is not T0, T1, or T2. T2_PLAN_MODE=false (default, make minikube-t2-preflight
# and the final T2 check) is fail-loud on full-bootstrap or a stale marker.
# T2_PLAN_MODE=true is only the orchestrator planner so full-bootstrap is reachable.
# shellcheck disable=SC2269
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
T2_EVIDENCE_KIND=planner
export T2_EVIDENCE_KIND
# shellcheck source=scripts/minikube/t2-common.sh
source "$SCRIPT_DIR/t2-common.sh"

T2_PLAN_MODE="$T2_PLAN_MODE"
if [ -z "$T2_PLAN_MODE" ]; then T2_PLAN_MODE=false; fi
T2_SKIP_LOCK="$T2_SKIP_LOCK"
if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
T2_PLAN_FILE="$T2_PLAN_FILE"
if [ -z "$T2_PLAN_FILE" ]; then T2_PLAN_FILE="$T2_EVIDENCE_ROOT/next-plan.json"; fi
T2_NEXT_COMMAND='re-run the canonical command with the verified profile'

cleanup_preflight() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  if ! t2_lock_release "$status"; then
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap cleanup_preflight EXIT

main() {
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_profile_status
  if [ "$T2_BOOTSTRAP_REQUIRED" != true ]; then
    t2_context_check
  else
    t2_missing_profile_context_check
  fi
  t2_mutation_lock
  t2_evidence_init

  # Profile status is read before any cluster check. A missing/stopped profile
  # is a complete bootstrap plan; only healthy profiles have a context whose
  # identity, marker, resources, PostgreSQL, and deployments can be inspected.
  t2_cluster_state_checks
  t2_process_check
  t2_classify_transition
  t2_write_plan "$T2_PLAN_FILE"

  if [ "$T2_PLAN_STATE" = full-bootstrap ] && [ "$T2_PLAN_MODE" != true ]; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE CONTROL_API_REAL_PG_CONTEXT=$T2_CONTEXT make minikube-t2"
    t2_fail BOOTSTRAP_REQUIRED "$T2_PLAN_REASON"
    return 1
  fi

  t2_evidence_write preflight PASS "$T2_PLAN_STATE: $T2_PLAN_REASON"
  printf 'T2_PREFLIGHT_PASS\n'
  printf 'transition=%s\n' "$T2_PLAN_STATE"
  printf 'reason=%s\n' "$T2_PLAN_REASON"
  printf 'profile=%s\n' "$T2_PROFILE"
  printf 'context=%s\n' "$T2_CONTEXT"
  printf 'head=%s\n' "$T2_HEAD"
  printf 'origin_dev=%s\n' "$T2_ORIGIN_DEV"
  printf 'merge_base=%s\n' "$T2_MERGE_BASE"
  printf 'evidence=%s\n' "$T2_EVIDENCE_FILE"
}

main "$@"
