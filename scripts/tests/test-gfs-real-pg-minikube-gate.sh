#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${ROOT_DIR}/scripts/e2e/gfs-real-pg-minikube-gate.sh"

bash -n "${SCRIPT}"
grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "${SCRIPT}"
grep -Fq 'CONTROL_API_REAL_PG_ADMIN_URL=' "${SCRIPT}"
grep -Fq 'gitHead' "${SCRIPT}"
grep -Fq 'worktreeId' "${SCRIPT}"
grep -Fq 'port-forward' "${SCRIPT}"
grep -Fq 'pending_files' "${SCRIPT}"
grep -Fq -- '--reporter=json' "${SCRIPT}"
grep -Fq "gfs*.realPostgres.integration.test.ts" "${SCRIPT}"
grep -Fq "services.rateLimiter.realPostgres.integration.test.ts" "${SCRIPT}"
grep -Fq 'isolated processes' "${SCRIPT}"
grep -Fq 'gke_*)' "${SCRIPT}"
grep -Fq '*prod*)' "${SCRIPT}"
grep -Fq 'test-gfs-real-postgres-minikube' "${ROOT_DIR}/Makefile"
grep -Fq "setupFiles: ['test/realPostgres.requirement.ts']" "${ROOT_DIR}/control-api/vitest.config.ts"
grep -Fq 'setupFiles: ["test/realPostgres.requirement.ts"]' "${ROOT_DIR}/gfs-controller/vitest.config.ts"

printf 'PASS: Minikube real-Postgres runner is explicit, owned, and fail-loud\n'
