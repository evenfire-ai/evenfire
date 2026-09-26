#!/usr/bin/env bash
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BENCHMARK_WRAPPER="${ROOT}/scripts/dev/autoresearch-benchmark.sh"
CHECKS_WRAPPER="${ROOT}/scripts/dev/autoresearch-checks.sh"
HOST_HEAD="$(git -C "${ROOT}" rev-parse HEAD)"
HOST_BRANCH="$(git -C "${ROOT}" branch --show-current)"
HOST_STATUS="$(git -C "${ROOT}" status --porcelain=v1)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-autoresearch-gates.XXXXXX")"

cleanup() {
  local status=$?
  rm -rf "${TMP_ROOT}"
  if [[ "$(git -C "${ROOT}" rev-parse HEAD)" != "${HOST_HEAD}" ||
        "$(git -C "${ROOT}" branch --show-current)" != "${HOST_BRANCH}" ||
        "$(git -C "${ROOT}" status --porcelain=v1)" != "${HOST_STATUS}" ]]; then
    echo 'FAIL: gate fixture changed host checkout'
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

FIXTURE="${TMP_ROOT}/fixture"
MARKER="${TMP_ROOT}/benchmark-ran"
mkdir -p "${FIXTURE}"
git init -q "${FIXTURE}"
git -C "${FIXTURE}" checkout -q -b test/autoresearch-gates
git -C "${FIXTURE}" config user.email "fixture@example.invalid"
git -C "${FIXTURE}" config user.name "Evenfire Fixture"
git -C "${FIXTURE}" commit --allow-empty -qm base
git -C "${FIXTURE}" commit --allow-empty -qm candidate
git -C "${FIXTURE}" checkout -q -b fixture-origin-dev
git -C "${FIXTURE}" commit --allow-empty -qm "origin dev ahead"
ORIGIN_DEV_HEAD="$(git -C "${FIXTURE}" rev-parse HEAD)"
git -C "${FIXTURE}" checkout -q test/autoresearch-gates
git -C "${FIXTURE}" update-ref refs/remotes/origin/dev "${ORIGIN_DEV_HEAD}"

OUTPUT="$(cd "${FIXTURE}" && bash "${BENCHMARK_WRAPPER}" -- bash -c "touch '${MARKER}'" 2>&1)"
STATUS=$?

if [[ "${STATUS}" -eq 2 ]]; then
  pass "stale origin/dev blocks the benchmark before execution"
else
  fail "stale origin/dev blocks the benchmark before execution"
  echo "${OUTPUT}"
fi

if [[ ! -e "${MARKER}" ]]; then
  pass "blocked benchmark command was not executed"
else
  fail "blocked benchmark command was not executed"
fi

if grep -Fq 'branch_missing_origin/dev_commits' <<<"${OUTPUT}"; then
  pass "stale-base blocker is preserved in gate output"
else
  fail "stale-base blocker is preserved in gate output"
  echo "${OUTPUT}"
fi

if ! grep -Fq 'AUTORESEARCH_GATE branch_freshness=pass' <<<"${OUTPUT}"; then
  pass "blocked freshness gate does not report success"
else
  fail "blocked freshness gate does not report success"
fi

git -C "${FIXTURE}" update-ref refs/remotes/origin/dev "$(git -C "${FIXTURE}" rev-parse HEAD)"
FRESH_OUTPUT="$(cd "${FIXTURE}" && bash "${BENCHMARK_WRAPPER}" -- bash -c "touch '${MARKER}'")"
FRESH_STATUS=$?

if [[ "${FRESH_STATUS}" -eq 0 ]]; then
  pass "fresh origin/dev allows the benchmark"
else
  fail "fresh origin/dev allows the benchmark"
  echo "${FRESH_OUTPUT}"
fi

if [[ -e "${MARKER}" ]]; then
  pass "benchmark arguments pass through after the freshness gate"
else
  fail "benchmark arguments pass through after the freshness gate"
fi

if grep -Fq 'AUTORESEARCH_GATE branch_freshness=pass' <<<"${FRESH_OUTPUT}"; then
  pass "freshness pass is explicit in gate output"
else
  fail "freshness pass is explicit in gate output"
  echo "${FRESH_OUTPUT}"
fi

mkdir -p "${FIXTURE}/scripts/dev" "${FIXTURE}/.github/workflows"
cp "${ROOT}/Makefile" "${FIXTURE}/Makefile"
cp "${ROOT}/scripts/dev/check-test-services.cjs" "${FIXTURE}/scripts/dev/check-test-services.cjs"
cp "${ROOT}/.github/workflows/ci-public.yml" "${FIXTURE}/.github/workflows/ci-public.yml"

CHECKS_OUTPUT="$(cd "${FIXTURE}" && bash "${CHECKS_WRAPPER}" 2>&1)"
CHECKS_STATUS=$?
if [[ "${CHECKS_STATUS}" -eq 0 ]] && grep -Fq 'AUTORESEARCH_GATE service_matrix_parity=pass' <<<"${CHECKS_OUTPUT}"; then
  pass "matching CI and Makefile service matrices pass"
else
  fail "matching CI and Makefile service matrices pass"
  echo "${CHECKS_OUTPUT}"
fi

sed 's/^          - channel-reader$/          - fixture-only/' \
  "${ROOT}/.github/workflows/ci-public.yml" >"${FIXTURE}/.github/workflows/ci-public.yml"
DRIFT_OUTPUT="$(cd "${FIXTURE}" && bash "${CHECKS_WRAPPER}" 2>&1)"
DRIFT_STATUS=$?
if [[ "${DRIFT_STATUS}" -ne 0 ]] && grep -Fq 'Test service drift:' <<<"${DRIFT_OUTPUT}"; then
  pass "service-matrix drift blocks the checks gate"
else
  fail "service-matrix drift blocks the checks gate"
  echo "${DRIFT_OUTPUT}"
fi

if ! grep -Fq 'AUTORESEARCH_GATE service_matrix_parity=pass' <<<"${DRIFT_OUTPUT}"; then
  pass "blocked service-matrix gate does not report success"
else
  fail "blocked service-matrix gate does not report success"
fi

exit "${FAIL}"
