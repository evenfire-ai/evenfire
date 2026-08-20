#!/usr/bin/env bash
# Contract tests for the public local Minikube T0/T1/T2 tooling.
set -euo pipefail
set +x
set +u

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
MINIKUBE_DIR="$ROOT/scripts/minikube"
T1="$ROOT/scripts/e2e/minikube-real-postgres.sh"
PREFLIGHT="$MINIKUBE_DIR/t2-preflight.sh"
T2="$MINIKUBE_DIR/t2.sh"
COMMON="$MINIKUBE_DIR/t2-common.sh"
TMP_ROOT="$TMPDIR"
if [ -z "$TMP_ROOT" ]; then TMP_ROOT=/tmp; fi
set -u

for file in "$COMMON" "$PREFLIGHT" "$T2" "$T1" \
  "$ROOT/scripts/minikube/settle-gfs-reader-rollout.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-scenarios.sh" \
  "$ROOT/scripts/tests/test-minikube-settle-gfs-reader-rollout.sh"; do
  bash -n "$file"
done

required_codes="DEVELOPMENT_SCOPE_REQUIRED PROFILE_OWNERSHIP_MISMATCH PROFILE_BUSY HEAD_MARKER_MISMATCH IMAGE_MANIFEST_MISMATCH BOOTSTRAP_REQUIRED SECRET_MISSING CONFIGMAP_MISSING POSTGRES_NOT_READY REAL_PG_REQUIRED_BUT_UNAVAILABLE REAL_PG_SUITE_FAILED ZERO_TESTS_EXECUTED PORT_FORWARD_CONFLICT"
for code in $required_codes; do
  grep -Fq "$code" "$COMMON" "$PREFLIGHT" "$T2" "$T1"
done

grep -Fq 'kubectl --context=' "$COMMON"
if grep -Eq 'while IFS= read -r uid pid ppid rest' "$COMMON"; then
  echo 'FAIL: t2_process_check IFS= prevents UID/PID split' >&2
  exit 1
fi
grep -Fq 'while read -r uid pid ppid rest' "$COMMON"
if grep -Fq '[0-9]+:[0-9]+(:[0-9]+)?(\.[0-9]+)?' "$COMMON"; then
  echo 'FAIL: t2_process_check awk still anchors on a TIME-column regex' >&2
  exit 1
fi
if grep -Fq 'kubectl[[:space:]]+port-forward' "$COMMON"; then
  echo 'FAIL: t2_process_check awk still requires kubectl/port-forward adjacency' >&2
  exit 1
fi
grep -Fq '([^[:space:]]*\/)?kubectl([[:space:]]|$)' "$COMMON"
grep -Fq '[[:space:]]port-forward([[:space:]]|$)' "$COMMON"
grep -Fq 'CONTROL_API_REAL_PG_CONTEXT' "$T1"
grep -Fq 'CONTROL_API_REAL_PG_ADMIN_URL=' "$T1"
grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "$T1"
grep -Fq 'postgres:16-alpine' "$T1"
grep -Fq 'db.realPostgresMigration.integration.test.ts' "$T1"
grep -Fq 'gfsReaderRole.realPostgres.integration.test.ts' "$T1"
grep -Fq 'start_isolated_postgres' "$T1"
grep -Fq 'require_isolated_control_api_files' "$T1"
grep -Fq 'run_suite control-api isolated "$ISOLATED_DSN"' "$T1"
grep -Fq 'run_suite control-api shared "$ADMIN_DSN"' "$T1"
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
grep -Fq 'complete green reporter' "$T1"
if grep -Fq 'Real PostgreSQL suite failed in $package ($lane)' "$T1"; then
  echo 'FAIL: T1 still treats npm exit as a suite failure before the JSON reporter' >&2
  exit 1
fi
grep -Fq 'pending_tests' "$T1"
grep -Fq 'numTotalTests' "$T1"
grep -Fq 'port-forward' "$T1"
grep -Fq 'set +x' "$T1" "$PREFLIGHT" "$T2"

# T1 must restore the branch-profile GFS credentials on the way out with the
# same canonical script and NOLOGIN opt-in the GFS T1 gate uses, so a T1 run
# cannot leave gfsc-reader unready and fail the exact-head T2 preflight.
grep -Fq 'restore_gfs_runtime_credentials' "$T1"
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "$T1"
grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true' "$T1"
grep -Fq 'reconcile-gfs-deploy-credentials.sh' "$T1"
grep -Fq 'T1_GFS_RESTORE_REQUIRED=true' "$T1"
grep -Fq 'T2_UNREADY_DEPLOYMENTS' "$COMMON"

# pre-gate-sync GFS serving provisioning must opt into restoring a NOLOGIN
# role from the committed Secret DSN, and must run in every sync plan.
PRE_GATE="$MINIKUBE_DIR/pre-gate-sync.sh"
if ! sed -n '/^provision_gfs_serving()/,/^}/p' "$PRE_GATE" | grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true'; then
  echo 'FAIL: provision_gfs_serving does not restore a NOLOGIN GFS role from the committed Secret DSN' >&2
  exit 1
fi
if ! sed -n '/^provision_gfs_serving()/,/^}/p' "$PRE_GATE" | grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true'; then
  echo 'FAIL: provision_gfs_serving does not resume an interrupted gfsc-reader rollout claim' >&2
  exit 1
fi
if ! sed -n '/^provision_gfs_serving()/,/^}/p' "$PRE_GATE" | grep -Fq 'settle-gfs-reader-rollout.sh'; then
  echo 'FAIL: provision_gfs_serving does not settle a Ready gfsc-reader leftover rollout claim before reconcile' >&2
  exit 1
fi
if ! sed -n '/No cluster sync required before/,$p' "$PRE_GATE" | grep -Fq 'provision_gfs_serving'; then
  echo 'FAIL: pre-gate-sync skips GFS serving convergence when no cluster sync is required' >&2
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

if grep -Eq 'make minikube-pre-gate-sync|pre-gate-sync\.sh' "$PREFLIGHT"; then
  echo 'FAIL: preflight invokes pre-gate-sync' >&2
  exit 1
fi
grep -Fq 'full-bootstrap' "$PREFLIGHT" "$T2"
grep -Fq 'run_pre_gate' "$T2"
grep -Fq 'run_targeted_sync' "$T2"
grep -Fq 'full-reconcile' "$T2"
grep -Fq 'already-synced' "$T2" "$COMMON"
grep -Fq 'T2_SKIP_LOCK=true T2_PLAN_MODE=true T2_PLAN_FILE' "$T2"
grep -Fq 'T2_SKIP_LOCK=true T2_PLAN_MODE=false T2_PLAN_FILE' "$T2"
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
if ! grep -Fq 'instead of already-synced' "$T2"; then
  echo 'FAIL: final T2 preflight does not require already-synced' >&2
  exit 1
fi
if grep -Eq 'make minikube-pre-gate-sync GATE=minikube-t2$' "$T2"; then
  echo 'FAIL: orchestrator pre-gate-sync still starts port-forwards' >&2
  exit 1
fi

grep -Fq 'trap t2_lock_release EXIT INT TERM' "$COMMON"
grep -Fq 'T2_LOCK_ROOT' "$COMMON"
grep -Fq 'REPOSITORY=' "$COMMON"
grep -Fq 'BRANCH=' "$COMMON"
grep -Fq 'HEAD=' "$COMMON"
grep -Fq 'PROFILE=' "$COMMON"
grep -Fq 'CONTEXT=' "$COMMON"
grep -Fq 'LOCK_KEY=' "$COMMON"
grep -Fq 'PID=' "$COMMON"

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
' bash "$COMMON"
if [ -e "$tmp/locks/clerum-test-contract.lock" ]; then
  echo 'FAIL: lock was not cleaned after clean exit' >&2
  exit 1
fi

mkdir -p "$tmp/locks/busy-profile.lock"
cat >"$tmp/locks/busy-profile.lock/owner.env" <<EOF
PROFILE=busy-profile
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
bash "$ROOT/scripts/tests/test-minikube-settle-gfs-reader-rollout.sh"

printf 'PASS: local Minikube T0/T1/T2 contract checks\n'
