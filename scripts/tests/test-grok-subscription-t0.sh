#!/usr/bin/env bash
# Wave-2 Grok subscription T0 aggregator.
#
# Fails when a required suite is missing, executes zero tests, reports
# skipped/todo cases, runs fewer Vitest files than listed, or exits non-zero.
# Exit 0 alone is never enough: the script parses machine-readable counts from
# Vitest or node:test. Every listed suite is guarded by require_file before its
# group runs, because `vitest run <present> <missing>` still exits 0.
#
# Lane separation: Codex-only suites live in test-codex-subscription-t0.sh.
# Real-Postgres suites need CONTROL_API_REAL_PG_ADMIN_URL and run in the CI
# real-PG lane; this script checks they exist and that the lane lists them.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
GROUPS_RUN=0
EXPECTED_GROUPS=10
REGISTERED=()
COUNT_SUMMARY=""

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

# Return 0 when the captured reporter proves at least one passing test, zero
# skipped/todo cases and, for Vitest, exactly the expected number of files.
# Sets COUNT_SUMMARY on success.
assert_executed_counts() {
  local name="$1"
  local log="$2"
  local expected_files="$3"
  local normalized
  normalized="$(mktemp)"
  strip_ansi <"$log" >"$normalized"

  local vitest_passed
  vitest_passed="$(
    grep -Eo 'Tests[[:space:]]+[1-9][0-9]* passed' "$normalized" | head -n 1 | awk '{print $2}' || true
  )"
  local vitest_files
  vitest_files="$(
    grep -Eo 'Test Files[[:space:]]+[0-9]+ passed' "$normalized" | head -n 1 | awk '{print $3}' || true
  )"
  local node_tests
  node_tests="$(
    grep -E '^(#|ℹ) tests[[:space:]]+[0-9]+$' "$normalized" | awk '{print $NF}' | tail -n 1 || true
  )"
  local node_pass
  node_pass="$(
    grep -E '^(#|ℹ) pass[[:space:]]+[1-9][0-9]*$' "$normalized" | awk '{print $NF}' | tail -n 1 || true
  )"

  if [[ -z "${vitest_passed}" && -z "${node_pass}" ]]; then
    fail "${name}: executed zero passing tests"
    echo "----- ${name} reporter -----"
    cat "$normalized"
    rm -f "$normalized"
    return 1
  fi

  if [[ -n "${node_pass}" && "${node_tests}" != "${node_pass}" ]]; then
    fail "${name}: node:test pass count ${node_pass} does not match tests ${node_tests:-missing}"
    rm -f "$normalized"
    return 1
  fi

  if [[ -n "${vitest_passed}" && "${vitest_files}" != "${expected_files}" ]]; then
    fail "${name}: Vitest passed ${vitest_files:-0} test files, expected ${expected_files}"
    grep -E 'Test Files|No test files found' "$normalized" || true
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

  if [[ -n "${vitest_passed}" ]]; then
    COUNT_SUMMARY="${vitest_files} files, ${vitest_passed} tests"
  else
    COUNT_SUMMARY="${node_pass}/${node_tests} node:test tests"
  fi
  rm -f "$normalized"
  return 0
}

# run_group <name> <package dir> <suite files relative to the package...>
# Runs the package's own `npm test -- <files>`; the grok-llm-proxy test script
# runs its test typecheck before Vitest.
run_group() {
  local name="$1"
  local prefix="$2"
  shift 2
  if [[ "$#" -eq 0 ]]; then
    fail "${name}: group listed no suite files"
    return 1
  fi
  local files=("$@")
  local rel
  for rel in "${files[@]}"; do
    REGISTERED+=("${prefix}/${rel}")
  done
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

  COUNT_SUMMARY=""
  if ! assert_executed_counts "$name" "$log" "${#files[@]}"; then
    rm -f "$log"
    return 1
  fi

  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "${name} (${COUNT_SUMMARY})"
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

# Real-Postgres suites are env-gated (skipped without a real PG), so T0 only
# proves they exist and that the CI real-PG lane asserts each one ran.
require_real_pg_suite() {
  local rel="$1"
  REGISTERED+=("${rel}")
  require_file "${rel}" || return 1
  local suite
  suite="$(basename "${rel}" .test.ts)"
  if ! sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*\\$//' "${ROOT}/.github/workflows/ci-public.yml" |
    grep -Fxq "${suite}"; then
    fail "ci-public.yml real-PG lane does not list ${suite}"
    return 1
  fi
  pass "real-PG suite present and listed in CI: ${suite}"
}

echo "Grok subscription T0 aggregator"

require_ci_matrix_entry "grok-llm-proxy"
require_ci_matrix_entry "packages/grok-provider-attempt-contract"

oauth_source="${ROOT}/control-api/src/services/grokSubscriptionOAuth.ts"
expected_device_url='https://auth.x.ai/oauth2/device/code'
expected_token_url='https://auth.x.ai/oauth2/token'
expected_revoke_url='https://auth.x.ai/oauth2/revoke'
expected_client_id='b1a00492-073a-47ea-816f-4c329264a828'
api_device_url="$(sed -n "s/^export const GROK_OAUTH_DEVICE_URL = '\\(.*\\)'$/\\1/p" "${oauth_source}")"
api_token_url="$(sed -n "s/^export const GROK_OAUTH_TOKEN_URL = '\\(.*\\)'$/\\1/p" "${oauth_source}")"
api_revoke_url="$(sed -n "s/^export const GROK_OAUTH_REVOKE_URL = '\\(.*\\)'$/\\1/p" "${oauth_source}")"
api_client_id="$(
  sed -n "s/.*CONTROL_API_GROK_OAUTH_CLIENT_ID || '\\(.*\\)',$/\\1/p" \
    "${ROOT}/control-api/src/config.ts"
)"
if [[ "${api_device_url}" == "${expected_device_url}" &&
      "${api_token_url}" == "${expected_token_url}" &&
      "${api_revoke_url}" == "${expected_revoke_url}" &&
      "${api_client_id}" == "${expected_client_id}" ]]; then
  pass "Grok OAuth origin/client lock"
else
  fail "Grok OAuth origin/client lock (device=${api_device_url:-missing} token=${api_token_url:-missing} revoke=${api_revoke_url:-missing} client=${api_client_id:-missing})"
fi

run_group "grok-provider-attempt-contract" "packages/grok-provider-attempt-contract" \
  "index.test.cjs"

run_group "llm-providers image gate" "packages/llm-providers" \
  "index.test.cjs"

# Shared projection package; its suite covers the Grok ConfigMap annotations.
run_group "grok-catalog-projection" "packages/codex-catalog-projection" \
  "index.test.cjs"

# Every proxy suite, including the hermetic runtime e2e. The unlisted-suite
# check below fails when a proxy test file is added without being listed here.
run_group "grok-llm-proxy" "grok-llm-proxy" \
  "test/abortWhenClientDisconnects.test.ts" \
  "test/approvedToolsUpstream.test.ts" \
  "test/catalogBounds.test.ts" \
  "test/contractFreeze.test.ts" \
  "test/controlApiClient.test.ts" \
  "test/grokTransport.conformance.test.ts" \
  "test/grokUpstreamHeaders.test.ts" \
  "test/originPolicy.test.ts" \
  "test/redaction.test.ts" \
  "test/requestLimits.test.ts" \
  "test/runtimePath.hermetic.e2e.test.ts" \
  "test/server.security.test.ts" \
  "test/sseBackpressure.test.ts" \
  "test/toolNameMap.test.ts"

run_group "control-api grok" "control-api" \
  "test/db.grokSubscriptionMigration.test.ts" \
  "test/db.llmProviderAttemptMigration.test.ts" \
  "test/services.grokSubscriptionConnection.test.ts" \
  "test/services.grokSubscriptionOAuth.test.ts" \
  "test/services.grokSubscriptionCatalog.test.ts" \
  "test/services.subscriptionCatalogBounds.test.ts" \
  "test/services.grokProviderAttemptTicket.test.ts" \
  "test/services.grokProviderAttemptRedemption.test.ts" \
  "test/services.llmProviderAttemptAuthorizer.grok.test.ts" \
  "test/services.llmProviderAttemptAuthorizer.depth.test.ts" \
  "test/services.llmProviderAttemptFinalization.test.ts" \
  "test/services.usageEvents.test.ts" \
  "test/services.recipeGrantTransition.test.ts" \
  "test/services.recipeCodexGrantIdentity.test.ts" \
  "test/subscriptionGrantIdentity.test.ts" \
  "test/llmProviders.test.ts" \
  "test/routes.admin.grokSubscription.test.ts" \
  "test/routes.internal.llmProviderAttempts.grok.test.ts" \
  "test/routes.adminPluginWorkloadSdk.test.ts" \
  "test/routes.adminRecipes.test.ts" \
  "test/routes.mcp-host.plugin-workload-sdk.test.ts" \
  "test/hostSpecValidation.grokSubscription.test.ts" \
  "test/hostSpecValidation.limits.test.ts" \
  "test/crd.hostCel.test.ts" \
  "test/crd.llmProviderEnums.test.ts"

require_real_pg_suite "control-api/test/services.grokSubscriptionConnection.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.grokProviderAttemptRedemption.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.grokProviderAttemptRedemption.refresh.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/pluginWorkloadSdkGrokDualLedger.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/db.llmProviderAttemptConnectionIntegrity.realPostgres.integration.test.ts"

run_group "mcp-host grok" "mcp-host" \
  "src/llm/__tests__/grokSubscription.test.ts" \
  "src/llm/__tests__/grokLlmProxyClient.test.ts" \
  "src/llm/__tests__/grokPolicyBinding.test.ts" \
  "src/llm/__tests__/subscriptionRequestHash.test.ts" \
  "src/llm/__tests__/registry.test.ts" \
  "src/llm/__tests__/makeProvider.throws.test.ts" \
  "src/agent/__tests__/taskExecutor.test.ts" \
  "src/config/configStore.test.ts" \
  "src/core/orchestration/__tests__/toolPresentationPolicy.test.ts" \
  "src/pluginWorkloadSdk/bootstrapIdentity.test.ts" \
  "src/pluginWorkloadSdk/bootstrapServer.test.ts" \
  "src/pluginWorkloadSdk/promptBridge/controlApiClient.test.ts" \
  "src/pluginWorkloadSdk/promptBridge/llmBridge.failover.test.ts"

run_group "workflow-recipes grok" "workflow-recipes" \
  "src/workflow/codexRecipeVerdict.test.ts" \
  "src/workflow/sdkOnlyGrokBinding.test.ts" \
  "src/workflow/pluginWorkloadSdkProvisioner.grokPolicy.test.ts" \
  "src/workflow/workflowReconciler.grokWrcFlag.test.ts" \
  "src/reconciler/workflowRecipeReconciler.grokFlagWiring.test.ts" \
  "src/reconciler/pluginWorkloadSdkValidator.test.ts" \
  "src/mcp/server.pluginSdkBroker.test.ts" \
  "tests/unit/workflow/modelConfigHandler.test.ts" \
  "tests/unit/workflow/modelConfigHandler.pluginSdkBroker.test.ts" \
  "tests/unit/workflow/podFactory.test.ts"

run_group "host-context-controller grok" "host-context-controller" \
  "src/hostReconciler.grokHostRuntime.test.ts" \
  "test/hostReconciler.test.ts"

run_group "control-ui grok" "control-ui" \
  "components/__tests__/CodexSubscriptionHub.test.tsx" \
  "components/__tests__/LlmCatalogFormsGrokGate.test.tsx" \
  "components/__tests__/RecipeEditor.test.tsx" \
  "components/__tests__/HostWizard.test.tsx" \
  "components/__tests__/HostDetailsPage.identity.test.tsx" \
  "components/__tests__/PluginWorkloadSdkPage.test.tsx" \
  "components/__tests__/LlmProviderConfig.test.tsx" \
  "components/__tests__/LlmPolicyEditor.test.tsx" \
  "components/__tests__/LlmModelForm.test.tsx" \
  "lib/__tests__/grokSubscriptionFeature.test.ts" \
  "lib/__tests__/llm.test.ts" \
  "lib/hooks/__tests__/useGrokSubscriptionEnabled.test.tsx"

echo "── grok-llm-proxy deploy contract ──"
if require_file "scripts/tests/test-grok-llm-proxy-deploy-contract.sh" &&
   require_file "tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json"; then
  if bash "${ROOT}/scripts/tests/test-grok-llm-proxy-deploy-contract.sh"; then
    GROUPS_RUN=$((GROUPS_RUN + 1))
    pass "grok-llm-proxy deploy contract"
  else
    fail "grok-llm-proxy deploy contract"
  fi
fi

# A Grok suite that exists but is not listed above is lost coverage. Every
# proxy/contract test file and every *grok* test file in the Grok-touching
# packages must be registered in a group or as a real-PG presence check.
is_registered() {
  local candidate="$1" entry
  for entry in "${REGISTERED[@]}"; do
    [[ "${entry}" == "${candidate}" ]] && return 0
  done
  return 1
}
unlisted=0
while IFS= read -r rel; do
  [[ -n "${rel}" ]] || continue
  if ! is_registered "${rel}"; then
    fail "unlisted Grok suite ${rel}"
    unlisted=1
  fi
done < <(
  cd "${ROOT}" &&
    {
      find grok-llm-proxy/test packages/grok-provider-attempt-contract \
        -name node_modules -prune -o -type f \( -name '*.test.ts' -o -name '*.test.cjs' \) -print
      find control-api mcp-host workflow-recipes host-context-controller control-ui \
        \( -name node_modules -o -name dist -o -name .next -o -name coverage \) -prune -o \
        -type f -iname '*grok*' \( -name '*.test.ts' -o -name '*.test.tsx' \) -print
    } | sort -u
)
if [[ "${unlisted}" -eq 0 ]]; then
  pass "every Grok suite is registered in T0"
fi

if [[ "${GROUPS_RUN}" -ne "${EXPECTED_GROUPS}" ]]; then
  fail "expected all ${EXPECTED_GROUPS} T0 groups, ran ${GROUPS_RUN}"
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "FAIL: grok subscription T0"
  exit 1
fi
echo "PASS: grok subscription T0 (${GROUPS_RUN} groups)"
exit 0
