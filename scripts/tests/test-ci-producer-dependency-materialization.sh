#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT_DIR}/scripts/ci/install-test-producer-dependencies.sh"
WORKFLOW="${ROOT_DIR}/.github/workflows/ci-public.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_packages() {
  local service="$1"
  shift
  local actual
  local expected
  actual="$(CI_TEST_PRODUCER_INSTALL_DRY_RUN=1 bash "${INSTALLER}" "${service}")"
  expected="$(printf '%s\n' "$@" | sort)"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'FAIL: %s producer dependencies\nexpected:\n%s\nactual:\n%s\n' \
      "${service}" "${expected}" "${actual}" >&2
    exit 1
  }
}

[[ -f "${INSTALLER}" ]] || fail 'CI lacks the producer dependency installer'

grep -Fq \
  'bash scripts/ci/install-test-producer-dependencies.sh "${{ matrix.service }}"' \
  "${WORKFLOW}" || fail 'ordinary service CI does not install discovered producer dependencies'
grep -Fq \
  'bash scripts/ci/install-test-producer-dependencies.sh control-api' \
  "${WORKFLOW}" || fail 'real PostgreSQL CI does not install discovered producer dependencies'

assert_packages rpc-proxy control-api
assert_packages workflow-recipes control-api rpc-proxy
assert_packages external-rest-api control-api rpc-proxy
assert_packages mcp-host control-api rpc-proxy
assert_packages control-api workflow-recipes
assert_packages packages/action-context-contracts
assert_packages control-ui
assert_packages desktop-app

echo 'PASS: CI materializes producer dependencies derived from producer-backed tests'
