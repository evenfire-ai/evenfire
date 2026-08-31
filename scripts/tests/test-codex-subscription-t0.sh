#!/usr/bin/env bash
# Codex subscription T0 aggregator.
#
# Fails when a required suite is missing, executes zero tests, reports
# skipped/todo cases, or exits non-zero. Exit 0 alone is never enough: the
# script parses machine-readable counts from Vitest or node:test.
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

# Return 0 when the captured reporter proves at least one passing test and
# zero skipped/todo cases. Supports Vitest summaries and node:test counters.
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
  local node_tests
  node_tests="$(
    grep -E 'tests[[:space:]]+[1-9][0-9]*$' "$normalized" | awk '{print $NF}' | tail -n 1 || true
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

  if [[ -n "${node_tests}" && -n "${node_pass}" && "${node_tests}" != "${node_pass}" ]]; then
    fail "${name}: node:test pass count ${node_pass} does not match tests ${node_tests}"
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

echo "Codex subscription T0 aggregator"

if [[ ! -f "${ROOT}/scripts/tests/test-codex-subscription-t0.sh" ]]; then
  fail "aggregator script is missing"
fi

require_ci_matrix_entry "codex-llm-proxy"
require_ci_matrix_entry "packages/llm-provider-attempt-contract"
require_ci_matrix_entry "packages/codex-catalog-projection"

run_group "shared-contract" "packages/llm-provider-attempt-contract" "index.test.cjs"
run_group "codex-catalog-projection" "packages/codex-catalog-projection" "index.test.cjs"

run_group "control-api" "control-api" \
  "test/codexSubscriptionRedirectUri.test.ts" \
  "test/routes.admin.codexSubscription.test.ts" \
  "test/routes.admin.codexSubscription.hostWrite.test.ts" \
  "test/routes.auth.codexSubscriptionCallback.test.ts" \
  "test/routes.mcp-host.llmProviderAttempts.test.ts" \
  "test/routes.adminRecipes.test.ts" \
  "test/routes.adminPluginWorkloadSdk.test.ts" \
  "test/services.recipeCodexGrantIdentity.test.ts" \
  "test/crd.llmProviderEnums.test.ts" \
  "test/hostSpecValidation.codexSubscription.test.ts" \
  "test/llmProviders.test.ts" \
  "test/services.codexSubscriptionConnection.test.ts" \
  "test/services.llmAllowedModelsConfigMap.test.ts" \
  "test/services.codexSubscriptionOAuth.test.ts" \
  "test/services.codexSubscriptionCatalog.test.ts" \
  "test/services.llmProviderAttemptAuthorizer.test.ts" \
  "test/services.llmProviderAttemptTicket.test.ts" \
  "test/services.llmProviderAttemptRedemption.test.ts" \
  "test/services.llmProviderAttemptFinalization.test.ts" \
  "test/services.usageEvents.test.ts" \
  "test/services.pluginWorkloadSdkFinalization.test.ts" \
  "test/routes.usageEvents.test.ts"

run_group "codex-llm-proxy" "codex-llm-proxy" \
  "test/codexTransport.conformance.test.ts" \
  "test/controlApiClient.test.ts" \
  "test/originPolicy.test.ts" \
  "test/redaction.test.ts" \
  "test/server.security.test.ts"

run_group "mcp-host" "mcp-host" \
  "src/llm/__tests__/codexSubscription.test.ts" \
  "src/llm/__tests__/codexLlmProxyClient.test.ts" \
  "src/llm/__tests__/providerAttemptAuthorizer.test.ts" \
  "src/llm/hostLlmBinding.test.ts" \
  "src/config/configStore.test.ts" \
  "src/llm/failover/__tests__/engine.test.ts" \
  "src/pluginWorkloadSdk/promptBridge/llmBridge.failover.test.ts" \
  "src/workflow/__tests__/configureHandler.test.ts" \
  "src/workflow/__tests__/workflowServiceUsageReporting.test.ts" \
  "src/pluginWorkloadSdk/server/index.test.ts" \
  "src/core/adapters/__tests__/llmPortAdapter.test.ts"

run_group "host-context-controller" "host-context-controller" \
  "src/codexExecutionProjection.test.ts" \
  "src/hostReconciler.codexScopeProvenance.test.ts" \
  "src/llmAllowedModelsSnapshot.test.ts" \
  "src/networkPolicyReconciler.test.ts"

run_group "workflow-runtime-core" "packages/workflow-runtime-core" \
  "tests/unit/injection.test.ts"

run_group "workflow-recipes" "workflow-recipes" \
  "src/workflow/codexExecutionProjection.test.ts" \
  "src/workflow/workflowReconciler.codexScopeProvenance.test.ts" \
  "src/workflow/llmAllowedModelsSnapshot.test.ts" \
  "src/workflow/networkPolicyFactory.codex.test.ts" \
  "tests/unit/workflow/modelConfigHandler.test.ts"

run_group "control-ui" "control-ui" \
  "components/__tests__/CodexSubscriptionHub.test.tsx" \
  "components/__tests__/LlmProviderConfig.test.tsx" \
  "lib/__tests__/llm.codexGrantModel.test.ts" \
  "lib/__tests__/llmCredentialSelect.test.ts" \
  "components/__tests__/HostWizard.test.tsx" \
  "components/__tests__/HostDetailsPage.identity.test.tsx" \
  "components/__tests__/RecipeEditor.test.tsx"

node_major=$(node --version | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
if [[ "${node_major}" != "24" ]]; then
  fail "Desktop T0 requires Node 24.x (got $(node --version))"
else
  pass "Node $(node --version) for Desktop T0"
  if ! (
    cd "${ROOT}/desktop-app"
    npm run verify:electron
  ); then
    fail "desktop-app verify:electron failed"
  else
    pass "desktop-app verify:electron"
    run_group "desktop-app" "desktop-app" \
      "ui/src/components/agents/__tests__/ModelSelector.test.tsx" \
      "ui/src/hooks/__tests__/useHostModels.test.tsx" \
      "ui/src/hooks/domain/__tests__/useAgentChatController.pendingModel.test.tsx"
  fi
fi

if [[ "${GROUPS_RUN}" -lt 8 ]]; then
  fail "expected 8 T0 groups, ran ${GROUPS_RUN}"
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "Codex subscription T0 FAILED"
  exit 1
fi

echo "Codex subscription T0 passed (${GROUPS_RUN} groups)"
exit 0
