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
  if grep -Eq '(Test Files|Tests).*[1-9][0-9]* todo' "$normalized"; then
    fail "${name}: Vitest reported todo tests"
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
require_file control-api/test/services.grokProviderAttemptTicket.test.ts
require_file control-api/test/services.grokSubscriptionConnection.realPostgres.integration.test.ts
require_file control-api/test/pluginWorkloadSdkGrokDualLedger.realPostgres.integration.test.ts
require_file control-api/test/services.grokProviderAttemptRedemption.realPostgres.integration.test.ts
require_file control-api/test/services.grokProviderAttemptRedemption.test.ts
require_file control-api/test/db.grokSubscriptionMigration.test.ts
require_file control-api/test/services.llmProviderAttemptAuthorizer.grok.test.ts
require_file control-api/test/subscriptionGrantIdentity.test.ts
require_file control-api/test/routes.adminPluginWorkloadSdk.test.ts
require_file control-api/test/services.recipeCodexGrantIdentity.test.ts
require_file control-api/test/hostSpecValidation.grokSubscription.test.ts
require_file control-api/test/crd.llmProviderEnums.test.ts
require_file control-api/test/routes.mcp-host.plugin-workload-sdk.test.ts
require_file mcp-host/src/pluginWorkloadSdk/promptBridge/controlApiClient.test.ts
require_file mcp-host/src/pluginWorkloadSdk/promptBridge/llmBridge.failover.test.ts
require_file control-ui/components/__tests__/HostWizard.test.tsx
require_file control-ui/components/__tests__/HostDetailsPage.identity.test.tsx
require_file scripts/tests/test-grok-llm-proxy-deploy-contract.sh
require_file tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json
require_file workflow-recipes/src/workflow/codexRecipeVerdict.test.ts
require_file workflow-recipes/src/workflow/sdkOnlyGrokBinding.test.ts
require_file workflow-recipes/src/workflow/pluginWorkloadSdkProvisioner.grokPolicy.test.ts
require_file workflow-recipes/tests/unit/workflow/modelConfigHandler.pluginSdkBroker.test.ts
require_file mcp-host/src/pluginWorkloadSdk/bootstrapIdentity.test.ts
require_file packages/codex-catalog-projection/index.test.cjs
require_file control-api/test/services.usageEvents.test.ts
require_file control-api/test/services.llmProviderAttemptFinalization.test.ts
require_file workflow-recipes/tests/unit/workflow/podFactory.test.ts
require_file control-ui/components/__tests__/RecipeEditor.test.tsx
require_file control-ui/lib/__tests__/llm.test.ts
require_file control-ui/components/__tests__/PluginWorkloadSdkPage.test.tsx

expected_device_url='https://auth.x.ai/oauth2/device/code'
expected_token_url='https://auth.x.ai/oauth2/token'
expected_client_id='b1a00492-073a-47ea-816f-4c329264a828'
api_device_url="$(
  sed -n "s/^export const GROK_OAUTH_DEVICE_URL = '\\(.*\\)'$/\\1/p" \
    "${ROOT}/control-api/src/services/grokSubscriptionOAuth.ts"
)"
api_token_url="$(
  sed -n "s/^export const GROK_OAUTH_TOKEN_URL = '\\(.*\\)'$/\\1/p" \
    "${ROOT}/control-api/src/services/grokSubscriptionOAuth.ts"
)"
api_client_id="$(
  sed -n "s/.*CONTROL_API_GROK_OAUTH_CLIENT_ID || '\\(.*\\)',$/\\1/p" \
    "${ROOT}/control-api/src/config.ts"
)"
if [[ "${api_device_url}" == "${expected_device_url}" &&
      "${api_token_url}" == "${expected_token_url}" &&
      "${api_client_id}" == "${expected_client_id}" ]]; then
  pass "Grok OAuth origin/client lock"
else
  fail "Grok OAuth origin/client lock (device=${api_device_url:-missing} token=${api_token_url:-missing} client=${api_client_id:-missing})"
fi

run_group "grok-provider-attempt-contract" \
  bash -lc "cd '${ROOT}/packages/grok-provider-attempt-contract' && node --test index.test.cjs"

run_group "grok-catalog-projection" \
  bash -lc "cd '${ROOT}/packages/codex-catalog-projection' && node --test index.test.cjs"

run_group "grok-llm-proxy freeze+origin" \
  bash -lc "cd '${ROOT}/grok-llm-proxy' && npx vitest run test/contractFreeze.test.ts test/originPolicy.test.ts test/grokTransport.conformance.test.ts --no-file-parallelism"

run_group "grok-llm-proxy tsc" \
  bash -lc "cd '${ROOT}/grok-llm-proxy' && npx tsc --noEmit && echo 'pass 1'"

run_group "control-api grok grant/oauth/redeem/authorize" \
  bash -lc "cd '${ROOT}/control-api' && npx vitest run test/db.grokSubscriptionMigration.test.ts test/services.grokSubscriptionConnection.test.ts test/services.grokSubscriptionOAuth.test.ts test/services.grokSubscriptionCatalog.test.ts test/services.grokProviderAttemptRedemption.test.ts test/services.grokProviderAttemptTicket.test.ts test/services.llmProviderAttemptAuthorizer.grok.test.ts test/subscriptionGrantIdentity.test.ts test/routes.adminPluginWorkloadSdk.test.ts test/services.recipeCodexGrantIdentity.test.ts test/hostSpecValidation.grokSubscription.test.ts test/crd.llmProviderEnums.test.ts test/routes.mcp-host.plugin-workload-sdk.test.ts test/services.usageEvents.test.ts test/services.llmProviderAttemptFinalization.test.ts --no-file-parallelism"

run_group "workflow-recipes grok SDK" \
  bash -lc "cd '${ROOT}/workflow-recipes' && npx vitest run src/workflow/codexRecipeVerdict.test.ts src/workflow/sdkOnlyGrokBinding.test.ts src/workflow/pluginWorkloadSdkProvisioner.grokPolicy.test.ts src/reconciler/pluginWorkloadSdkValidator.test.ts tests/unit/workflow/modelConfigHandler.pluginSdkBroker.test.ts tests/unit/workflow/podFactory.test.ts --no-file-parallelism"

run_group "mcp-host grok bootstrap" \
  bash -lc "cd '${ROOT}/mcp-host' && npx vitest run src/pluginWorkloadSdk/bootstrapIdentity.test.ts src/pluginWorkloadSdk/promptBridge/controlApiClient.test.ts src/pluginWorkloadSdk/promptBridge/llmBridge.failover.test.ts --no-file-parallelism"

run_group "control-ui grok SDK picker" \
  bash -lc "cd '${ROOT}/control-ui' && npx vitest run components/__tests__/PluginWorkloadSdkPage.test.tsx components/__tests__/HostWizard.test.tsx components/__tests__/HostDetailsPage.identity.test.tsx components/__tests__/RecipeEditor.test.tsx lib/__tests__/llm.test.ts --no-file-parallelism"

if ! bash "${ROOT}/scripts/tests/test-grok-llm-proxy-deploy-contract.sh"; then
  fail "grok-llm-proxy deploy contract"
else
  GROUPS_RUN=$((GROUPS_RUN + 1))
  pass "grok-llm-proxy deploy contract"
fi

if [[ "$GROUPS_RUN" -lt 9 ]]; then
  fail "T0 ran too few groups (${GROUPS_RUN})"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "FAIL: grok subscription T0"
  exit 1
fi
echo "PASS: grok subscription T0 (${GROUPS_RUN} groups)"
exit 0
