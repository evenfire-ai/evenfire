#!/usr/bin/env bash
# Canonical local development T0/T1/T2 orchestrator.
# shellcheck disable=SC1091,SC2034,SC2269
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/t2-common.sh"

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
T2_PLAN_TMP=""
T2_T0_STATUS=NOT_RUN
T2_T1_STATUS=NOT_RUN
T2_T2_STATUS=NOT_RUN
T2_PLAYWRIGHT_STATUS=NOT_RUN
# A bootstrap or full reconcile must build the current worktree. Reusing a
# marker's ghcr coordinate would validate a release image rather than HEAD.
T2_BOOTSTRAP_IMAGE_SOURCE=local
T2_TMP_ROOT="$T2_TMP_ROOT"
if [ -z "$T2_TMP_ROOT" ]; then T2_TMP_ROOT=/tmp; fi
T2_T1_OUTPUT="$T2_TMP_ROOT/evenfire-t1.$$.out"
T2_FINAL_PREFLIGHT_OUTPUT="$T2_TMP_ROOT/evenfire-t2-final-preflight.$$.out"

cleanup_plan() {
  if [ -n "$T2_PLAN_TMP" ] && [ -f "$T2_PLAN_TMP" ]; then rm -f "$T2_PLAN_TMP"; fi
  if [ -f "$T2_FINAL_PREFLIGHT_OUTPUT" ]; then rm -f "$T2_FINAL_PREFLIGHT_OUTPUT"; fi
  if [ -f "$T2_T1_OUTPUT" ]; then rm -f "$T2_T1_OUTPUT"; fi
}
trap cleanup_plan EXIT

run_t0() {
  [ "$T2_RUN_T0" = true ] || return 0
  printf '[minikube-t2] T0: shell syntax and contract checks\n'
  git -C "$T2_PROJECT_DIR" diff --check "$T2_ORIGIN_DEV...$T2_HEAD"
  bash -n "$SCRIPT_DIR/t2-common.sh" "$SCRIPT_DIR/t2-preflight.sh" "$SCRIPT_DIR/t2.sh"
  if [ -n "$T2_T0_COMMAND" ]; then
    bash -c "$T2_T0_COMMAND"
  else
    bash "$T2_PROJECT_DIR/scripts/tests/test-minikube-t2-contract.sh"
  fi
  T2_T0_STATUS=PASS
  t2_evidence_write T0 PASS 'syntax, contract, and diff checks passed'
}

run_preflight_plan() {
  T2_PLAN_TMP="$(mktemp "$T2_TMP_ROOT/evenfire-t2-plan.XXXXXX")"
  if ! T2_SKIP_LOCK=true T2_PLAN_MODE=false T2_PLAN_FILE="$T2_PLAN_TMP" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    T2_EVIDENCE_ROOT="$T2_EVIDENCE_ROOT" \
    bash "$SCRIPT_DIR/t2-preflight.sh"; then
    T2_NEXT_COMMAND='re-run make minikube-t2-preflight and repair its first reported precondition'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'preflight failed before a state transition was selected'
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
  fi
  printf '[minikube-t2] transition=%s reason=%s\n' "$T2_PLAN_STATE" "$T2_PLAN_REASON"
}

run_pvc_reset_if_authorized() {
  T2_RESET_PVC="$T2_RESET_PVC"
  if [ -z "$T2_RESET_PVC" ]; then T2_RESET_PVC=false; fi
  [ "$T2_RESET_PVC" = true ] || return 0
  T2_EXPECTED_PVC_UID="$T2_EXPECTED_PVC_UID"
  if [ -z "$T2_EXPECTED_PVC_UID" ]; then
    T2_NEXT_COMMAND='set T2_EXPECTED_PVC_UID to the exact recorded UID and keep T2_RESET_PVC=true only for local development'
    t2_fail POSTGRES_NOT_READY 'destructive PVC reset requires an exact expected UID'
  fi
  local actual_uid
  actual_uid="$(t2_kc -n "$T2_CONTROL_NAMESPACE" get pvc control-postgres-data -o 'jsonpath={.metadata.uid}' 2>/dev/null || true)"
  if [ "$actual_uid" != "$T2_EXPECTED_PVC_UID" ]; then
    T2_NEXT_COMMAND='do not reset this PVC; re-check the profile and recorded UID'
    t2_fail POSTGRES_NOT_READY 'PVC UID does not match the explicit reset expectation'
  fi
  printf '[minikube-t2] authorized development-only PVC reset for the exact expected UID\n'
}

run_bootstrap_or_reconcile() {
  run_pvc_reset_if_authorized
  case "$T2_PLAN_STATE" in
    full-bootstrap)
      printf '[minikube-t2] bootstrap: full setup, then PostgreSQL/migrations/roles checks\n'
      if [ "$T2_RESET_PVC" = true ]; then
        MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=false CONTROL_DB_RESET_PVC_UID="$T2_EXPECTED_PVC_UID" make minikube-setup
      else
        MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=true make minikube-setup
      fi
      ;;
    full-reconcile)
      printf '[minikube-t2] full reconcile: infrastructure input changed\n'
      if [ "$T2_RESET_PVC" = true ]; then
        MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=false CONTROL_DB_RESET_PVC_UID="$T2_EXPECTED_PVC_UID" make minikube-setup
      else
        MINIKUBE_PROFILE="$T2_PROFILE" IMAGE_SOURCE="$T2_BOOTSTRAP_IMAGE_SOURCE" \
          REUSE_DB=true make minikube-setup
      fi
      ;;
    targeted-sync)
      printf '[minikube-t2] targeted sync: service-only source input changed\n'
      run_targeted_sync
      ;;
    *)
      T2_NEXT_COMMAND='re-run make minikube-t2-preflight to select bootstrap, targeted sync, or full reconcile'
      t2_fail BOOTSTRAP_REQUIRED "unknown transition: $T2_PLAN_STATE"
      ;;
  esac
  t2_evidence_write transition PASS "$T2_PLAN_STATE"
}

run_targeted_sync() {
  local changed path selected=false
  changed="$(git -C "$T2_PROJECT_DIR" diff --name-only "$T2_ORIGIN_DEV...$T2_HEAD")"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      control-api/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=control-api NS=control-plane MINIKUBE_DEPLOYMENT=control-api
        selected=true ;;
      gfs-controller/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=gfs-controller NS=gfs MINIKUBE_DEPLOYMENT=gfs-controller
        selected=true ;;
      external-rest-api/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=external-rest-api NS=profiles MINIKUBE_DEPLOYMENT=external-rest-api
        selected=true ;;
      rpc-proxy/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=rpc-proxy NS=rpc-proxy MINIKUBE_DEPLOYMENT=rpc-proxy
        selected=true ;;
      mcp-host/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=mcp-host NS=mcp-host MINIKUBE_DEPLOYMENT=chatllm
        selected=true ;;
      control-ui/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=control-ui NS=control-plane MINIKUBE_DEPLOYMENT=control-ui
        selected=true ;;
      profile-ui/*)
        MINIKUBE_PROFILE="$T2_PROFILE" make minikube-deploy-service SVC=profile-ui NS=profiles MINIKUBE_DEPLOYMENT=profile-ui
        selected=true ;;
    esac
  done <<< "$changed"
  if [ "$selected" != true ]; then
    printf '[minikube-t2] no service image requires a targeted deployment\n'
  fi
}

run_pre_gate() {
  printf '[minikube-t2] pre-gate-sync after bootstrap/reconcile\n'
  MINIKUBE_PROFILE="$T2_PROFILE" make minikube-pre-gate-sync GATE=minikube-t2 ARGS='--skip-port-forwards'
}

run_t1() {
  [ "$T2_RUN_T1" = true ] || return 0
  printf '[minikube-t2] T1: Real PostgreSQL suites\n'
  if T2_SKIP_LOCK=true CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" MINIKUBE_PROFILE="$T2_PROFILE" \
    bash "$T2_PROJECT_DIR/scripts/e2e/minikube-real-postgres.sh" >"$T2_T1_OUTPUT" 2>&1; then
    cat "$T2_T1_OUTPUT"
    T2_T1_STATUS=PASS
    T2_T1_COUNTS="$(awk -F= '/^T1_TESTS=|^T1_PASSED_TESTS=|^T1_PENDING_TESTS=/{printf "%s%s", (n++ ? "," : ""), $0}' "$T2_T1_OUTPUT")"
    t2_evidence_write T1 PASS "Real PostgreSQL suites executed with no skips; $T2_T1_COUNTS"
  else
    cat "$T2_T1_OUTPUT" >&2 || true
    T2_T1_STATUS=FAIL
    t2_evidence_write T1 FAIL 'Real PostgreSQL lane failed'
    return 1
  fi
}

run_final_preflight() {
  printf '[minikube-t2] final exact-head readiness preflight\n'
  if ! T2_SKIP_LOCK=true T2_PLAN_MODE=true T2_PLAN_FILE="$T2_PLAN_TMP" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    T2_EVIDENCE_ROOT="$T2_EVIDENCE_ROOT" \
    bash "$SCRIPT_DIR/t2-preflight.sh" >"$T2_FINAL_PREFLIGHT_OUTPUT" 2>&1; then
    cat "$T2_FINAL_PREFLIGHT_OUTPUT" >&2 || true
    T2_NEXT_COMMAND='repair the first reported final preflight condition, then re-run T2 on the same HEAD'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'final exact-head readiness preflight failed'
  fi
  T2_T2_STATUS=PASS
  t2_evidence_write T2 PASS 'exact marker, image, PostgreSQL, namespace, Service, and deployment readiness passed'
}

run_healthcheck_if_requested() {
  if [ -z "$T2_HEALTHCHECK_COMMAND" ]; then
    t2_evidence_write Health NOT_RUN 'no profile-owned user-facing health command was supplied'
    return 0
  fi
  if bash -c "$T2_HEALTHCHECK_COMMAND"; then
    t2_evidence_write Health PASS 'profile-owned user-facing health command passed'
  else
    t2_evidence_write Health FAIL 'profile-owned user-facing health command failed'
    T2_NEXT_COMMAND='repair the first failing user-facing health check, then re-run T2 on the same HEAD'
    t2_fail PROFILE_UNHEALTHY 'user-facing health check failed'
  fi
}

run_playwright_if_requested() {
  if [ -z "$T2_PLAYWRIGHT_COMMAND" ]; then
    T2_PLAYWRIGHT_STATUS=NOT_RUN
    t2_evidence_write Playwright NOT_RUN 'no applicable Control UI/Desktop command was supplied'
    if [ "$T2_REQUIRE_PLAYWRIGHT" = true ]; then
      T2_NEXT_COMMAND='set T2_PLAYWRIGHT_COMMAND to the applicable profile-owned Playwright journey and re-run'
      t2_fail ZERO_TESTS_EXECUTED 'Playwright was required but no journey command was supplied'
    fi
    return 0
  fi
  if bash -c "$T2_PLAYWRIGHT_COMMAND"; then
    T2_PLAYWRIGHT_STATUS=PASS
    t2_evidence_write Playwright PASS 'user-visible journey command passed'
  else
    T2_PLAYWRIGHT_STATUS=FAIL
    t2_evidence_write Playwright FAIL 'user-visible journey command failed'
    return 1
  fi
}

main() {
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  if [ "$T2_SKIP_LOCK" != true ]; then t2_lock_acquire; fi
  t2_evidence_init

  run_t0
  if [ "$T2_T0_STATUS" != PASS ]; then
    T2_NEXT_COMMAND='re-run make minikube-t2 with T2_RUN_T0=true so the static lane is executed'
    t2_fail ZERO_TESTS_EXECUTED 'T0 was not executed'
  fi
  run_preflight_plan
  run_bootstrap_or_reconcile
  run_pre_gate
  run_t1
  if [ "$T2_T1_STATUS" != PASS ]; then
    T2_NEXT_COMMAND='re-run make minikube-t2 with T2_RUN_T1=true so the Real PostgreSQL lane is executed'
    t2_fail ZERO_TESTS_EXECUTED 'T1 was not executed'
  fi
  run_final_preflight
  run_healthcheck_if_requested
  run_playwright_if_requested

  t2_evidence_write complete PASS "T0=$T2_T0_STATUS T1=$T2_T1_STATUS T2=$T2_T2_STATUS Playwright=$T2_PLAYWRIGHT_STATUS"
  printf 'MINIKUBE_T2_PASS\n'
  printf 'T0=%s\n' "$T2_T0_STATUS"
  printf 'T1=%s\n' "$T2_T1_STATUS"
  printf 'T2=%s\n' "$T2_T2_STATUS"
  printf 'Playwright=%s\n' "$T2_PLAYWRIGHT_STATUS"
  printf 'evidence=%s\n' "$T2_EVIDENCE_FILE"
}

main "$@"
