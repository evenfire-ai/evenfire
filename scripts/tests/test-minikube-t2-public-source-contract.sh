#!/usr/bin/env bash
# Hermetic public-source/capture classification; fixtures never touch the host checkout.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT/scripts/tests/lib/minikube-fixture-repo.sh"
fixture_tmp="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-public-source.XXXXXX")"
cleanup() {
  local status=$?
  minikube_test_assert_host_unchanged || status=1
  rm -rf -- "$fixture_tmp"
  exit "$status"
}
trap cleanup EXIT
minikube_test_fixture_repo_init "$ROOT" "$fixture_tmp"
repo="$MINIKUBE_TEST_PROJECT_DIR"
failures=0
cases=0
check_case() {
  local label="$1" expected="$2" code=0
  T2_PUBLIC_ROOT="$repo" T2_PUBLIC_BASE_REF=origin/dev \
    bash "$ROOT/scripts/tests/test-minikube-t2-public-boundary.sh" \
    >"$fixture_tmp/output" 2>&1 || code=$?
  cases=$((cases + 1))
  if [[ "$expected" == pass && "$code" != 0 ]] ||
     [[ "$expected" == reject && "$code" == 0 ]]; then
    printf 'FAIL: %s (exit %s)\n' "$label" "$code" >&2
    failures=$((failures + 1))
  fi
  rm -rf -- "$repo/tests"
}
mkdir -p "$repo/tests/e2e"
printf "import { test } from 'node:test'\ntest('public screenshots', () => {})\n" \
  >"$repo/tests/e2e/public-screenshot.spec.ts"
check_case 'public screenshot spec' pass
mkdir -p "$repo/tests/e2e"
printf "export default { name: 'public screenshot configuration' }\n" \
  >"$repo/tests/e2e/playwright-screenshot.config.ts"
check_case 'public screenshot config' pass
if [[ "${1:-}" != --source-only ]]; then
  mkdir -p "$repo/tests/e2e/screenshots"
  printf '\211PNG\r\n\032\n\000unit' >"$repo/tests/e2e/screenshots/private-capture.png"
  check_case 'private capture artifact' reject
  mkdir -p "$repo/tests/e2e"
  printf '\211PNG\r\n\032\n\000unit' >"$repo/tests/e2e/capture-screenshot.spec.ts"
  check_case 'binary disguised as source' reject
fi
if (( failures )); then
  printf 'PUBLIC_SOURCE_CONTRACT_FAIL: %s/%s\n' "$failures" "$cases" >&2
  exit 1
fi
printf 'PUBLIC_SOURCE_CONTRACT_PASS: %s cases\n' "$cases"
