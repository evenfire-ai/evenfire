#!/usr/bin/env bash
# Read-only validation and state-transition planner for local Evenfire Minikube.
# This is not T0, T1, or T2. T2_PLAN_MODE=false (default, make minikube-t2-preflight
# and the final T2 check) is fail-loud on full-bootstrap or a stale marker.
# T2_PLAN_MODE=true is only the orchestrator planner so full-bootstrap is reachable.
# shellcheck disable=SC2269
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/minikube/t2-common.sh
source "$SCRIPT_DIR/t2-common.sh"

T2_PLAN_MODE="$T2_PLAN_MODE"
if [ -z "$T2_PLAN_MODE" ]; then T2_PLAN_MODE=false; fi
T2_SKIP_LOCK="$T2_SKIP_LOCK"
if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
T2_PLAN_FILE="$T2_PLAN_FILE"
if [ -z "$T2_PLAN_FILE" ]; then T2_PLAN_FILE="$T2_EVIDENCE_ROOT/next-plan.json"; fi
T2_NEXT_COMMAND='re-run the canonical command with the verified profile'

main() {
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  if [ "$T2_SKIP_LOCK" != true ]; then
    t2_lock_acquire
  fi
  t2_evidence_init

  # Profile status is read before any resource check. A missing/stopped profile
  # is a plan for bootstrap, never a reason to invoke pre-gate-sync.
  t2_profile_status
  t2_marker_check
  t2_image_check
  t2_resource_checks
  t2_postgres_check
  t2_deployment_check
  t2_process_check
  t2_classify_transition
  t2_write_plan "$T2_PLAN_FILE"

  if [ "$T2_PLAN_STATE" = full-bootstrap ] && [ "$T2_PLAN_MODE" != true ]; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE IMAGE_SOURCE=local make minikube-setup"
    t2_fail BOOTSTRAP_REQUIRED "$T2_PLAN_REASON"
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
