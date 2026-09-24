#!/usr/bin/env bash
# Wave-1 oauth-broker extract T0 aggregator.
# Fails when a required suite is missing, executes zero tests, reports
# skipped/todo cases, or exits non-zero.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
GROUPS_RUN=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

require_file() {
  local rel="$1"
  if [[ ! -f "${ROOT}/${rel}" ]]; then
    fail "missing required suite ${rel}"
    return 1
  fi
  return 0
}

strip_ansi() {
  sed $'s/\033\\[[0-9;]*m//g'
}

assert_executed_counts() {
  local name="$1"
  local log="$2"
  local normalized
  normalized="$(mktemp)"
  strip_ansi <"$log" >"$normalized"

  local vitest_passed
  vitest_passed="$(
    grep -Eo 'Tests[[:space:]]+[1-9][0-9]* passed' "$normalized" | head -n 1 || true
  )"
  local node_pass
  node_pass="$(
    grep -E 'pass[[:space:]]+[1-9][0-9]*$' "$normalized" | awk '{print $NF}' | tail -n 1 || true
  )"

  if [[ -z "${vitest_passed}" && -z "${node_pass}" ]]; then
    fail "${name}: executed zero passing tests"
    echo "----- ${name} reporter -----"
    cat "$normalized"
    rm -f "$normalized"
    return 1
  fi

  if grep -Eq '(Test Files|Tests).*[1-9][0-9]* skipped' "$normalized"; then
    fail "${name}: Vitest reported skipped tests"
    rm -f "$normalized"
    return 1
  fi
  if grep -Eq '(Test Files|Tests).*[1-9][0-9]* todo' "$normalized"; then
    fail "${name}: Vitest reported todo tests"
    rm -f "$normalized"
    return 1
  fi
  if grep -Eq '^(#|ℹ) skipped[[:space:]]+[1-9]' "$normalized"; then
    fail "${name}: node:test reported skipped tests"
    rm -f "$normalized"
    return 1
  fi
  if grep -Eq '^(#|ℹ) todo[[:space:]]+[1-9]' "$normalized"; then
    fail "${name}: node:test reported todo tests"
    rm -f "$normalized"
    return 1
  fi
  if grep -Eiq 'no test files|no tests found' "$normalized"; then
    fail "${name}: reporter found no tests"
    rm -f "$normalized"
    return 1
  fi

  rm -f "$normalized"
  return 0
}

run_group() {
  local name="$1"
  local prefix="$2"
  shift 2
  local files=("$@")
  local rel
  if [[ "${#files[@]}" -eq 0 ]]; then
    fail "${name}: group listed no suite files"
    return 1
  fi
  for rel in "${files[@]}"; do
    require_file "${prefix}/${rel}" || return 1
  done

  local log
  log="$(mktemp)"
  local npm_args=(--prefix "${ROOT}/${prefix}" test --)
  npm_args+=("${files[@]}")

  echo "── ${name} ──"
  if ! (
    cd "${ROOT}"
    FORCE_COLOR=0 NO_COLOR=1 npm "${npm_args[@]}"
  ) >"$log" 2>&1; then
    fail "${name}: command failed"
    cat "$log"
    rm -f "$log"
    return 1
  fi

  if ! assert_executed_counts "$name" "$log"; then
    rm -f "$log"
    return 1
  fi

  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "${name}"
  rm -f "$log"
}

require_ci_matrix_entry() {
  local entry="$1"
  if ! grep -Eq "^[[:space:]]+- ${entry}$" "${ROOT}/.github/workflows/ci-public.yml"; then
    fail "ci-public.yml matrix is missing ${entry}"
    return 1
  fi
  pass "ci-public.yml matrix includes ${entry}"
}

echo "LLM subscription extract T0 aggregator"

require_ci_matrix_entry "packages/llm-providers"

run_group "llm-providers" "packages/llm-providers" "index.test.cjs"

run_group "control-api-extract" "control-api" \
  "test/subscriptionGrantIdentity.test.ts" \
  "test/hostSpecValidation.oauthBrokerExtract.test.ts" \
  "test/routes.mcp-host.llmProviderAttempts.attestation.test.ts" \
  "test/routes.admin.codexSubscription.oauthBrokerExtract.test.ts" \
  "test/services.codexSubscriptionOAuth.test.ts"

run_group "mcp-host-extract" "mcp-host" \
  "src/pluginWorkloadSdk/bootstrapIdentity.oauthBrokerExtract.test.ts"

echo "── deploy-contract ──"
require_file "scripts/tests/test-codex-llm-proxy-deploy-contract.sh" || true
if bash "${ROOT}/scripts/tests/test-codex-llm-proxy-deploy-contract.sh"; then
  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "deploy-contract"
else
  fail "deploy-contract"
fi

if [[ "${GROUPS_RUN}" -ne 4 ]]; then
  fail "expected 4 T0 groups, ran ${GROUPS_RUN}"
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "LLM subscription extract T0 FAILED"
  exit 1
fi
echo "LLM subscription extract T0 passed (${GROUPS_RUN} groups)"
