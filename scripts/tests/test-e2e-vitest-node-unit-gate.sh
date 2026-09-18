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

# A step name alone proves nothing: the registration is only useful when the
# step carries the mcp-host gate and runs after the build that produces the
# dist/ the fixture's SDK test imports. Both are asserted structurally so a
# future edit that moves or un-gates the step turns this contract red.
require_step_gate() {
  local file="$1"
  local step_name="$2"
  local gate="$3"
  local description="$4"
  if ! awk -v step="${step_name}" -v gate="${gate}" '
    $0 == "      - name: " step { inblock = 1; next }
    inblock && /^      - name: / { inblock = 0 }
    inblock && index($0, gate) { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "${file}"; then
    echo "missing ${description}" >&2
    exit 1
  fi
}

require_step_after() {
  local file="$1"
  local later_step="$2"
  local earlier_step="$3"
  local description="$4"
  if ! awk -v later="${later_step}" -v earlier="${earlier_step}" '
    { line[NR] = $0 }
    END {
      later_line = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] == "      - name: " later) { later_line = i; break }
      }
      if (later_line == 0) { printf("missing step: %s\n", later) > "/dev/stderr"; exit 1 }
      earlier_line = 0
      for (i = 1; i < later_line; i++) {
        if (line[i] == "      - name: " earlier) earlier_line = i
      }
      if (earlier_line == 0) {
        printf("step is not preceded by %s: %s\n", earlier, later) > "/dev/stderr"
        exit 1
      }
    }
  ' "${file}"; then
    echo "expected ${description}" >&2
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
require_contains "${WORKFLOW}" "Test image-capabilities fixtures and runner" \
  "image-capabilities public CI step"
require_contains "${WORKFLOW}" "scripts/e2e/image-capabilities-fixture.test.mjs" \
  "image-capabilities fixture registration"
require_contains "${WORKFLOW}" "tests/e2e/fixtures/image-capabilities/sdk.test.mjs" \
  "image-capabilities sdk registration"
require_contains "${WORKFLOW}" "tests/e2e/fixtures/image-capabilities/provider.test.mjs" \
  "image-capabilities provider registration"
require_step_gate "${WORKFLOW}" "Test image-capabilities fixtures and runner" \
  "matrix.service == 'mcp-host'" \
  "image-capabilities step mcp-host gate"
require_step_after "${WORKFLOW}" "Test image-capabilities fixtures and runner" "Build" \
  "image-capabilities step ordered after Build in the same job"

echo "E2E Vitest node-unit public gate contract OK"
