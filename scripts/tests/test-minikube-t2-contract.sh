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
  "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh" \
  "$ROOT/scripts/tests/test-minikube-t2-scenarios.sh"; do
  bash -n "$file"
done

required_codes="DEVELOPMENT_SCOPE_REQUIRED PROFILE_OWNERSHIP_MISMATCH PROFILE_BUSY HEAD_MARKER_MISMATCH IMAGE_MANIFEST_MISMATCH BOOTSTRAP_REQUIRED SECRET_MISSING CONFIGMAP_MISSING POSTGRES_NOT_READY REAL_PG_REQUIRED_BUT_UNAVAILABLE ZERO_TESTS_EXECUTED PORT_FORWARD_CONFLICT"
for code in $required_codes; do
  grep -Fq "$code" "$COMMON" "$PREFLIGHT" "$T2" "$T1"
done

grep -Fq 'kubectl --context=' "$COMMON"
grep -Fq 'CONTROL_API_REAL_PG_CONTEXT' "$T1"
grep -Fq 'CONTROL_API_REAL_PG_ADMIN_URL=' "$T1"
grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "$T1"
grep -Fq -- '--reporter=json' "$T1"
grep -Fq 'pending_tests' "$T1"
grep -Fq 'numTotalTests' "$T1"
grep -Fq 'port-forward' "$T1"
grep -Fq 'set +x' "$T1" "$PREFLIGHT" "$T2"

if grep -Eq 'make minikube-pre-gate-sync|pre-gate-sync\.sh' "$PREFLIGHT"; then
  echo 'FAIL: preflight invokes pre-gate-sync' >&2
  exit 1
fi
grep -Fq 'full-bootstrap' "$PREFLIGHT" "$T2"
grep -Fq 'run_pre_gate' "$T2"
grep -Fq 'run_targeted_sync' "$T2"
grep -Fq 'full-reconcile' "$T2"
grep -Fq 'REUSE_DB=true' "$T2"
grep -Fq 'T2_T0_STATUS=NOT_RUN' "$T2"
grep -Fq 'T2_T1_STATUS=NOT_RUN' "$T2"
grep -Fq "T2_T0_STATUS\" != PASS" "$T2"
grep -Fq "T2_T1_STATUS\" != PASS" "$T2"
grep -Fq 'T2_HEALTHCHECK_COMMAND' "$T2"

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
if grep -Fq 'ADMIN_DSN=' "$COMMON" "$PREFLIGHT"; then
  echo 'FAIL: preflight contains an admin DSN' >&2
  exit 1
fi

tmp="$(mktemp -d "$TMP_ROOT/evenfire-t2-contract.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
T2_LOCK_ROOT="$tmp/locks" MINIKUBE_PROFILE=clerum-test-contract T2_CONTEXT=clerum-test-contract \
T2_PROJECT_DIR="$ROOT" T2_BRANCH=codex/test T2_HEAD=0123456789abcdef \
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
  T2_PROJECT_DIR="$ROOT" T2_BRANCH=codex/test T2_HEAD=0123456789abcdef \
  T2_ORIGIN_DEV=0123456789abcdef T2_MERGE_BASE=0123456789abcdef \
  bash -c 'source "$1"; t2_lock_acquire' bash "$COMMON" 2>"$tmp/busy.err"; then
  echo 'FAIL: live profile owner was replaced' >&2
  exit 1
fi
grep -Fq 'PROFILE_BUSY' "$tmp/busy.err"

bash "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh"
bash "$ROOT/scripts/tests/test-minikube-t2-scenarios.sh"

printf 'PASS: local Minikube T0/T1/T2 contract checks\n'
