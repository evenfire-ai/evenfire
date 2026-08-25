#!/usr/bin/env bash
# Contract tests for the public local Minikube T0/T1/T2 tooling.
set -euo pipefail
set +x
set +u

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
MINIKUBE_DIR="$ROOT/scripts/minikube"
T1="$ROOT/scripts/e2e/minikube-real-postgres.sh"
T1_LOCAL_PREFLIGHT="$ROOT/scripts/e2e/real-postgres-local-preflight.sh"
PREFLIGHT="$MINIKUBE_DIR/t2-preflight.sh"
T2="$MINIKUBE_DIR/t2.sh"
T0="$MINIKUBE_DIR/t0.sh"
GFS_FILTER="$MINIKUBE_DIR/filter-gfs-resources.py"
COMMON="$MINIKUBE_DIR/t2-common.sh"
TMP_ROOT="$TMPDIR"
if [ -z "$TMP_ROOT" ]; then TMP_ROOT=/tmp; fi
set -u

for file in "$MINIKUBE_DIR/profile-readiness.sh" "$ROOT/scripts/tests/test-minikube-profile-readiness.sh" "$COMMON" "$PREFLIGHT" "$T2" "$T1" "$T0" \
  "$ROOT/scripts/e2e/real-postgres-local-preflight.sh" \
  "$ROOT/scripts/e2e/e2e-np08-hcc-authorization.sh" \
  "$ROOT/scripts/minikube/settle-gfs-reader-rollout.sh" \
  "$ROOT/scripts/minikube/wait-gfs-reader-ready.sh" \
  "$ROOT/scripts/minikube/gfs-rollout-shim/kubectl" \
  "$ROOT/scripts/tests/lib/minikube-fixture-repo.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-scenarios.sh" \
  "$ROOT/scripts/tests/test-minikube-settle-gfs-reader-rollout.sh" \
  "$ROOT/scripts/tests/test-minikube-gfs-rollout-shim.sh" \
  "$ROOT/scripts/tests/test-minikube-gfs-provision-order.sh" \
  "$ROOT/scripts/tests/test-minikube-pre-gate-sync-state.sh" \
  "$ROOT/scripts/tests/test-minikube-pre-gate-restore.sh" \
  "$ROOT/scripts/tests/test-minikube-sync-auth-key.sh" \
  "$ROOT/scripts/tests/test-minikube-sync-auth-key-durable.sh" \
  "$ROOT/scripts/tests/test-minikube-mutation-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-targeted-gfs-sync.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-lock-race.sh" \
  "$ROOT/scripts/tests/test-minikube-t1-gfs-restore.sh" \
  "$ROOT/scripts/tests/test-real-postgres-local-preflight.sh" \
  "$ROOT/scripts/tests/test-minikube-t1-docker-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-docker-cli-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-t1-port-forward-owner.sh" \
  "$ROOT/scripts/tests/test-minikube-port-forward-owner.sh" \
  "$ROOT/scripts/tests/test-minikube-docker-cli-env.sh" \
  "$ROOT/scripts/tests/test-minikube-build-images-hardening.sh" \
  "$ROOT/scripts/tests/test-minikube-pull-images.sh" \
  "$ROOT/scripts/tests/test-minikube-build-section-headers.sh" \
  "$ROOT/scripts/tests/test-minikube-pre-gate-shadow.sh" \
  "$ROOT/scripts/tests/test-minikube-fenced-recovery-render.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-process-owner.sh" \
  "$ROOT/scripts/tests/test-minikube-explicit-context.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-evidence.sh" \
  "$ROOT/scripts/tests/test-minikube-targeted-health.sh"; do
  bash -n "$file"
done
"$ROOT/scripts/tests/test-minikube-t1-port-forward-owner.sh"
"$ROOT/scripts/tests/test-minikube-t2-process-owner.sh"
"$ROOT/scripts/tests/test-minikube-explicit-context.sh"
"$ROOT/scripts/tests/test-minikube-t2-evidence.sh"
"$ROOT/scripts/tests/test-minikube-targeted-health.sh"
"$ROOT/scripts/tests/test-minikube-filter-gfs-resources.sh"
"$ROOT/scripts/tests/test-minikube-t1-docker-boundary.sh"
"$ROOT/scripts/tests/test-minikube-pull-images.sh"
"$ROOT/scripts/tests/test-minikube-k8s-api-egress-policy.sh"
"$ROOT/scripts/tests/test-minikube-writer-recovery-state.sh"
"$ROOT/scripts/tests/test-minikube-fenced-recovery-render.sh"
python3 - "$GFS_FILTER" "$TMP_ROOT" <<'PY'
import os
import py_compile
import sys
import tempfile

source = sys.argv[1]
tmp_root = sys.argv[2]
fd, compiled = tempfile.mkstemp(prefix="evenfire-filter-gfs-", suffix=".pyc", dir=tmp_root)
os.close(fd)
try:
    py_compile.compile(source, cfile=compiled, doraise=True)
finally:
    try:
        os.unlink(compiled)
    except FileNotFoundError:
        pass
PY
grep -Fq 't0.sh' "$T2"
grep -Fq 'T0_SHELLCHECK=PASS' "$T0"
grep -Fq 'npm run build' "$T0"
grep -Fq 'npm test' "$T0"
grep -Fq 'if [ "${#package_dirs[@]}" -gt 0 ]' "$T0"
grep -Fq 'Ready pod owner ReplicaSet could not be verified' "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
grep -Fq 'treating marker as stale' "$ROOT/scripts/minikube/pre-gate-sync.sh"
for identity_file in "$COMMON" "$ROOT/scripts/minikube/sync-auth-key.sh" "$ROOT/scripts/minikube/require-t2-mutation-lock.sh" "$ROOT/scripts/minikube/pre-gate-sync.sh"; do
  grep -Fq 't2_worktree_id' "$identity_file"
done
grep -Fq 'bash "$T2_PROJECT_DIR/scripts/tests/test-minikube-t2-contract.sh"' "$T2"

required_codes="DEVELOPMENT_SCOPE_REQUIRED PROFILE_OWNERSHIP_MISMATCH PROFILE_BUSY PROFILE_LOCK_REQUIRED HEAD_MARKER_MISMATCH IMAGE_MANIFEST_MISMATCH BOOTSTRAP_REQUIRED CERTIFICATION_REQUIRED SECRET_MISSING CONFIGMAP_MISSING POSTGRES_NOT_READY REAL_PG_REQUIRED_BUT_UNAVAILABLE REAL_PG_SUITE_FAILED REAL_PG_REPORT_INCOMPLETE UNSUPPORTED_T1_CONCURRENCY ZERO_TESTS_EXECUTED PORT_FORWARD_CONFLICT NP08_HCC_AUTHORIZATION_FAILED PLAYWRIGHT_FAILED"
for code in $required_codes; do
  grep -Fq "$code" "$COMMON" "$PREFLIGHT" "$T2" "$T1" "$T1_LOCAL_PREFLIGHT"
done

grep -Fq 'kubectl --context=' "$COMMON"
grep -Fq 't2_bounded_command' "$COMMON"
grep -Fq 'T2_RUNTIME_TIMEOUT_SECONDS' "$COMMON"
grep -Fq 'T2_RUNTIME_KILL_GRACE_SECONDS' "$COMMON"
grep -Fq 'port-forward-owner.sh' "$COMMON"
grep -Fq 't2_port_forward_targets_context' "$COMMON"
grep -Fq 'matching_records' "$COMMON"
grep -Fq 'pf_owner_record_process_matches' "$COMMON"
grep -Fq 'pf_owner_command_matches' "$ROOT/scripts/minikube/port-forward-owner.sh"
grep -Fq 'T2_MARKER_IMAGES_GENERATED_AT' "$COMMON"
grep -Fq 'image acquisition changed since the pre-gate marker' "$COMMON"
grep -Fq 'trace-maintenance-worker' "$ROOT/scripts/minikube/full-setup.sh"
grep -Fq 'pf_owner_record_process_matches' "$ROOT/scripts/minikube/port-forward-owner.sh"
grep -Fq 'CONTROL_API_REAL_PG_CONTEXT' "$T1"
grep -Fq 'T2_REQUIRED_DEPLOYMENTS' "$COMMON"
grep -Fq 'CONTROL_API_REAL_PG_ADMIN_URL=' "$T1"
grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "$T1"
grep -Fq 'postgres:16-alpine' "$T1"
grep -Fq '*realPostgres*.test.ts' "$T1"
grep -Fq 'is_isolated_control_api_file' "$T1"
grep -Fq 'start_isolated_postgres' "$T1"
grep -Fq 'require_isolated_control_api_files' "$T1"
grep -Fq 'run_suite control-api isolated "$ISOLATED_DSN"' "$T1"
if grep -Fq 'run_suite control-api shared "$ADMIN_DSN"' "$T1"; then
  echo 'FAIL: control-api Real PostgreSQL suites still target the shared profile database' >&2
  exit 1
fi
if grep -Fq 'run_suite control-api isolated "$ADMIN_DSN"' "$T1"; then
  echo 'FAIL: migration/role-reset lane points at shared control-postgres' >&2
  exit 1
fi
if grep -Eq 'describe\.skip|pending_tests.*allow|exclude.*realPostgresMigration' "$T1"; then
  echo 'FAIL: T1 silently excludes or skips the migration suite' >&2
  exit 1
fi
grep -Fq 'T1_REDACT_PASSWORD="${PG_PASSWORD}"' "$T1" || grep -Fq 'T1_REDACT_PASSWORD="$PG_PASSWORD"' "$T1"
grep -Fq -- '--reporter=json' "$T1"
grep -Fq '|| suite_status=$?' "$T1"
grep -Fq 'Vitest process exited $suite_status' "$T1"
grep -Fq 'complete green JSON reporter' "$T1"
grep -Fq 'pending_tests' "$T1"
grep -Fq 'numTotalTests' "$T1"
grep -Fq 'numTotalTestSuites' "$T1"
grep -Fq 'passed_suites' "$T1"
grep -Fq 'testResults' "$T1"
grep -Fq 'T1_EXPECTED_FILES' "$T1"
grep -Fq 'T1_REPORTED_FILES' "$T1"
grep -Fq -- '--maxWorkers=1' "$T1"
grep -Fq 'run_t1_local_preflight' "$T2"
grep -Fq 'T2_SETUP_HANDOFF_REQUIRED=true' "$T2"
grep -Fq 't2-setup-handoff.sh" consume --' "$ROOT/scripts/minikube/pre-gate-sync.sh"
grep -Fq 'minikube-verify-images' "$ROOT/scripts/minikube/pre-gate-sync.sh"
grep -Fq 'with-t2-mutation-lock.sh' "$ROOT/scripts/minikube/setup.sh"
grep -Fq 'T2_MUTATION_LOCK_WRAPPED' "$ROOT/scripts/minikube/setup.sh"
grep -Fq 'require-t2-mutation-lock.sh' "$ROOT/scripts/minikube/setup.sh"
grep -Fq 'PROFILE_LOCK_REQUIRED: setup.sh requires matching' "$ROOT/scripts/minikube/setup.sh"
grep -Fq 'PROFILE="${MINIKUBE_PROFILE:-${T2_PROFILE:-}}"' "$ROOT/scripts/minikube/setup.sh"
if grep -Fq 'PROFILE="clerum-test"' "$ROOT/scripts/minikube/setup.sh"; then
  echo 'FAIL: legacy setup still defaults to the shared clerum-test profile' >&2
  exit 1
fi
setup_guard_line="$(grep -nF 'if [ "${T2_MUTATION_LOCK_WRAPPED:-false}" != true ]; then' "$ROOT/scripts/minikube/setup.sh" | cut -d: -f1)"
setup_cluster_line="$(grep -nF 'cluster-info' "$ROOT/scripts/minikube/setup.sh" | head -1 | cut -d: -f1)"
if [[ -z "$setup_guard_line" || -z "$setup_cluster_line" || "$setup_guard_line" -ge "$setup_cluster_line" ]]; then
  echo 'FAIL: legacy setup can mutate or probe the cluster before the lease wrapper' >&2
  exit 1
fi
full_setup_lock_line="$(grep -nF 't2_mutation_lock' "$ROOT/scripts/minikube/full-setup.sh" | head -1 | cut -d: -f1)"
full_setup_status_line="$(grep -nF 'CLUSTER_STATUS="$(minikube_status_snapshot)"' "$ROOT/scripts/minikube/full-setup.sh" | head -1 | cut -d: -f1)"
if [[ -z "$full_setup_lock_line" || -z "$full_setup_status_line" || "$full_setup_lock_line" -ge "$full_setup_status_line" ]]; then
  echo 'FAIL: full-setup can probe or mutate the profile before the lease wrapper' >&2
  exit 1
fi
for timed_phase in 't2_evidence_write planner PASS' 't2_evidence_write transition PASS' \
  't2_evidence_write pre-gate-sync PASS' 't2_evidence_write T1 PASS' \
  't2_evidence_write T2 PASS' 't2_evidence_write NP08_HCC_AUTHORIZATION PASS'; do
  grep -Fq "$timed_phase" "$T2"
done
grep -Fq 'duration=' "$T2"
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "$T1"
grep -Fq 'reconcile-gfs-deploy-credentials.sh' "$T1"
if grep -Fq "[ \"\$passed_files\" -ne \"\$expected\" ]" "$T1"; then
  echo 'FAIL: T1 compares Vitest nested suite counts to physical file counts' >&2
  exit 1
fi
grep -Fq 'port-forward' "$T1"
# The pf must be a direct kubectl child: backgrounding the t2_kc function
# records the subshell PID, cleanup never matches *port-forward*, and the
# orphaned kubectl fails the final preflight with PORT_FORWARD_CONFLICT.
if grep -Eq 't2_kc[^|]*port-forward' "$T1"; then
  echo 'FAIL: T1 backgrounds the control-postgres port-forward through the t2_kc function' >&2
  exit 1
fi
grep -Fq 'kubectl --context="$T2_CONTEXT" -n "$PG_NAMESPACE" port-forward' "$T1"
grep -Fq 'pf_owner_record_process "$PORT_FORWARD_RECORD" "$PORT_FORWARD_PID"' "$T1"
grep -Fq 'pf_owner_cleanup_record "$PORT_FORWARD_RECORD"' "$T1"
grep -Fq 'T1_PORT_FORWARD_CLEANUP_OK=false' "$T1"
grep -Fq 'preserving T1 temp directory because port-forward ownership cleanup was not proven' "$T1"
grep -Fq 'set +x' "$T1" "$PREFLIGHT" "$T2"

# T1 must restore the branch-profile GFS credentials on the way out with the
# same canonical script and NOLOGIN opt-in the GFS T1 gate uses, so a T1 run
# cannot leave gfsc-reader unready and fail the exact-head T2 preflight.
grep -Fq 'restore_gfs_runtime_credentials' "$T1"
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "$T1"
grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true' "$T1"
grep -Fq 'reconcile-gfs-deploy-credentials.sh' "$T1"
grep -Fq 'T1_GFS_RESTORE_REQUIRED=true' "$T1"
grep -Fq "trap 'handle_t1_signal INT' INT" "$T1"
grep -Fq "trap 'handle_t1_signal TERM' TERM" "$T1"
grep -Fq 'T1_STATUS=%s' "$T1"
grep -Fq 'cleanup=PASS' "$T1"
if grep -Fq 'trap cleanup_t1 EXIT INT TERM' "$T1"; then
  echo 'FAIL: T1 still treats a signal as an ordinary EXIT cleanup' >&2
  exit 1
fi
grep -Fq 'settle-gfs-reader-rollout.sh' "$T1"
grep -Fq 'gfs-rollout-shim' "$T1"
grep -Fq 'T2_UNREADY_DEPLOYMENTS' "$COMMON"
grep -Fq 'required gfs-controller-db Secret is missing or unreadable' "$T1"
grep -Fq 'T1_STATUS' "$T2"
grep -Fq 'T1_PENDING_TESTS' "$T2"
grep -Fq 'T1 result was incomplete despite a zero process exit' "$T2"
grep -Fq 'VERIFY_AUTH_RETRIES' "$ROOT/scripts/minikube/verify-gfs.sh"
grep -Fq 'authentication probe remained unavailable' "$ROOT/scripts/minikube/verify-gfs.sh"
grep -Fq 'GFS mutation disabled for this non-T2 sync' "$ROOT/Makefile"
grep -Fq 'filter-gfs-resources.py' "$ROOT/Makefile"
grep -Fq 'MINIKUBE_GFS_MUTATION' "$ROOT/scripts/minikube/pre-gate-sync.sh"
grep -Fq 'T2_LOCK_TOKEN="${T2_LOCK_TOKEN}"' "$ROOT/scripts/minikube/pre-gate-sync.sh"
grep -Fq 'T2_LOCK_RELEASED' "$COMMON"
grep -Fq 'leaving the writer fence armed' "$ROOT/scripts/minikube/pre-gate-sync.sh"
if grep -Fq 'gke_*)' "$ROOT/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
  echo 'FAIL: remote GFS authorization still depends on a gke_* name prefix' >&2
  exit 1
fi

# pre-gate-sync GFS serving provisioning must opt into restoring a NOLOGIN
# role from the committed Secret DSN. Only the T2 transition owns this
# mutation; security gates refresh MCP auth without touching the GFS plane.
PRE_GATE="$MINIKUBE_DIR/pre-gate-sync.sh"
grep -Fq 'scale_rc=0 rollout_rc=0' "$PRE_GATE"
grep -Fq 'leaving the writer fence armed' "$PRE_GATE"
if ! sed -n '/^reconcile_gfs_credentials()/,/^}/p' "$PRE_GATE" | grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true'; then
  echo 'FAIL: reconcile_gfs_credentials does not restore a NOLOGIN GFS role from the committed Secret DSN' >&2
  exit 1
fi
if ! sed -n '/^reconcile_gfs_credentials()/,/^}/p' "$PRE_GATE" | grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true'; then
  echo 'FAIL: reconcile_gfs_credentials does not resume an interrupted gfsc-reader rollout claim' >&2
  exit 1
fi
if ! sed -n '/^settle_gfs_reader_rollout()/,/^}/p' "$PRE_GATE" | grep -Fq 'settle-gfs-reader-rollout.sh'; then
  echo 'FAIL: settle_gfs_reader_rollout does not settle a Ready gfsc-reader leftover rollout claim before reconcile' >&2
  exit 1
fi
if ! sed -n '/^reconcile_gfs_credentials()/,/^}/p' "$PRE_GATE" | grep -Fq 'gfs-rollout-shim'; then
  echo 'FAIL: reconcile_gfs_credentials does not use the HCC-safe reader rollout wait' >&2
  exit 1
fi
if ! sed -n '/^sync_gfs_auth_key()/,/^}/p' "$PRE_GATE" | grep -Fq 'sync-auth-key.sh'; then
  echo 'FAIL: sync_gfs_auth_key does not re-sync gfs-config.jwt-public-key before reconcile (an empty key blocks every new reader pod)' >&2
  exit 1
fi
if ! sed -n '/^converge_gfs_reader_after_restore()/,/^}/p' "$PRE_GATE" | grep -Fq 'wait-gfs-reader-ready.sh'; then
  echo 'FAIL: converge_gfs_reader_after_restore still waits on a generation-based rollout status HCC keeps rewriting' >&2
  exit 1
fi
if ! sed -n '/^provision_gfs_serving()/,/^}/p' "$PRE_GATE" | grep -Fq 'only minikube-t2 owns GFS recovery'; then
  echo 'FAIL: pre-gate-sync does not scope GFS recovery mutations to minikube-t2' >&2
  exit 1
fi
if ! sed -n '/^sync_mcp_host_auth_key()/,/^}/p' "$PRE_GATE" | grep -Fq -- '--skip-gfs'; then
  echo 'FAIL: non-T2 MCP auth refresh can still mutate GFS' >&2
  exit 1
fi
if ! sed -n '/^sync_gfs_auth_key()/,/^}/p' "$PRE_GATE" | grep -Fq -- '--require-gfs'; then
  echo 'FAIL: T2 GFS auth refresh is not strict about its source key' >&2
  exit 1
fi
grep -Fq 'converge_gfs_reader_after_restore' "$PRE_GATE"
if [[ "$(grep -c 'GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true' "$ROOT/scripts/minikube/full-setup.sh")" -lt 2 ]]; then
  echo 'FAIL: full-setup REUSE_DB path must restore a NOLOGIN GFS role and resume an abandoned reader rollout before and after overlay' >&2
  exit 1
fi
if [[ "$(grep -c 'scripts/minikube/settle-gfs-reader-rollout.sh' "$ROOT/scripts/minikube/full-setup.sh")" -lt 2 ]]; then
  echo 'FAIL: full-setup REUSE_DB path must settle a Ready gfsc-reader leftover rollout claim before both reconciles' >&2
  exit 1
fi
if [[ "$(grep -c 'gfs-rollout-shim' "$ROOT/scripts/minikube/full-setup.sh")" -lt 2 ]]; then
  echo 'FAIL: full-setup REUSE_DB reconciles must use the HCC-safe reader rollout wait on both calls' >&2
  exit 1
fi
if [[ "$(grep -c 'sync-auth-key.sh' "$ROOT/scripts/minikube/full-setup.sh")" -lt 3 ]]; then
  echo 'FAIL: full-setup must re-sync gfs-config.jwt-public-key before both GFS reconciles (the overlay re-applies it empty)' >&2
  exit 1
fi
if [[ "$(grep -c -- '--require-gfs' "$ROOT/scripts/minikube/full-setup.sh")" -lt 3 ]]; then
  echo 'FAIL: every GFS-specific full-setup auth sync must require a non-empty source key' >&2
  exit 1
fi
if [[ "$(grep -c 'T2_SKIP_LOCK=true' "$ROOT/scripts/minikube/full-setup.sh")" -lt 4 ]]; then
  echo 'FAIL: full-setup GFS child mutators must validate the parent lease instead of acquiring a second lock' >&2
  exit 1
fi

if grep -Eq 'make minikube-pre-gate-sync|pre-gate-sync\.sh' "$PREFLIGHT"; then
  echo 'FAIL: preflight invokes pre-gate-sync' >&2
  exit 1
fi
grep -Fq 'full-bootstrap' "$PREFLIGHT" "$T2"
grep -Fq 'run_pre_gate' "$T2"
grep -Fq 'run_targeted_sync' "$T2"
grep -Fq 'full-reconcile' "$T2"
grep -Fq 'T2_SKIP_LOCK=true' "$T2"
grep -Fq 'T2_PLAN_MODE=true T2_PLAN_FILE' "$T2"
grep -Fq 'REUSE_DB=true' "$T2"
grep -Fq 'T2_T0_STATUS=NOT_RUN' "$T2"
grep -Fq 'T2_T1_STATUS=NOT_RUN' "$T2"
grep -Fq 'T2_NP08_HCC_AUTHORIZATION_STATUS=NOT_RUN' "$T2"
grep -Fq 't2_lane_completed "$T2_T0_STATUS"' "$T2"
grep -Fq 't2_lane_completed "$T2_T1_STATUS"' "$T2"
grep -Fq 'T2_HEALTHCHECK_COMMAND' "$T2"
grep -Fq 'validate_healthcheck_contract' "$T2"
grep -Fq 'T2_HEALTHCHECK_REQUIRED=true' "$T2"
grep -Fq -- '--label t2-user-facing-health' "$T2"
grep -Fq 'Health=$T2_HEALTH_STATUS' "$T2"
grep -Fq 'run_np08_hcc_authorization' "$T2"
grep -Fq "CLERUM_PROFILE_PORTS_ENV=\"\$T2_PORTS_ENV\"" "$T2"
grep -Fq 'NP08_HCC_AUTHORIZATION PASS' "$T2"
grep -Fq "NP08_HCC_AUTHORIZATION=\$T2_NP08_HCC_AUTHORIZATION_STATUS" "$T2"
grep -Fq 'already-synced' "$T2" "$COMMON"
grep -Fq 'T2_LOCK_TOKEN="$T2_LOCK_TOKEN"' "$T2"
[[ "$(grep -Fc 'ARGS= make minikube-setup' "$T2")" -eq 4 ]] || {
  echo 'FAIL: T2 bootstrap/reconcile does not clear inherited setup ARGS on all four paths' >&2
  exit 1
}
grep -Fq 'T2_PLAN_MODE=true T2_PLAN_FILE' "$T2"
grep -Fq 'T2_PLAN_MODE=false T2_PLAN_FILE' "$T2"
grep -Fq 'T2_PLAN_MODE=false' "$PREFLIGHT"
grep -Fq -- '--skip-port-forwards' "$T2"
grep -Fq 't2_lane_completed' "$T2"
grep -Fq 'T2_T0_STATUS=SKIPPED' "$T2"
grep -Fq 'T2_T1_STATUS=SKIPPED' "$T2"
grep -Fq 'REUSE_DB=true' "$T2"
grep -Fq 'T2_T0_STATUS=NOT_RUN' "$T2"
grep -Fq 'T2_T1_STATUS=NOT_RUN' "$T2"
grep -Fq 'T2_HEALTHCHECK_COMMAND' "$T2"
grep -Fq 'minikube-t2-runtime' "$ROOT/Makefile"
post_runtime_process_check_line="$(grep -nF 'if ! t2_process_check; then' "$T2" | tail -1 | cut -d: -f1)"
complete_pass_line="$(grep -nF 't2_evidence_write complete PASS' "$T2" | tail -1 | cut -d: -f1)"
if [ -z "$post_runtime_process_check_line" ] || [ -z "$complete_pass_line" ] ||
   [ "$post_runtime_process_check_line" -ge "$complete_pass_line" ]; then
  echo 'FAIL: T2 does not revalidate port-forward ownership before complete PASS' >&2
  exit 1
fi
if ! grep -Fq 'instead of already-synced' "$T2"; then
  echo 'FAIL: final T2 preflight does not require already-synced' >&2
  exit 1
fi
if grep -Eq 'make minikube-pre-gate-sync GATE=minikube-t2$' "$T2"; then
  echo 'FAIL: orchestrator pre-gate-sync still starts port-forwards' >&2
  exit 1
fi

grep -Fq 't2_mutation_lock' "$COMMON"
grep -Fq 't2_lock_validate_inherited' "$COMMON"
grep -Fq 'T2_LOCK_ROOT' "$COMMON"
grep -Fq 'REPOSITORY=' "$COMMON"
grep -Fq 'BRANCH=' "$COMMON"
grep -Fq 'HEAD=' "$COMMON"
grep -Fq 'PROFILE=' "$COMMON"
grep -Fq 'CONTEXT=' "$COMMON"
grep -Fq 'LOCK_KEY=' "$COMMON"
grep -Fq 'TOKEN=' "$COMMON"
grep -Fq 'WORKTREE_ID=' "$COMMON"
grep -Fq 'PID=' "$COMMON"
grep -Fq 'PROCESS_START=' "$COMMON"

if grep -Eq 'get secret .* -o (yaml|json)' "$COMMON" "$PREFLIGHT"; then
  echo 'FAIL: preflight reads Secret values' >&2
  exit 1
fi
grep -Fq 'clusterFingerprintRef' "$COMMON"
grep -Fq 'imageManifestRef' "$COMMON"
grep -Fq 'cluster.server' "$COMMON"
grep -Fq 'PUBLIC_BOUNDARY_BASE_UNRESOLVED' "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh"
if grep -Fq 'ADMIN_DSN=' "$COMMON" "$PREFLIGHT"; then
  echo 'FAIL: preflight contains an admin DSN' >&2
  exit 1
fi

tmp="$(mktemp -d "$TMP_ROOT/evenfire-t2-contract.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT
T2_LOCK_ROOT="$tmp/locks" MINIKUBE_PROFILE=clerum-test-contract T2_CONTEXT=clerum-test-contract \
T2_PROJECT_DIR="$ROOT" T2_BRANCH=test/minikube-contract T2_HEAD=0123456789abcdef \
T2_ORIGIN_DEV=0123456789abcdef T2_MERGE_BASE=0123456789abcdef \
bash -c '
  source "$1"
  parsed="$(t2_get_name control-plane/control-postgres)"
  test "$parsed" = "control-plane	control-postgres"
  t2_lock_acquire
  t2_lock_release
' bash "$COMMON"
if [ -e "$tmp/locks/clerum-test-contract.lock" ]; then
  echo 'FAIL: lock was not cleaned after clean exit' >&2
  exit 1
fi

# A nested mutator must prove the exact opaque lease token and owner identity;
# T2_SKIP_LOCK=true alone is not an authorization mechanism.
T2_LOCK_ROOT="$tmp/fenced-locks" T2_PROJECT_DIR="$ROOT" \
T2_BRANCH=feat/contract-fence T2_HEAD=0123456789abcdef \
T2_ORIGIN_DEV=0123456789abcdef T2_MERGE_BASE=0123456789abcdef \
MINIKUBE_PROFILE=clerum-fence T2_CONTEXT=clerum-fence \
T2_WORKTREE_ID=contract-worktree \
bash -c '
  common="$1"
  source "$common"
  t2_lock_acquire
  token="$T2_LOCK_TOKEN"
  export T2_PROJECT_DIR T2_BRANCH T2_HEAD T2_ORIGIN_DEV T2_MERGE_BASE
  export MINIKUBE_PROFILE T2_PROFILE T2_CONTEXT T2_WORKTREE_ID T2_LOCK_ROOT
  if ! T2_SKIP_LOCK=true T2_LOCK_TOKEN="$token" bash -c '\''source "$1"; t2_lock_validate_inherited'\'' bash "$common"; then
    exit 1
  fi
  if T2_SKIP_LOCK=true T2_LOCK_TOKEN=wrong bash -c '\''source "$1"; t2_lock_validate_inherited'\'' bash "$common"; then
    exit 1
  fi
  saved_token="$T2_LOCK_TOKEN"
  T2_LOCK_TOKEN=wrong
  if t2_lock_validate_inherited; then
    echo "inherited lock validation returned success after a guard fired" >&2
    exit 1
  fi
  T2_LOCK_TOKEN="$saved_token"
  t2_lock_release 0
' bash "$COMMON"
if [ -e "$tmp/fenced-locks/clerum-fence.lock" ]; then
  echo 'FAIL: fenced lock survived the owner release' >&2
  exit 1
fi

mkdir -p "$tmp/locks/busy-profile.lock"
cat >"$tmp/locks/busy-profile.lock/owner.env" <<EOF
PROFILE=busy-profile
TOKEN=lock
PID=$$
EOF
if T2_LOCK_ROOT="$tmp/locks" MINIKUBE_PROFILE=busy-profile T2_CONTEXT=busy-profile \
  T2_PROJECT_DIR="$ROOT" T2_BRANCH=test/minikube-contract T2_HEAD=0123456789abcdef \
  T2_ORIGIN_DEV=0123456789abcdef T2_MERGE_BASE=0123456789abcdef \
  bash -c 'source "$1"; t2_lock_acquire' bash "$COMMON" 2>"$tmp/busy.err"; then
  echo 'FAIL: live profile owner was replaced' >&2
  exit 1
fi
grep -Fq 'PROFILE_BUSY' "$tmp/busy.err"

mkdir -p "$tmp/locks/empty-profile.lock"
if T2_LOCK_ROOT="$tmp/locks" MINIKUBE_PROFILE=empty-profile T2_CONTEXT=empty-profile \
  T2_PROJECT_DIR="$ROOT" T2_BRANCH=test/minikube-contract T2_HEAD=0123456789abcdef \
  T2_ORIGIN_DEV=0123456789abcdef T2_MERGE_BASE=0123456789abcdef \
  bash -c 'source "$1"; t2_lock_acquire' bash "$COMMON" 2>"$tmp/empty.err"; then
  echo 'FAIL: an ownerless profile lock was reclaimed' >&2
  exit 1
fi
grep -Fq 'PROFILE_BUSY' "$tmp/empty.err"
grep -Fq 'orphaned' "$tmp/empty.err"

cert_root="$tmp/certifications"
mkdir -p "$cert_root/prior" "$cert_root/current"
CERT_FILE="$cert_root/prior/evidence.json" EXPECTED_REPOSITORY="$ROOT" \
EXPECTED_BRANCH=feat/certification EXPECTED_HEAD=cert-head EXPECTED_ORIGIN_DEV=cert-dev \
EXPECTED_WORKTREE_ID=cert-worktree EXPECTED_PROFILE=clerum-cert EXPECTED_CONTEXT=clerum-cert \
EXPECTED_FINGERPRINT=cert-fingerprint EXPECTED_GATE_ID=cert-gate \
python3 - <<'PY'
import json
import os
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)
payload = {
    "certificationVersion": 1,
    "attestationStatus": "PASS",
    "runId": "prior-certification-run",
    "attestationStartedAt": now.isoformat().replace("+00:00", "Z"),
    "attestationExpiresAt": (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
    "repository": os.environ["EXPECTED_REPOSITORY"],
    "branch": os.environ["EXPECTED_BRANCH"],
    "head": os.environ["EXPECTED_HEAD"],
    "originDev": os.environ["EXPECTED_ORIGIN_DEV"],
    "worktreeId": os.environ["EXPECTED_WORKTREE_ID"],
    "profile": os.environ["EXPECTED_PROFILE"],
    "context": os.environ["EXPECTED_CONTEXT"],
    "clusterFingerprintRef": os.environ["EXPECTED_FINGERPRINT"],
    "gateId": os.environ["EXPECTED_GATE_ID"],
    "phases": [
        {"name": "T0", "status": "PASS"},
        {"name": "T1", "status": "PASS"},
        {"name": "complete", "status": "PASS"},
    ],
}
with open(os.environ["CERT_FILE"], "w") as handle:
    json.dump(payload, handle)
PY
T2_EVIDENCE_ROOT="$cert_root" T2_PROJECT_DIR="$ROOT" T2_BRANCH=feat/certification \
T2_HEAD=cert-head T2_ORIGIN_DEV=cert-dev T2_MERGE_BASE=cert-dev \
T2_WORKTREE_ID=cert-worktree T2_PROFILE=clerum-cert T2_CONTEXT=clerum-cert \
T2_CLUSTER_FINGERPRINT=cert-fingerprint T2_GATE_ID=cert-gate \
T2_RUN_ID=current-certification-run \
bash -c '
  source "$1"
  T2_PROJECT_DIR="$3"
  T2_BRANCH=feat/certification
  T2_HEAD=cert-head
  T2_ORIGIN_DEV=cert-dev
  T2_MERGE_BASE=cert-dev
  T2_WORKTREE_ID=cert-worktree
  T2_PROFILE=clerum-cert
  T2_CONTEXT=clerum-cert
  T2_CLUSTER_FINGERPRINT=cert-fingerprint
  T2_GATE_ID=cert-gate
  T2_RUN_ID=current-certification-run
  T2_EVIDENCE_DIR="$2/current-run"
  T2_EVIDENCE_FILE="$T2_EVIDENCE_DIR/evidence.json"
  mkdir -p "$T2_EVIDENCE_DIR"
  t2_certification_validate_prior_lanes
  test "$T2_T0_CERTIFIED" = true
  test "$T2_T1_CERTIFIED" = true
  grep -Fq T0_ATTESTED "$T2_EVIDENCE_FILE"
  grep -Fq T1_ATTESTED "$T2_EVIDENCE_FILE"
' bash "$COMMON" "$cert_root" "$ROOT"

python3 - "$cert_root/prior/evidence.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as handle:
    payload = json.load(handle)
payload["attestationStatus"] = "INVALIDATED"
with open(sys.argv[1], "w") as handle:
    json.dump(payload, handle)
PY
if T2_EVIDENCE_ROOT="$cert_root" T2_PROJECT_DIR="$ROOT" T2_BRANCH=feat/certification \
  T2_HEAD=cert-head T2_ORIGIN_DEV=cert-dev T2_MERGE_BASE=cert-dev \
  T2_WORKTREE_ID=cert-worktree T2_PROFILE=clerum-cert T2_CONTEXT=clerum-cert \
  T2_CLUSTER_FINGERPRINT=cert-fingerprint T2_GATE_ID=cert-gate \
  bash -c '
    source "$1"
    T2_PROJECT_DIR="$2"
    T2_BRANCH=feat/certification
    T2_HEAD=cert-head
    T2_ORIGIN_DEV=cert-dev
    T2_MERGE_BASE=cert-dev
    T2_WORKTREE_ID=cert-worktree
    T2_PROFILE=clerum-cert
    T2_CONTEXT=clerum-cert
    T2_CLUSTER_FINGERPRINT=cert-fingerprint
    T2_GATE_ID=cert-gate
    t2_certification_validate_prior_lanes
  ' bash "$COMMON" "$ROOT" 2>"$tmp/certification.err"; then
  echo 'FAIL: invalidated certification was accepted' >&2
  exit 1
fi
grep -Fq CERTIFICATION_REQUIRED "$tmp/certification.err"

redaction_file="$tmp/t1-redaction.log"
redaction_secret='super-secret'
printf '%s=%s\n' password "$redaction_secret" >"$redaction_file"
env T2_PROJECT_DIR="$ROOT" bash -c \
  'source "$1"; T1_REDACT_PASSWORD="$3"; PG_PASSWORD="$3"; unset PG_PASSWORD; sanitize_file "$2"' \
  bash "$T1" "$redaction_file" "$redaction_secret"
grep -Fq '<password-redacted>' "$redaction_file"
if grep -Fq "$redaction_secret" "$redaction_file"; then
  echo 'FAIL: T1 redaction lost the password after PG_PASSWORD cleanup' >&2
  exit 1
fi

# A complete green reporter is not sufficient evidence when npm/Vitest exits
# non-zero during teardown, worker shutdown, OOM handling, or signal cleanup.
# Exercise the adjudicator with representative failure statuses without Docker
# or Kubernetes; every one must fail the suite despite the green JSON payload.
t1_exit_root="$tmp/t1-exit-adjudicator"
mkdir -p "$t1_exit_root/control-api/test" "$t1_exit_root/control-api/node_modules/.bin"
printf 'fixture\n' >"$t1_exit_root/control-api/test/fake.realPostgres.test.ts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$t1_exit_root/control-api/node_modules/.bin/vitest"
chmod +x "$t1_exit_root/control-api/node_modules/.bin/vitest"
for exit_code in 1 2 7 126 137; do
  if EXIT_CODE="$exit_code" T1_EXIT_ROOT="$t1_exit_root" bash -c '
    set -euo pipefail
    source "$1"
    PROJECT_DIR="$T1_EXIT_ROOT"
    T1_TMP_DIR="$(mktemp -d)"
    trap '\''rm -rf "$T1_TMP_DIR"'\'' EXIT
    list_real_pg_files() {
      printf "%s\\n" "$T1_EXIT_ROOT/control-api/test/fake.realPostgres.test.ts"
    }
    is_isolated_control_api_file() { return 0; }
    npm() {
      local output_file=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --outputFile=*) output_file="${1#--outputFile=}" ;;
          --outputFile) shift; output_file="$1" ;;
        esac
        shift
      done
      printf '\''{"success":true,"testResults":[{"name":"%s","status":"passed"}],"numTotalTestSuites":1,"numPassedTestSuites":1,"numFailedTestSuites":0,"numPassedTests":1,"numFailedTests":0,"numPendingTestSuites":0,"numPendingTests":0,"numTotalTests":1}\n'\'' \
        "$T1_EXIT_ROOT/control-api/test/fake.realPostgres.test.ts" >"$output_file"
      return "$EXIT_CODE"
    }
    run_suite control-api isolated postgresql://isolated
    exit 0
  ' bash "$T1" 2>"$tmp/t1-exit-$exit_code.err"; then
    echo "FAIL: T1 accepted a green reporter after npm exit $exit_code" >&2
    exit 1
  fi
  grep -Fq "Vitest process exited $exit_code" "$tmp/t1-exit-$exit_code.err"
done

bash "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh"
if T2_PUBLIC_BASE_REF=nonexistent-ref-for-contract \
  bash "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh"; then
  echo 'FAIL: public boundary accepted an unresolved base ref' >&2
  exit 1
fi

public_repo="$tmp/public-repo"
mkdir -p "$public_repo"
git init -q -b dev "$public_repo"
git -C "$public_repo" config user.email test@example.invalid
git -C "$public_repo" config user.name boundary-test
printf 'base\n' >"$public_repo/README.md"
git -C "$public_repo" add README.md
git -C "$public_repo" commit -q -m base
public_base="$(git -C "$public_repo" rev-parse HEAD)"
printf 'DATABASE_URL=%s://private-host:5432/db\n' postgresql >"$public_repo/runtime.txt"
if T2_PUBLIC_ROOT="$public_repo" T2_PUBLIC_BASE_REF="$public_base" \
  bash "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh"; then
  echo 'FAIL: public boundary ignored a secret in an untracked file' >&2
  exit 1
fi
bash "$ROOT/scripts/tests/test-minikube-t2-scenarios.sh"
bash "$ROOT/scripts/tests/test-minikube-profile-readiness.sh"
bash "$ROOT/scripts/tests/test-minikube-settle-gfs-reader-rollout.sh"
bash "$ROOT/scripts/tests/test-minikube-gfs-rollout-shim.sh"
bash "$ROOT/scripts/tests/test-minikube-gfs-provision-order.sh"
bash "$ROOT/scripts/tests/test-minikube-pre-gate-sync-state.sh"
bash "$ROOT/scripts/tests/test-minikube-pre-gate-restore.sh"
python3 "$ROOT/scripts/tests/test-discover-configmap-key-consumers-properties.py"
bash "$ROOT/scripts/tests/test-minikube-sync-auth-key.sh"
bash "$ROOT/scripts/tests/test-minikube-sync-auth-key-durable.sh"
bash "$ROOT/scripts/tests/test-minikube-mutation-boundary.sh"
bash "$ROOT/scripts/tests/test-minikube-targeted-gfs-sync.sh"
bash "$ROOT/scripts/tests/test-minikube-t2-lock-race.sh"
bash "$ROOT/scripts/tests/test-minikube-t1-gfs-restore.sh"
bash "$ROOT/scripts/tests/test-real-postgres-local-preflight.sh"
bash "$ROOT/scripts/tests/test-minikube-port-forward-owner.sh"
bash "$ROOT/scripts/tests/test-minikube-docker-cli-boundary.sh"
bash "$ROOT/scripts/tests/test-minikube-docker-cli-env.sh"
bash "$ROOT/scripts/tests/test-minikube-build-images-hardening.sh"
bash "$ROOT/scripts/tests/test-minikube-build-section-headers.sh"
bash "$ROOT/scripts/tests/test-minikube-pre-gate-shadow.sh"

printf 'PASS: local Minikube T0/T1/T2 contract checks\n'
