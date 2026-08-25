#!/usr/bin/env bash
# Canonical local development T0/T1/T2 orchestrator.
# shellcheck disable=SC1091,SC2034,SC2269
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/t2-common.sh"
# shellcheck source=scripts/e2e/real-postgres-local-preflight.sh
source "$T2_PROJECT_DIR/scripts/e2e/real-postgres-local-preflight.sh"
T2_RUN_ID="${T2_RUN_ID:-}"

T2_SKIP_LOCK="$T2_SKIP_LOCK"
if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
T2_RUN_T0="$T2_RUN_T0"
if [ -z "$T2_RUN_T0" ]; then T2_RUN_T0=true; fi
T2_RUN_T1="$T2_RUN_T1"
if [ -z "$T2_RUN_T1" ]; then T2_RUN_T1=true; fi
T2_REQUIRE_PLAYWRIGHT="$T2_REQUIRE_PLAYWRIGHT"
if [ -z "$T2_REQUIRE_PLAYWRIGHT" ]; then T2_REQUIRE_PLAYWRIGHT=false; fi
T2_T0_COMMAND="$T2_T0_COMMAND"
T2_PLAYWRIGHT_COMMAND="$T2_PLAYWRIGHT_COMMAND"
T2_HEALTHCHECK_COMMAND="$T2_HEALTHCHECK_COMMAND"
T2_HEALTHCHECK_TIMEOUT_SECONDS="${T2_HEALTHCHECK_TIMEOUT_SECONDS:-120}"
T2_DEADLINE_RUNNER="${T2_DEADLINE_RUNNER:-$SCRIPT_DIR/run-with-deadline.mjs}"
T2_PLAN_TMP=""
T2_T0_STATUS=NOT_RUN
T2_T1_STATUS=NOT_RUN
T2_T2_STATUS=NOT_RUN
T2_NP08_HCC_AUTHORIZATION_STATUS=NOT_RUN
T2_HEALTH_STATUS=NOT_RUN
T2_PLAYWRIGHT_STATUS=NOT_RUN
T2_HEALTHCHECK_REQUIRED=false
# A bootstrap or full reconcile must build the current worktree. Reusing a
# marker's ghcr coordinate would validate a release image rather than HEAD.
T2_BOOTSTRAP_IMAGE_SOURCE=local
T2_TMP_ROOT="$T2_TMP_ROOT"
if [ -z "$T2_TMP_ROOT" ]; then T2_TMP_ROOT=/tmp; fi
T2_SETUP_HANDOFF_ROOT="${T2_SETUP_HANDOFF_ROOT:-$T2_PROJECT_DIR/.local-notes/infra/t2-setup-handoffs}"
T2_SETUP_HANDOFF_TTL_SECONDS="${T2_SETUP_HANDOFF_TTL_SECONDS:-300}"
T2_T1_OUTPUT="$T2_TMP_ROOT/evenfire-t1.$$.out"
T2_FINAL_PREFLIGHT_OUTPUT="$T2_TMP_ROOT/evenfire-t2-final-preflight.$$.out"
export T2_PROJECT_DIR T2_PROFILE_ROOT T2_PROFILE_ENV T2_PORTS_ENV T2_CONTEXT T2_LOCK_TOKEN

cleanup_plan() {
  local status=$? cleanup_status=0
  trap - EXIT
  if [ -n "$T2_PLAN_TMP" ] && [ -f "$T2_PLAN_TMP" ]; then
    rm -f "$T2_PLAN_TMP" || cleanup_status=1
  fi
  if [ -f "$T2_FINAL_PREFLIGHT_OUTPUT" ]; then
    rm -f "$T2_FINAL_PREFLIGHT_OUTPUT" || cleanup_status=1
  fi
  if [ -f "$T2_T1_OUTPUT" ]; then
    rm -f "$T2_T1_OUTPUT" || cleanup_status=1
  fi
  t2_lock_release "$status" || cleanup_status=1
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    status=1
  fi
  exit "$status"
}
t2_lane_completed() {
  local status="$1"
  [ "$status" = PASS ]
}

run_t1_local_preflight() {
  [ "$T2_RUN_T1" = true ] || return 0
  if ! real_pg_local_preflight "$T2_PROJECT_DIR" true; then
    T2_NEXT_COMMAND='repair the reported local prerequisite before retrying T0/T1/T2'
    t2_evidence_write local-preflight FAIL "$REAL_PG_PREFLIGHT_ERROR_CODE"
    t2_fail "$REAL_PG_PREFLIGHT_ERROR_CODE" "$REAL_PG_PREFLIGHT_ERROR_MESSAGE"
    return 1
  fi
  t2_evidence_write local-preflight PASS \
    "Node/package/Docker prerequisites passed in ${REAL_PG_PREFLIGHT_DURATION_SECONDS}s; T1 workers=1"
}

run_t0() {
  local phase_started_seconds="$SECONDS"
  if [ "$T2_RUN_T0" != true ]; then
    T2_T0_STATUS=SKIPPED
    t2_evidence_write T0 SKIPPED 'T2_RUN_T0=false; an exact-head T0 attestation is required before runtime-only certification'
    return 0
  fi
  printf '[minikube-t2] T0: shell syntax and contract checks\n'
  git -C "$T2_PROJECT_DIR" diff --check "$T2_ORIGIN_DEV...$T2_HEAD"
  bash -n "$SCRIPT_DIR/t2-common.sh" "$SCRIPT_DIR/t2-preflight.sh" "$SCRIPT_DIR/t2.sh" \
    "$SCRIPT_DIR/t2-setup-handoff.sh" \
    "$T2_PROJECT_DIR/scripts/tests/test-minikube-t2-setup-handoff.sh"
  T0_PROJECT_DIR="$T2_PROJECT_DIR" T0_ORIGIN_DEV="$T2_ORIGIN_DEV" T0_HEAD="$T2_HEAD" \
    bash "$T2_PROJECT_DIR/scripts/minikube/t0.sh"
  if [ -n "$T2_T0_COMMAND" ]; then
    bash -c "$T2_T0_COMMAND"
  fi
  bash "$T2_PROJECT_DIR/scripts/tests/test-minikube-t2-contract.sh"
  bash "$T2_PROJECT_DIR/scripts/tests/test-minikube-t2-setup-handoff.sh"
  T2_T0_STATUS=PASS
  t2_evidence_write T0 PASS "syntax, ShellCheck when available, affected package test/build/typecheck, contract, and diff checks passed; duration=$((SECONDS - phase_started_seconds))s"
}

run_preflight_plan() {
  local phase_started_seconds="$SECONDS"
  T2_PLAN_TMP="$(mktemp "$T2_TMP_ROOT/evenfire-t2-plan.XXXXXX")"
  if ! T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" T2_PLAN_MODE=true T2_PLAN_FILE="$T2_PLAN_TMP" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    T2_EVIDENCE_ROOT="$T2_EVIDENCE_ROOT" \
    bash "$SCRIPT_DIR/t2-preflight.sh"; then
    T2_NEXT_COMMAND='re-run make minikube-t2-preflight and repair its first reported precondition'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'preflight failed before a state transition was selected'
    return 1
  fi
  T2_PLAN_STATE="$(python3 - "$T2_PLAN_TMP" <<'PY'
import json
import sys
print(json.loads(open(sys.argv[1]).read()).get("state", ""))
PY
  )"
  T2_PLAN_REASON="$(python3 - "$T2_PLAN_TMP" <<'PY'
import json
import sys
print(json.loads(open(sys.argv[1]).read()).get("reason", ""))
PY
  )"
  if [ -z "$T2_PLAN_STATE" ]; then
    T2_NEXT_COMMAND='re-run make minikube-t2-preflight and inspect its evidence'
    t2_fail BOOTSTRAP_REQUIRED 'preflight did not produce a state transition'
    return 1
  fi
  printf '[minikube-t2] transition=%s reason=%s\n' "$T2_PLAN_STATE" "$T2_PLAN_REASON"
  t2_evidence_write planner PASS \
    "state=$T2_PLAN_STATE duration=$((SECONDS - phase_started_seconds))s"
}

run_pvc_reset_if_authorized() {
  T2_RESET_PVC="$T2_RESET_PVC"
  if [ -z "$T2_RESET_PVC" ]; then T2_RESET_PVC=false; fi
  [ "$T2_RESET_PVC" = true ] || return 0
  T2_EXPECTED_PVC_UID="$T2_EXPECTED_PVC_UID"
  if [ -z "$T2_EXPECTED_PVC_UID" ]; then
    T2_NEXT_COMMAND='set T2_EXPECTED_PVC_UID to the exact recorded UID and keep T2_RESET_PVC=true only for local development'
    t2_fail POSTGRES_NOT_READY 'destructive PVC reset requires an exact expected UID'
    return 1
  fi
  local actual_uid
  actual_uid="$(t2_kc -n "$T2_CONTROL_NAMESPACE" get pvc control-postgres-data -o 'jsonpath={.metadata.uid}' 2>/dev/null || true)"
  if [ "$actual_uid" != "$T2_EXPECTED_PVC_UID" ]; then
    T2_NEXT_COMMAND='do not reset this PVC; re-check the profile and recorded UID'
    t2_fail POSTGRES_NOT_READY 'PVC UID does not match the explicit reset expectation'
    return 1
  fi
  printf '[minikube-t2] authorized development-only PVC reset for the exact expected UID\n'
}

run_bootstrap_or_reconcile() {
  local phase_started_seconds="$SECONDS"
  run_pvc_reset_if_authorized
  case "$T2_PLAN_STATE" in
    full-bootstrap)
      printf '[minikube-t2] bootstrap: full setup, then PostgreSQL/migrations/roles checks\n'
      if [ "$T2_RESET_PVC" = true ]; then
          T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
          T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_REQUIRED=true \
          T2_SETUP_HANDOFF_TRANSITION="$T2_PLAN_STATE" \
          T2_SETUP_HANDOFF_ROOT="$T2_SETUP_HANDOFF_ROOT" \
          T2_SETUP_HANDOFF_TTL_SECONDS="$T2_SETUP_HANDOFF_TTL_SECONDS" \
          MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
            REUSE_DB=false CONTROL_DB_RESET_PVC_UID="$T2_EXPECTED_PVC_UID" ARGS= make minikube-setup
      else
        T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
          T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_REQUIRED=true \
          T2_SETUP_HANDOFF_TRANSITION="$T2_PLAN_STATE" \
          T2_SETUP_HANDOFF_ROOT="$T2_SETUP_HANDOFF_ROOT" \
          T2_SETUP_HANDOFF_TTL_SECONDS="$T2_SETUP_HANDOFF_TTL_SECONDS" \
          MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=true ARGS= make minikube-setup
      fi
      ;;
    full-reconcile)
      printf '[minikube-t2] full reconcile: infrastructure input changed\n'
      if [ "$T2_RESET_PVC" = true ]; then
        T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
          T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_REQUIRED=true \
          T2_SETUP_HANDOFF_TRANSITION="$T2_PLAN_STATE" \
          T2_SETUP_HANDOFF_ROOT="$T2_SETUP_HANDOFF_ROOT" \
          T2_SETUP_HANDOFF_TTL_SECONDS="$T2_SETUP_HANDOFF_TTL_SECONDS" \
          MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=false CONTROL_DB_RESET_PVC_UID="$T2_EXPECTED_PVC_UID" ARGS= make minikube-setup
      else
        T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
          T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_REQUIRED=true \
          T2_SETUP_HANDOFF_TRANSITION="$T2_PLAN_STATE" \
          T2_SETUP_HANDOFF_ROOT="$T2_SETUP_HANDOFF_ROOT" \
          T2_SETUP_HANDOFF_TTL_SECONDS="$T2_SETUP_HANDOFF_TTL_SECONDS" \
          MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=true ARGS= make minikube-setup
      fi
      ;;
    targeted-sync)
      printf '[minikube-t2] targeted sync: service-only source input changed\n'
      run_targeted_sync
      ;;
    already-synced)
      printf '[minikube-t2] already synced: marker matches HEAD; skipping setup\n'
      ;;
    *)
      T2_NEXT_COMMAND='re-run make minikube-t2-preflight to select bootstrap, targeted sync, full reconcile, or already-synced'
      t2_fail BOOTSTRAP_REQUIRED "unknown transition: $T2_PLAN_STATE"
      return 1
      ;;
  esac
  if [ "$T2_PLAN_STATE" = targeted-sync ]; then
    # The transition is now complete; a user-facing health journey is an
    # outstanding obligation until it passes on a later evidence write.
    T2_HEALTHCHECK_PENDING=true
  fi
  t2_evidence_write transition PASS \
    "$T2_PLAN_STATE duration=$((SECONDS - phase_started_seconds))s"
}

run_targeted_sync() {
  # pre-gate-sync owns the targeted plan and mutation. Keeping a second mapping
  # here caused the T2 transition to deploy twice and, for GFS, referenced a
  # deployment that does not exist. The canonical path below classifies the
  # exact diff, builds each image selector once, and restarts its real consumer
  # deployment(s) before publishing the exact-head marker.
  printf '[minikube-t2] targeted mutation delegated to canonical pre-gate-sync\n'
}

run_pre_gate() {
  local phase_started_seconds="$SECONDS"
  if [ "$T2_PLAN_STATE" = already-synced ]; then
    printf '[minikube-t2] skipping pre-gate-sync; marker already matches HEAD\n'
    t2_evidence_write pre-gate-sync SKIPPED 'marker already matches HEAD; duration=0s'
    return 0
  fi
  printf '[minikube-t2] pre-gate-sync after bootstrap/reconcile\n'
  local setup_handoff_expected=false
  case "$T2_PLAN_STATE" in
    full-bootstrap|full-reconcile) setup_handoff_expected=true ;;
  esac
  T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
    T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_EXPECTED="$setup_handoff_expected" \
    T2_SETUP_HANDOFF_TRANSITION="$T2_PLAN_STATE" \
    T2_SETUP_HANDOFF_ROOT="$T2_SETUP_HANDOFF_ROOT" \
    T2_SETUP_HANDOFF_TTL_SECONDS="$T2_SETUP_HANDOFF_TTL_SECONDS" \
    MINIKUBE_PROFILE="$T2_PROFILE" CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" \
    make minikube-pre-gate-sync GATE=minikube-t2 ARGS='--skip-port-forwards'
  t2_evidence_write pre-gate-sync PASS \
    "duration=$((SECONDS - phase_started_seconds))s setupHandoffExpected=$setup_handoff_expected"
}

run_t1() {
  local phase_started_seconds="$SECONDS"
  if [ "$T2_RUN_T1" != true ]; then
    T2_T1_STATUS=SKIPPED
    t2_evidence_write T1 SKIPPED 'T2_RUN_T1=false; an exact-head T1 attestation is required before runtime-only certification'
    return 0
  fi
  printf '[minikube-t2] T1: Real PostgreSQL suites\n'
  if T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" MINIKUBE_PROFILE="$T2_PROFILE" \
    bash "$T2_PROJECT_DIR/scripts/e2e/minikube-real-postgres.sh" >"$T2_T1_OUTPUT" 2>&1; then
    cat "$T2_T1_OUTPUT"
    local t1_status t1_tests t1_passed t1_pending t1_expected_files t1_reported_files t1_duration t1_evidence
    t1_status="$(awk -F= '$1 == "T1_STATUS" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_tests="$(awk -F= '$1 == "T1_TESTS" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_passed="$(awk -F= '$1 == "T1_PASSED_TESTS" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_pending="$(awk -F= '$1 == "T1_PENDING_TESTS" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_expected_files="$(awk -F= '$1 == "T1_EXPECTED_FILES" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_reported_files="$(awk -F= '$1 == "T1_REPORTED_FILES" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_duration="$(awk -F= '$1 == "T1_DURATION_SECONDS" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    t1_evidence="$(awk -F= '$1 == "T1_EVIDENCE" { value=$2 } END { print value }' "$T2_T1_OUTPUT")"
    if [ "$t1_status" != PASS ] || ! [[ "$t1_tests" =~ ^[1-9][0-9]*$ ]] || \
       ! [[ "$t1_passed" =~ ^[1-9][0-9]*$ ]] || [ "$t1_passed" -ne "$t1_tests" ] || \
       [ "$t1_pending" != 0 ] || ! [[ "$t1_expected_files" =~ ^[1-9][0-9]*$ ]] || \
       ! [[ "$t1_reported_files" =~ ^[1-9][0-9]*$ ]] || \
       [ "$t1_reported_files" -ne "$t1_expected_files" ] || \
       ! [[ "$t1_duration" =~ ^[0-9]+$ ]] || [ -z "$t1_evidence" ]; then
      T2_T1_STATUS=FAIL
      t2_evidence_write T1 FAIL 'Real PostgreSQL lane exited zero but did not emit a complete green T1 result'
      T2_NEXT_COMMAND='repair the T1 result contract; it must prove the exact file set, positive test counts, zero pending tests, duration, and an evidence path'
      t2_fail REAL_PG_SUITE_FAILED 'T1 result was incomplete despite a zero process exit'
      return 1
    fi
    T2_T1_STATUS=PASS
    T2_T1_COUNTS="$(awk -F= '/^T1_TESTS=|^T1_PASSED_TESTS=|^T1_PENDING_TESTS=|^T1_EXPECTED_FILES=|^T1_REPORTED_FILES=/{printf "%s%s", (n++ ? "," : ""), $0}' "$T2_T1_OUTPUT")"
    t2_evidence_write T1 PASS "Real PostgreSQL suites executed with exact file identity and no skips; $T2_T1_COUNTS; duration=${t1_duration}s; orchestratorDuration=$((SECONDS - phase_started_seconds))s"
  else
    cat "$T2_T1_OUTPUT" >&2 || true
    T2_T1_STATUS=FAIL
    t2_evidence_write T1 FAIL "Real PostgreSQL lane failed after $((SECONDS - phase_started_seconds))s"
    return 1
  fi
}

run_final_preflight() {
  local phase_started_seconds="$SECONDS"
  printf '[minikube-t2] final exact-head readiness preflight\n'
  # Fail-loud: a stale marker or missing bootstrap must not count as T2.
  if ! T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" T2_PLAN_MODE=false T2_PLAN_FILE="$T2_PLAN_TMP" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    T2_EVIDENCE_ROOT="$T2_EVIDENCE_ROOT" \
    bash "$SCRIPT_DIR/t2-preflight.sh" >"$T2_FINAL_PREFLIGHT_OUTPUT" 2>&1; then
    cat "$T2_FINAL_PREFLIGHT_OUTPUT" >&2 || true
    T2_NEXT_COMMAND='repair the first reported final preflight condition, then re-run T2 on the same HEAD'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'final exact-head readiness preflight failed'
    return 1
  fi
  T2_PLAN_STATE="$(python3 - "$T2_PLAN_TMP" <<'PY'
import json
import sys
print(json.loads(open(sys.argv[1]).read()).get("state", ""))
PY
  )"
  if [ "$T2_PLAN_STATE" != already-synced ]; then
    T2_NEXT_COMMAND='re-run make minikube-t2 so pre-gate-sync updates the marker to this HEAD'
    t2_fail HEAD_MARKER_MISMATCH "final T2 preflight selected $T2_PLAN_STATE instead of already-synced"
    return 1
  fi
  t2_marker_check
  T2_T2_STATUS=PASS
  t2_evidence_write T2 PASS \
    "exact marker, image, PostgreSQL, namespace, Service, and deployment readiness passed; duration=$((SECONDS - phase_started_seconds))s"
}

run_np08_hcc_authorization() {
  local log_file phase_started_seconds="$SECONDS"
  log_file="$T2_EVIDENCE_DIR/logs/np08-hcc-authorization.log"
  printf '[minikube-t2] NP-08: deployed Host-to-HCC authorization journey\n'
  if MINIKUBE_PROFILE="$T2_PROFILE" CLERUM_PROFILE_PORTS_ENV="$T2_PORTS_ENV" \
    bash "$T2_PROJECT_DIR/scripts/e2e/e2e-np08-hcc-authorization.sh" \
      --context "$T2_CONTEXT" >"$log_file" 2>&1; then
    cat "$log_file"
    T2_NP08_HCC_AUTHORIZATION_STATUS=PASS
    t2_evidence_write NP08_HCC_AUTHORIZATION PASS \
      "deployed same-Context, cross-Context, caller-token, and credential-disclosure checks passed; duration=$((SECONDS - phase_started_seconds))s"
    return 0
  fi

  cat "$log_file" >&2 || true
  T2_NP08_HCC_AUTHORIZATION_STATUS=FAIL
  t2_evidence_write NP08_HCC_AUTHORIZATION FAIL \
    "deployed Host-to-HCC authorization journey failed after $((SECONDS - phase_started_seconds))s; see the secret-safe local log"
  T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE CONTROL_API_REAL_PG_CONTEXT=$T2_CONTEXT make minikube-t2-runtime"
  t2_fail NP08_HCC_AUTHORIZATION_FAILED 'deployed Host-to-HCC authorization journey failed'
}

validate_healthcheck_contract() {
  T2_HEALTHCHECK_REQUIRED=false
  if ! [[ "$T2_HEALTHCHECK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || \
    [ "$T2_HEALTHCHECK_TIMEOUT_SECONDS" -gt 900 ]; then
    T2_NEXT_COMMAND='set T2_HEALTHCHECK_TIMEOUT_SECONDS to an integer from 1 to 900, then re-run T2'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED \
      'T2_HEALTHCHECK_TIMEOUT_SECONDS must be an integer from 1 to 900'
    return 1
  fi

  if [ "$T2_PLAN_STATE" = targeted-sync ] || [ "$T2_HEALTHCHECK_PENDING" = true ]; then
    T2_HEALTHCHECK_REQUIRED=true
    if [ -z "$T2_HEALTHCHECK_COMMAND" ]; then
      T2_NEXT_COMMAND='set T2_HEALTHCHECK_COMMAND to the affected service user-facing health journey, then re-run T2'
      t2_fail PROFILE_UNHEALTHY \
        'targeted sync requires a profile-owned user-facing health command before certification'
      return 1
    fi
  fi

  [ -n "$T2_HEALTHCHECK_COMMAND" ] || return 0
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$T2_DEADLINE_RUNNER" ]; then
    T2_NEXT_COMMAND='restore Node.js and scripts/minikube/run-with-deadline.mjs, then re-run T2'
    t2_fail LOCAL_DEPENDENCY_MISSING \
      'a bounded user-facing health command requires the repository deadline runner'
    return 1
  fi
}

run_healthcheck_if_requested() {
  local phase_started_seconds="$SECONDS" health_status=0
  if [ -z "$T2_HEALTHCHECK_COMMAND" ]; then
    T2_HEALTH_STATUS=NOT_RUN
    t2_evidence_write Health NOT_RUN 'no profile-owned user-facing health command was supplied'
    return 0
  fi
  node "$T2_DEADLINE_RUNNER" \
    --timeout-seconds "$T2_HEALTHCHECK_TIMEOUT_SECONDS" \
    --heartbeat-seconds 20 --kill-grace-seconds 5 \
    --label t2-user-facing-health -- \
    bash -c "$T2_HEALTHCHECK_COMMAND" || health_status=$?
  if [ "$health_status" -eq 0 ]; then
    T2_HEALTH_STATUS=PASS
    T2_HEALTHCHECK_PENDING=false
    t2_evidence_write Health PASS \
      "profile-owned user-facing health command passed; required=$T2_HEALTHCHECK_REQUIRED duration=$((SECONDS - phase_started_seconds))s"
  else
    T2_HEALTH_STATUS=FAIL
    t2_evidence_write Health FAIL \
      "profile-owned user-facing health command failed; exit=$health_status duration=$((SECONDS - phase_started_seconds))s"
    T2_NEXT_COMMAND="repair the health failure, then run MINIKUBE_PROFILE=$T2_PROFILE CONTROL_API_REAL_PG_CONTEXT=$T2_CONTEXT make minikube-t2-runtime"
    if [ "$health_status" -eq 124 ]; then
      t2_fail PROFILE_UNHEALTHY \
        "user-facing health check exceeded ${T2_HEALTHCHECK_TIMEOUT_SECONDS}s"
    else
      t2_fail PROFILE_UNHEALTHY \
        "user-facing health check failed with exit $health_status"
    fi
    return 1
  fi
}

run_playwright_if_requested() {
  local phase_started_seconds="$SECONDS"
  if [ -z "$T2_PLAYWRIGHT_COMMAND" ]; then
    T2_PLAYWRIGHT_STATUS=NOT_RUN
    t2_evidence_write Playwright NOT_RUN 'no applicable Control UI/Desktop command was supplied'
    if [ "$T2_REQUIRE_PLAYWRIGHT" = true ]; then
      T2_NEXT_COMMAND='set T2_PLAYWRIGHT_COMMAND to the applicable profile-owned Playwright journey and re-run'
      t2_fail ZERO_TESTS_EXECUTED 'Playwright was required but no journey command was supplied'
      return 1
    fi
    return 0
  fi
  if bash -c "$T2_PLAYWRIGHT_COMMAND"; then
    T2_PLAYWRIGHT_STATUS=PASS
    t2_evidence_write Playwright PASS \
      "user-visible journey command passed; duration=$((SECONDS - phase_started_seconds))s"
  else
    T2_PLAYWRIGHT_STATUS=FAIL
    t2_evidence_write Playwright FAIL 'user-visible journey command failed'
    T2_NEXT_COMMAND="repair the Playwright journey, then run MINIKUBE_PROFILE=$T2_PROFILE CONTROL_API_REAL_PG_CONTEXT=$T2_CONTEXT make minikube-t2-runtime"
    t2_fail PLAYWRIGHT_FAILED 'user-visible journey command failed'
    return 1
  fi
}

main() {
  trap cleanup_plan EXIT
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_profile_status
  if [ "$T2_BOOTSTRAP_REQUIRED" != true ]; then
    t2_context_check
  fi
  t2_mutation_lock
  local prior_health_pending
  prior_health_pending="$(t2_prior_targeted_health_pending)" || {
    T2_NEXT_COMMAND='repair or restore the local exact-head T2 evidence directory, then re-run T2'
    t2_fail CERTIFICATION_REQUIRED 'could not determine whether a targeted-sync health obligation is pending'
    return 1
  }
  if [ "$prior_health_pending" = true ]; then
    T2_HEALTHCHECK_PENDING=true
  fi
  t2_evidence_init

  run_t1_local_preflight
  run_t0
  if [ "$T2_RUN_T0" = true ] && ! t2_lane_completed "$T2_T0_STATUS"; then
    T2_NEXT_COMMAND='re-run make minikube-t2 with T2_RUN_T0=true so the static lane is executed'
    t2_fail ZERO_TESTS_EXECUTED 'T0 was not executed'
    return 1
  fi
  run_preflight_plan
  validate_healthcheck_contract
  if { [ "$T2_RUN_T0" != true ] || [ "$T2_RUN_T1" != true ]; } && [ "$T2_PLAN_STATE" != already-synced ]; then
    T2_NEXT_COMMAND='run make minikube-t2 so bootstrap/reconcile and T0/T1 execute on this HEAD'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'T2-only mode requires an already-synced exact-head profile'
    return 1
  fi
  if [ "$T2_RUN_T0" != true ] || [ "$T2_RUN_T1" != true ]; then
    t2_marker_check
    t2_certification_validate_prior_lanes
  fi
  run_bootstrap_or_reconcile
  run_pre_gate
  run_t1
  if [ "$T2_RUN_T1" = true ] && ! t2_lane_completed "$T2_T1_STATUS"; then
    T2_NEXT_COMMAND='re-run make minikube-t2 with T2_RUN_T1=true so the Real PostgreSQL lane is executed'
    t2_fail ZERO_TESTS_EXECUTED 'T1 was not executed'
    return 1
  fi
  if [ "$T2_RUN_T1" != true ] && [ "$T2_T1_CERTIFIED" != true ]; then
    T2_NEXT_COMMAND='run make minikube-t2 with T2_RUN_T1=true to create an exact-head T1 attestation'
    t2_fail CERTIFICATION_REQUIRED 'T1 was skipped without a validated exact-head attestation'
    return 1
  fi
  if [ "$T2_T0_STATUS" = PASS ] && [ "$T2_T1_STATUS" = PASS ]; then
    # Publish the reusable static/database lane attestation before runtime T2.
    # If the later runtime lane fails, a subsequent runtime-only invocation may
    # reuse these exact-head lanes without pretending that T2 already passed.
    t2_evidence_write lanes PASS 'T0 and T1 completed before runtime T2'
  fi
  if [ "$T2_RUN_T1" != true ] && [ "$T2_T1_CERTIFIED" != true ]; then
    T2_NEXT_COMMAND='run make minikube-t2 with T2_RUN_T1=true to create an exact-head T1 attestation'
    t2_fail CERTIFICATION_REQUIRED 'T1 was skipped without a validated exact-head attestation'
  fi
  run_final_preflight
  run_np08_hcc_authorization
  run_healthcheck_if_requested
  run_playwright_if_requested
  # Health and Playwright run after the planner's initial ownership scan. A
  # forward can disappear, be replaced, or lose its binding during either
  # journey, so the exact PID/start-time/argv record must be revalidated before
  # publishing the final certification.
  if ! t2_process_check; then
    return 1
  fi

  t2_evidence_write complete PASS "T0=$T2_T0_STATUS T1=$T2_T1_STATUS T2=$T2_T2_STATUS NP08_HCC_AUTHORIZATION=$T2_NP08_HCC_AUTHORIZATION_STATUS Health=$T2_HEALTH_STATUS Playwright=$T2_PLAYWRIGHT_STATUS"
  printf 'MINIKUBE_T2_PASS\n'
  printf 'T0=%s\n' "$T2_T0_STATUS"
  printf 'T1=%s\n' "$T2_T1_STATUS"
  printf 'T2=%s\n' "$T2_T2_STATUS"
  printf 'NP08_HCC_AUTHORIZATION=%s\n' "$T2_NP08_HCC_AUTHORIZATION_STATUS"
  printf 'Health=%s\n' "$T2_HEALTH_STATUS"
  printf 'Playwright=%s\n' "$T2_PLAYWRIGHT_STATUS"
  printf 'evidence=%s\n' "$T2_EVIDENCE_FILE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
