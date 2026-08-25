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
grep -Fq 'docker rm -f' "${SCRIPT}"
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
