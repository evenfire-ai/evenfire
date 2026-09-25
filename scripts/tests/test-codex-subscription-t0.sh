#!/usr/bin/env bash
# Codex subscription T0 aggregator.
#
# Fails when a required suite is missing, executes zero tests, reports
# skipped/todo cases, or exits non-zero. Exit 0 alone is never enough: the
# script parses machine-readable counts from Vitest or node:test.
#
# Lane separation: Grok-only suites run in test-grok-subscription-t0.sh, never
# here. Provider-neutral suites shared by both brokers may appear in both.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
GROUPS_RUN=0
REGISTERED=()

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

  if ! assert_executed_counts "$name" "$log"; then
    rm -f "$log"
    return 1
  fi

  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "${name}"
  rm -f "$log"
}

# Protocol fixtures and runner guards use node:test rather than a package's Vitest script.
run_node_group() {
  local name="$1" rel log
  shift
  local files=()
  for rel in "$@"; do
    REGISTERED+=("${rel}")
    require_file "$rel" || return 1
    files+=("${ROOT}/$rel")
  done
  [[ ${#files[@]} -gt 0 ]] || { fail "$name: group listed no suite files"; return 1; }
  log="$(mktemp)"
  echo "── ${name} ──"
  if ! node "$ROOT/scripts/tests/run-node-test-files.mjs" "${files[@]}" >"$log" 2>&1; then
    fail "$name: command failed"
    cat "$log"
    rm -f "$log"
    return 1
  fi
  if ! assert_executed_counts "$name" "$log"; then
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "$name"
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
  # The real-PG lane lists each suite by its file name, `.test.ts` included.
  suite="$(basename "${rel}")"
  if ! sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*\\$//' "${ROOT}/.github/workflows/ci-public.yml" |
    grep -Fxq "${suite}"; then
    fail "ci-public.yml real-PG lane does not list ${suite}"
    return 1
  fi
  pass "real-PG suite present and listed in CI: ${suite}"
}

echo "Codex subscription T0 aggregator"

if [[ ! -f "${ROOT}/scripts/tests/test-codex-subscription-t0.sh" ]]; then
  fail "aggregator script is missing"
fi

require_ci_matrix_entry "codex-llm-proxy"
require_ci_matrix_entry "packages/llm-provider-attempt-contract"
require_ci_matrix_entry "packages/codex-catalog-projection"

expected_device_uri='https://auth.openai.com/codex/device'
api_device_uri="$(
  sed -n "s/^export const CODEX_OAUTH_DEVICE_VERIFICATION_URI = '\\(.*\\)'$/\\1/p" \
    "${ROOT}/control-api/src/services/codexSubscriptionOAuth.ts"
)"
ui_device_uri="$(
  sed -n "s/^export const CODEX_DEVICE_VERIFICATION_URI = '\\(.*\\)'$/\\1/p" \
    "${ROOT}/control-ui/lib/codexSubscription.ts"
)"
if [[ "${api_device_uri}" == "${expected_device_uri}" && "${ui_device_uri}" == "${expected_device_uri}" ]]; then
  pass "device verification URI lock"
else
  fail "device verification URI lock (api=${api_device_uri:-missing} ui=${ui_device_uri:-missing})"
fi

run_group "shared-contract" "packages/llm-provider-attempt-contract" "index.test.cjs"
run_group "codex-catalog-projection" "packages/codex-catalog-projection" "index.test.cjs"

run_node_group "approved-tools-fixtures-and-runner" \
  "scripts/tests/run-node-test-files.test.mjs" \
  "tests/e2e/fixtures/codex-subscription/approved-tools/server.test.mjs" \
  "scripts/e2e/prepare-codex-approved-tools.test.mjs" \
  "scripts/e2e/run-codex-approved-tools.test.mjs" \
  "scripts/e2e/desktop-login-seed.test.mjs" \
  "scripts/e2e/approved-tools-image-proof.test.mjs" \
  "scripts/e2e/approved-tools-restoration.test.mjs" \
  "scripts/e2e/approved-tools-control-api-lifecycle.test.mjs" \
  "scripts/e2e/approved-tools-connection-journal.test.mjs" \
  "tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.test.mjs" \
  "tests/e2e/fixtures/codex-subscription/approved-tools-oauth/provider.test.mjs" \
  "scripts/e2e/approved-tools-resource-cleanup.test.mjs" \
  "tests/e2e/fixtures/codex-subscription/approved-tools-workflow/index.test.mjs"


run_group "control-api" "control-api" \
  "test/codexSubscriptionRedirectUri.test.ts" \
  "test/routes.admin.codexSubscription.test.ts" \
  "test/routes.admin.codexSubscription.hostWrite.test.ts" \
  "test/routes.auth.codexSubscriptionCallback.test.ts" \
  "test/routes.mcp-host.llmProviderAttempts.test.ts" \
  "test/routes.adminRecipes.test.ts" \
  "test/routes.adminPluginWorkloadSdk.test.ts" \
  "test/services.recipeCodexGrantIdentity.test.ts" \
  "test/services.recipeGrantTransition.test.ts" \
  "test/crd.llmProviderEnums.test.ts" \
  "test/hostSpecValidation.codexSubscription.test.ts" \
  "test/llmProviders.test.ts" \
  "test/services.codexSubscriptionConnection.test.ts" \
  "test/services.llmAllowedModelsConfigMap.test.ts" \
  "test/services.codexSubscriptionOAuth.test.ts" \
  "test/services.codexSubscriptionCatalog.test.ts" \
  "test/services.subscriptionCatalogBounds.test.ts" \
  "test/services.llmProviderAttemptAuthorizer.test.ts" \
  "test/services.llmProviderAttemptAuthorizer.depth.test.ts" \
  "test/services.llmProviderAttemptTicket.test.ts" \
  "test/services.llmProviderAttemptRedemption.test.ts" \
  "test/services.llmProviderAttemptFinalization.test.ts" \
  "test/services.usageEvents.test.ts" \
  "test/services.pluginWorkloadSdkFinalization.test.ts" \
  "test/routes.mcp-host.plugin-workload-sdk.test.ts" \
  "test/db.llmProviderAttemptMigration.test.ts" \
  "test/db.oauthGrantsOwnerGeneralization.test.ts" \
  "test/routes.usageEvents.test.ts" \
  "test/db.codexSubscriptionMigration.test.ts" \
  "test/routes.admin.codexSubscription.oauthBrokerExtract.test.ts"

require_real_pg_suite "control-api/test/db.codexSubscriptionConnection.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/pluginWorkloadSdkCodexDualLedger.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.codexSubscriptionCatalog.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.codexSubscriptionLifecycle.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.codexSubscriptionOAuth.realPostgres.integration.test.ts"
require_real_pg_suite "control-api/test/services.codexSubscriptionRefreshRejected.realPostgres.integration.test.ts"

run_group "codex-llm-proxy" "codex-llm-proxy" \
  "test/abortWhenClientDisconnects.test.ts" \
  "test/approvedToolsUpstream.test.ts" \
  "test/bindLoopbackSetup.test.ts" \
  "test/bodyAdmission.test.ts" \
  "test/bodyBudget.test.ts" \
  "test/bodyStructure.test.ts" \
  "test/catalogBounds.test.ts" \
  "test/catalogContextWindow.test.ts" \
  "test/chatgptUpstreamHeaders.test.ts" \
  "test/codexTransport.conformance.test.ts" \
  "test/controlApiClient.test.ts" \
  "test/deployManifest.test.ts" \
  "test/executionTicketVerifier.test.ts" \
  "test/metrics.test.ts" \
  "test/originPolicy.test.ts" \
  "test/redaction.test.ts" \
  "test/requestLimits.test.ts" \
  "test/runtimePath.hermetic.e2e.test.ts" \
  "test/server.security.test.ts" \
  "test/sseBackpressure.test.ts" \
  "test/sseHeartbeat.test.ts" \
  "test/streamGate.handoff.test.ts" \
  "test/streamLimitsFreeze.test.ts" \
  "test/toolNameMap.test.ts"

run_group "mcp-host" "mcp-host" \
  "src/__tests__/bodylimits.test.ts" \
  "src/capabilities/toolCatalogTools.test.ts" \
  "src/core/orchestration/__tests__/approvedToolsLifecycle.integration.test.ts" \
  "src/core/orchestration/__tests__/toolUseLoop.spillover.test.ts" \
  "src/mcp/__tests__/managerDelimiterDispatch.test.ts" \
  "src/logger.test.ts" \
  "src/core/orchestration/__tests__/toolPresentationPolicy.test.ts" \
  "src/core/orchestration/__tests__/deferrableToolController.test.ts" \
  "src/core/orchestration/__tests__/toolCallBridge.test.ts" \
  "src/core/orchestration/__tests__/toolUseLoop.test.ts" \
  "src/core/orchestration/__tests__/toolUseLoopMessages.test.ts" \
  "src/core/extensions/__tests__/prePrune.test.ts" \
  "src/core/adapters/__tests__/llmImageCompatibility.test.ts" \
  "src/core/adapters/__tests__/llmPortAdapterDiagnostics.test.ts" \
  "src/agent/__tests__/taskExecutor.test.ts" \
  "src/llm/__tests__/openai.singleTurn.test.ts" \
  "src/llm/__tests__/claude.singleTurn.test.ts" \
  "src/llm/__tests__/codexSubscription.test.ts" \
  "src/llm/__tests__/codexLlmProxyClient.test.ts" \
  "src/llm/__tests__/subscriptionRequestHash.test.ts" \
  "src/llm/__tests__/providerAttemptAuthorizer.test.ts" \
  "src/llm/hostLlmBinding.test.ts" \
  "src/config/configStore.test.ts" \
  "src/llm/failover/__tests__/engine.test.ts" \
  "src/pluginWorkloadSdk/promptBridge/llmBridge.failover.test.ts" \
  "src/pluginWorkloadSdk/bootstrapIdentity.test.ts" \
  "src/pluginWorkloadSdk/promptBridge/controlApiClient.test.ts" \
  "src/workflow/__tests__/configureHandler.test.ts" \
  "src/workflow/__tests__/workflowServiceUsageReporting.test.ts" \
  "src/pluginWorkloadSdk/server/index.test.ts" \
  "src/core/adapters/__tests__/llmPortAdapter.test.ts" \
  "src/config.codexToolPresentation.test.ts" \
  "src/llm/__tests__/codexPlatformJwt.test.ts" \
  "src/llm/__tests__/codexPolicyBinding.test.ts" \
  "src/pluginWorkloadSdk/sdkOnlyCodexBinding.test.ts"

run_group "rpc-proxy-image-budgets" "rpc-proxy" \
  "src/__tests__/bodylimits.test.ts"

run_group "host-context-controller" "host-context-controller" \
  "src/codexExecutionProjection.test.ts" \
  "src/hostReconciler.codexScopeProvenance.test.ts" \
  "src/llmAllowedModelsSnapshot.test.ts" \
  "src/networkPolicyReconciler.test.ts"

run_group "workflow-runtime-core" "packages/workflow-runtime-core" \
  "tests/unit/injection.test.ts"

run_group "workflow-recipes" "workflow-recipes" \
  "src/workflow/codexExecutionProjection.test.ts" \
  "src/workflow/codexRecipeVerdict.test.ts" \
  "src/workflow/workflowReconciler.codexScopeProvenance.test.ts" \
  "src/workflow/llmAllowedModelsSnapshot.test.ts" \
  "src/workflow/networkPolicyFactory.codex.test.ts" \
  "src/workflow/sdkOnlyCodexBinding.test.ts" \
  "src/workflow/pluginWorkloadSdkProvisioner.codexPolicy.test.ts" \
  "src/reconciler/pluginWorkloadSdkValidator.test.ts" \
  "tests/unit/workflow/modelConfigHandler.test.ts" \
  "tests/unit/workflow/modelConfigHandler.pluginSdkBroker.test.ts" \
  "src/workflow/workflowReconciler.codexUncertainScope.test.ts"

run_group "control-ui" "control-ui" \
  "components/__tests__/CodexSubscriptionHub.test.tsx" \
  "lib/__tests__/codexSubscription.sanitize.test.ts" \
  "components/__tests__/LlmProviderConfig.test.tsx" \
  "lib/__tests__/llm.codexGrantModel.test.ts" \
  "lib/__tests__/llmCredentialSelect.test.ts" \
  "components/__tests__/HostWizard.test.tsx" \
  "components/__tests__/HostDetailsPage.identity.test.tsx" \
  "components/__tests__/RecipeEditor.test.tsx" \
  "components/__tests__/PluginWorkloadSdkPage.test.tsx"

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
      "src/__tests__/devIsolation.test.ts" \
      "ui/src/components/agents/__tests__/ComposerPanel.test.tsx" \
      "ui/src/components/agents/__tests__/ModelSelector.test.tsx" \
      "ui/src/hooks/__tests__/useHostModels.test.tsx" \
      "ui/src/hooks/domain/__tests__/useAgentChatController.pendingModel.test.tsx"
  fi
fi

# A Codex suite that exists but is not listed above is lost coverage. Every
# proxy/contract test file and every *codex* test file in the Codex-touching
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
    fail "unlisted Codex suite ${rel}"
    unlisted=1
  fi
done < <(
  cd "${ROOT}" &&
    {
      find codex-llm-proxy/test packages/llm-provider-attempt-contract \
        -name node_modules -prune -o -type f \( -name '*.test.ts' -o -name '*.test.cjs' \) -print
      find control-api mcp-host workflow-recipes host-context-controller control-ui \
        \( -name node_modules -o -name dist -o -name .next -o -name coverage \) -prune -o \
        -type f -iname '*codex*' \( -name '*.test.ts' -o -name '*.test.tsx' \) -print
    } | sort -u
)
if [[ "${unlisted}" -eq 0 ]]; then
  pass "every Codex suite is registered in T0"
fi

if [[ "${GROUPS_RUN}" -ne 12 ]]; then
  fail "expected all 12 T0 groups, ran ${GROUPS_RUN}"
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "Codex subscription T0 FAILED"
  exit 1
fi

echo "Codex subscription T0 passed (${GROUPS_RUN} groups)"
exit 0
