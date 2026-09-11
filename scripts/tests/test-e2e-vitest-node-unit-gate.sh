#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${ROOT_DIR}/scripts/e2e/run-vitest-e2e.sh"
WORKFLOW="${ROOT_DIR}/.github/workflows/ci-public.yml"

require_contains() {
  local file="$1"
  local needle="$2"
  local description="$3"
  if ! grep -Fq -- "${needle}" "${file}"; then
    echo "missing ${description}: ${needle}" >&2
    exit 1
  fi
}

require_contains "${RUNNER}" "DEFAULT_NODE_UNIT_VITEST_SUITES=(" \
  "node-unit suite registry"
require_contains "${RUNNER}" "gfsUploadV2Fixtures.test.ts" \
  "descriptor fixture suite registration"
require_contains "${RUNNER}" "E2E_VITEST_SUITE_GROUP" \
  "suite-group selector"
require_contains "${RUNNER}" "if [[ \"\${VITEST_SUITE_GROUP}\" == \"node-unit\" ]]" \
  "cluster-free node-unit execution path"
require_contains "${RUNNER}" "Vitest reported 'No test files found'" \
  "zero-file guard"
require_contains "${RUNNER}" "Vitest reported no executed tests" \
  "zero-test guard"
require_contains "${RUNNER}" "npx vitest run --no-color" \
  "color-free Vitest output for the zero-test guard"
require_contains "${WORKFLOW}" "E2E Vitest node-unit (tests/e2e)" \
  "public CI job"
require_contains "${WORKFLOW}" "node-version: '24'" \
  "Node 24 setup"
require_contains "${WORKFLOW}" "E2E_VITEST_SUITE_GROUP=node-unit bash scripts/e2e/run-vitest-e2e.sh" \
  "canonical runner invocation"

echo "E2E Vitest node-unit public gate contract OK"
