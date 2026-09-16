#!/usr/bin/env bash
# Wave-2 Grok subscription T0 aggregator.
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
  shift
  GROUPS_RUN=$((GROUPS_RUN + 1))
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    if assert_executed_counts "$name" "$log"; then
      pass "$name"
    fi
  else
    fail "$name"
    echo "----- ${name} -----"
    cat "$log"
  fi
  rm -f "$log"
}

require_file packages/grok-provider-attempt-contract/index.test.cjs
require_file grok-llm-proxy/test/contractFreeze.test.ts
require_file grok-llm-proxy/test/originPolicy.test.ts
require_file control-api/test/services.grokSubscriptionOAuth.test.ts
require_file control-api/test/services.grokProviderAttemptRedemption.test.ts
require_file control-api/test/db.grokSubscriptionMigration.test.ts
require_file scripts/tests/test-grok-llm-proxy-deploy-contract.sh
require_file tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json

run_group "grok-provider-attempt-contract" \
  bash -lc "cd '${ROOT}/packages/grok-provider-attempt-contract' && node --test index.test.cjs"

run_group "grok-llm-proxy freeze+origin" \
  bash -lc "cd '${ROOT}/grok-llm-proxy' && npx vitest run test/contractFreeze.test.ts test/originPolicy.test.ts --no-file-parallelism"

run_group "control-api grok grant/oauth/redeem" \
  bash -lc "cd '${ROOT}/control-api' && npx vitest run test/db.grokSubscriptionMigration.test.ts test/services.grokSubscriptionConnection.test.ts test/services.grokSubscriptionOAuth.test.ts test/services.grokSubscriptionCatalog.test.ts test/services.grokProviderAttemptRedemption.test.ts --no-file-parallelism"

if ! bash "${ROOT}/scripts/tests/test-grok-llm-proxy-deploy-contract.sh"; then
  fail "grok-llm-proxy deploy contract"
else
  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "grok-llm-proxy deploy contract"
fi

if [[ "$GROUPS_RUN" -lt 4 ]]; then
  fail "T0 ran too few groups (${GROUPS_RUN})"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "FAIL: grok subscription T0"
  exit 1
fi
echo "PASS: grok subscription T0 (${GROUPS_RUN} groups)"
exit 0
