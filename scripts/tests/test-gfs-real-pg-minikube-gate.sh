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
grep -Fq 'docker_cli_env_prepare false' "${SCRIPT}"
grep -Fq 'docker_cli_run_public gfs-t1-postgres-run' "${SCRIPT}"
grep -Fq 'docker run -d --rm' "${SCRIPT}"
grep -Fq 'ISOLATED_PG_IMAGE' "${SCRIPT}"
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
# The real-Postgres requirement must be a REGISTERED setup file, whatever else a
# package co-registers beside it. Matching the one-element array literal tied
# this contract to a formatting accident: a second, unrelated setup file in
# control-api broke the gate without touching the requirement it guards.
assert_setup_file_registered() {
  local config="$1" entry="$2" status
  awk -v entry="${entry}" '
    $0 ~ /^[[:space:]]*setupFiles:/ { collecting = 1 }
    collecting {
      block = block $0 "\n"
      if (index($0, "]")) { collecting = 0 }
    }
    END {
      if (block == "") { exit 2 }
      if (index(block, "\047" entry "\047") == 0 && index(block, "\"" entry "\"") == 0) {
        exit 3
      }
    }
  ' "${config}" || {
    status=$?
    if [ "${status}" -eq 2 ]; then
      echo "FAIL: ${config} declares no setupFiles array" >&2
    else
      echo "FAIL: ${config} does not register ${entry} as a setup file" >&2
    fi
    exit 1
  }
}

assert_setup_file_registered "${ROOT_DIR}/control-api/vitest.config.ts" \
  'test/realPostgres.requirement.ts'
assert_setup_file_registered "${ROOT_DIR}/gfs-controller/vitest.config.ts" \
  'test/realPostgres.requirement.ts'

printf 'PASS: Minikube real-Postgres runner is explicit, owned, and fail-loud\n'
