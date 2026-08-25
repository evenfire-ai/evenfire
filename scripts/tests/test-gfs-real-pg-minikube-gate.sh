#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${ROOT_DIR}/scripts/e2e/gfs-real-pg-minikube-gate.sh"

bash -n "${SCRIPT}"
grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "${SCRIPT}"
grep -Fq 'CONTROL_API_REAL_PG_ADMIN_URL=' "${SCRIPT}"
grep -Fq 'verify_branch_gate' "${SCRIPT}"
grep -Fq 't2_profile_scope' "${SCRIPT}"
grep -Fq 't2_profile_context_identity_check' "${SCRIPT}"
grep -Fq 't2_marker_check' "${SCRIPT}"
grep -Fq 't2_mutation_lock' "${SCRIPT}"
grep -Fq 'rollout status deployment/control-postgres' "${SCRIPT}"
grep -Fq 'get secret control-postgres' "${SCRIPT}"
grep -Fq 'PROFILE_PG_FORWARD_RECORD' "${SCRIPT}"
grep -Fq 'pf_owner_record_process "${PROFILE_PG_FORWARD_RECORD}"' "${SCRIPT}"
grep -Fq 'pf_owner_cleanup_record "${PROFILE_PG_FORWARD_RECORD}"' "${SCRIPT}"
grep -Fq 'docker_cli_env_prepare probe' "${SCRIPT}"
grep -Fq 'docker_cli_run_public gfs-t1-postgres-run' "${SCRIPT}"
grep -Fq 'docker run -d --rm' "${SCRIPT}"
grep -Fq 'ISOLATED_PG_IMAGE' "${SCRIPT}"
grep -Fq -- '-p "127.0.0.1::5432"' "${SCRIPT}"
python3 - "${SCRIPT}" <<'PY'
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text().splitlines()
port_call = next(
    index
    for index, line in enumerate(lines)
    if "docker_cli_run_public gfs-t1-postgres-port" in line
)
assert '${MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS}' in lines[port_call + 1]
assert 'docker port "${ISOLATED_CONTAINER}" 5432/tcp' in lines[port_call + 2]
assert all("GFS_DOCKER_INFO_TIMEOUT_SECONDS" not in line for line in lines)
PY
if grep -Fq -- '-p "127.0.0.1:${ISOLATED_PORT}:5432"' "${SCRIPT}"; then
  echo 'FAIL: isolated GFS PostgreSQL still has a choose-then-bind port race' >&2
  exit 1
fi
grep -Fq 'pending_files' "${SCRIPT}"
grep -Fq -- '--reporter=json' "${SCRIPT}"
grep -Fq "gfs*.realPostgres.integration.test.ts" "${SCRIPT}"
grep -Fq "services.rateLimiter.realPostgres.integration.test.ts" "${SCRIPT}"
grep -Fq 'isolated processes' "${SCRIPT}"
grep -Fq 'restore_gfs_runtime_credentials' "${SCRIPT}"
grep -Fq 'required gfs-controller-db Secret is missing or unreadable' "${SCRIPT}"
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "${SCRIPT}"
grep -Fq 'failed to restore branch-profile GFS credentials' "${SCRIPT}"
grep -Fq 'local status="${1:-$?}"' "${SCRIPT}"
grep -Fq "trap 'handle_gfs_gate_signal INT' INT" "${SCRIPT}"
grep -Fq "trap 'handle_gfs_gate_signal TERM' TERM" "${SCRIPT}"
grep -Fq "trap '' INT TERM" "${SCRIPT}"
grep -Fq 'docker rm -f' "${SCRIPT}"

cleanup_contract="$(sed -n "/^cleanup() {\$/,/^trap 'handle_gfs_gate_signal TERM' TERM\$/p" "${SCRIPT}")"
for signal_case in EXIT:0 INT:130 TERM:143; do
  action="${signal_case%%:*}"
  expected_status="${signal_case##*:}"
  fixture="$(mktemp -d)"
  mkdir -p "${fixture}/gfs-tmp"
  set +e
  GFS_SIGNAL_EVENTS="${fixture}/events" GFS_SIGNAL_TMP_DIR="${fixture}/gfs-tmp" \
    bash -c '
      contract="$1"
      action="$2"
      TMP_DIR="$GFS_SIGNAL_TMP_DIR"
      GFS_RESTORE_REQUIRED=true
      stop_profile_postgres_forward() { printf "stop-profile-forward\n" >>"$GFS_SIGNAL_EVENTS"; }
      stop_isolated_postgres() { printf "stop-isolated-postgres\n" >>"$GFS_SIGNAL_EVENTS"; }
      cleanup_gfs_docker_env() { printf "docker-cleanup\n" >>"$GFS_SIGNAL_EVENTS"; }
      restore_gfs_runtime_credentials() { printf "restore-gfs\n" >>"$GFS_SIGNAL_EVENTS"; }
      t2_lock_release() { printf "lock-release:%s\n" "$1" >>"$GFS_SIGNAL_EVENTS"; return "$1"; }
      eval "$contract"
      if [ "$action" = EXIT ]; then
        exit 0
      fi
      kill "-${action}" "$$"
      printf "signal handler returned unexpectedly\n" >>"$GFS_SIGNAL_EVENTS"
    ' bash "$cleanup_contract" "$action" >/dev/null 2>&1
  signal_status=$?
  set -e
  if [ "$signal_status" -ne "$expected_status" ]; then
    echo "FAIL: GFS ${action} cleanup returned ${signal_status}, expected ${expected_status}" >&2
    exit 1
  fi
  expected_events=$'stop-profile-forward\nstop-isolated-postgres\ndocker-cleanup\nrestore-gfs\nlock-release:0'
  actual_events="$(cat "${fixture}/events")"
  if [ "$actual_events" != "$expected_events" ] || [ -d "${fixture}/gfs-tmp" ]; then
    echo "FAIL: GFS ${action} cleanup did not run each safety step exactly once: ${actual_events}" >&2
    exit 1
  fi
  rm -rf "${fixture}"
done

awk '
  /^[[:space:]]*docker (run|exec|rm) / {
    if (previous !~ /docker_cli_run_public/ && before_previous !~ /docker_cli_run_public/) {
      exit 1
    }
  }
  { before_previous = previous; previous = $0 }
' "${SCRIPT}" || {
  echo 'FAIL: standalone GFS lane still runs ambient or unbounded Docker commands' >&2
  exit 1
}
if grep -Fq 'docker rm -f "${ISOLATED_CONTAINER}" >/dev/null 2>&1 || true' "${SCRIPT}"; then
  echo 'FAIL: standalone GFS cleanup suppresses Docker removal failure' >&2
  exit 1
fi
grep -Fq 'test-gfs-real-postgres-minikube' "${ROOT_DIR}/Makefile"
grep -Fq "setupFiles: ['test/realPostgres.requirement.ts']" "${ROOT_DIR}/control-api/vitest.config.ts"
grep -Fq 'setupFiles: ["test/realPostgres.requirement.ts"]' "${ROOT_DIR}/gfs-controller/vitest.config.ts"

printf 'PASS: Minikube real-Postgres runner is explicit, owned, and fail-loud\n'
