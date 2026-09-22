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

# A file name elsewhere in the runner (a comment, the cluster list) does not
# run it in this group; the entry must sit inside the node-unit array.
require_node_unit_suite() {
  local suite="$1"
  local description="$2"
  if ! awk -v suite="${suite}" '
    $0 == "DEFAULT_NODE_UNIT_VITEST_SUITES=(" { inarray = 1; next }
    inarray && $0 == ")" { inarray = 0 }
    inarray && $0 == "  " suite { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "${RUNNER}"; then
    echo "missing ${description}: ${suite}" >&2
    exit 1
  fi
}

# Vitest strips types without checking them, so the node-unit suites are only
# type-checked through tsconfig.node-unit.json. Its files must be exactly the
# suites the runner executes: a suite in one list and not the other either runs
# unchecked or is checked and never run.
require_node_unit_typecheck_matches_runner() {
  local tsconfig="${ROOT_DIR}/tests/e2e/tsconfig.node-unit.json"
  if [[ ! -f "${tsconfig}" ]]; then
    echo "missing node-unit typecheck config: ${tsconfig}" >&2
    exit 1
  fi
  local runner_suites tsconfig_suites
  runner_suites="$(awk '
    $0 == "DEFAULT_NODE_UNIT_VITEST_SUITES=(" { inarray = 1; next }
    inarray && $0 == ")" { inarray = 0 }
    inarray && $0 !~ /^ *#/ && NF { gsub(/^ +| +$/, ""); print }
  ' "${RUNNER}" | sort)"
  tsconfig_suites="$(awk '
    /"files": \[/ { inarray = 1; next }
    inarray && /\]/ { inarray = 0 }
    inarray { gsub(/[ ",]/, ""); if (length($0)) print }
  ' "${tsconfig}" | sort)"
  if [[ -z "${runner_suites}" ]]; then
    echo "no node-unit suites found in ${RUNNER}" >&2
    exit 1
  fi
  if [[ "${runner_suites}" != "${tsconfig_suites}" ]]; then
    printf 'tsconfig.node-unit.json files differ from DEFAULT_NODE_UNIT_VITEST_SUITES\nrunner:\n%s\ntsconfig:\n%s\n' \
      "${runner_suites}" "${tsconfig_suites}" >&2
    exit 1
  fi
}

# The typecheck must sit in the node-unit branch and run before the suites, so
# a type error stops the job even when every test would pass.
require_node_unit_typecheck_before_suites() {
  if ! awk '
    $0 == "if [[ \"${VITEST_SUITE_GROUP}\" == \"node-unit\" ]]; then" { inblock = 1; next }
    inblock && $0 == "fi" { inblock = 0 }
    inblock && index($0, "npm run typecheck:node-unit") { typecheck = NR }
    inblock && index($0, "run_selected_vitest_suites") { suites = NR }
    END { exit(typecheck && suites && typecheck < suites ? 0 : 1) }
  ' "${RUNNER}"; then
    echo "missing node-unit typecheck before run_selected_vitest_suites in ${RUNNER}" >&2
    exit 1
  fi
}

require_contains "${RUNNER}" "DEFAULT_NODE_UNIT_VITEST_SUITES=(" \
  "node-unit suite registry"
require_contains "${ROOT_DIR}/tests/e2e/package.json" \
  '"typecheck:node-unit": "tsc -p tsconfig.node-unit.json"' \
  "node-unit typecheck script"
require_node_unit_typecheck_matches_runner
require_node_unit_typecheck_before_suites
require_contains "${RUNNER}" "gfsUploadV2Fixtures.test.ts" \
  "descriptor fixture suite registration"
require_node_unit_suite "integration/codex-subscription-contract-freeze.test.ts" \
  "Codex subscription contract freeze node-unit registration"
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
require_contains "${RUNNER}" 'bash "${SCRIPT_DIR}/ensure-e2e-deps.sh" tests/e2e' \
  "runner dependency install through the lockfile-aware helper"
require_contains "${ROOT_DIR}/Makefile" "bash scripts/e2e/ensure-e2e-deps.sh tests/e2e" \
  "test-e2e-deps install through the lockfile-aware helper"

# Behaviour of the install helper against a fake npm that records each call and
# lays down node_modules/.bin/vitest the way `npm ci` would.
check_ensure_e2e_deps() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN
  mkdir -p "${tmp}/bin" "${tmp}/e2e"
  cat > "${tmp}/bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
echo "npm $*" >> "${FAKE_NPM_LOG}"
[[ "${FAKE_NPM_FAIL:-0}" == "1" ]] && exit 7
rm -rf node_modules
mkdir -p node_modules/.bin
printf '#!/bin/sh\n' > node_modules/.bin/vitest
chmod +x node_modules/.bin/vitest
FAKE_NPM
  chmod +x "${tmp}/bin/npm"
  echo '{"lockfileVersion":3,"v":1}' > "${tmp}/e2e/package-lock.json"

  local helper="${ROOT_DIR}/scripts/e2e/ensure-e2e-deps.sh"
  local log="${tmp}/npm.log"
  run_helper() { PATH="${tmp}/bin:${PATH}" FAKE_NPM_LOG="${log}" bash "${helper}" "${tmp}/e2e" > /dev/null; }
  npm_calls() { if [[ -f "${log}" ]]; then wc -l < "${log}" | tr -d ' '; else echo 0; fi; }

  run_helper
  [[ "$(npm_calls)" == "1" ]] || { echo "ensure-e2e-deps: fresh tree did not run npm ci" >&2; exit 1; }
  grep -Fxq "npm ci --no-audit --no-fund" "${log}" || { echo "ensure-e2e-deps: unexpected npm invocation" >&2; exit 1; }

  run_helper
  [[ "$(npm_calls)" == "1" ]] || { echo "ensure-e2e-deps: unchanged lockfile reinstalled" >&2; exit 1; }

  echo '{"lockfileVersion":3,"v":2}' > "${tmp}/e2e/package-lock.json"
  run_helper
  [[ "$(npm_calls)" == "2" ]] || { echo "ensure-e2e-deps: changed lockfile did not reinstall" >&2; exit 1; }

  # A failed install must fail the helper and leave no record of success.
  echo '{"lockfileVersion":3,"v":3}' > "${tmp}/e2e/package-lock.json"
  if PATH="${tmp}/bin:${PATH}" FAKE_NPM_LOG="${log}" FAKE_NPM_FAIL=1 bash "${helper}" "${tmp}/e2e" > /dev/null 2>&1; then
    echo "ensure-e2e-deps: a failed npm ci was reported as success" >&2
    exit 1
  fi
  [[ "$(npm_calls)" == "3" ]] || { echo "ensure-e2e-deps: failing install was not attempted" >&2; exit 1; }
  run_helper
  [[ "$(npm_calls)" == "4" ]] || { echo "ensure-e2e-deps: install after a failed one was skipped" >&2; exit 1; }
}
check_ensure_e2e_deps

echo "E2E Vitest node-unit public gate contract OK"
