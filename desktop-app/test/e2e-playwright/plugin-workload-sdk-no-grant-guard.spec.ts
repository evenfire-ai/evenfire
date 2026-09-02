import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  type EmbeddedContents,
  type SandboxUiFixture,
  activateEmbedded,
  assertSandboxUiFixture,
  assertSteplessSdkRecipePrecondition,
  embeddedText,
  findSandboxUiContents,
  latestSdkInvocationStatus,
  promptBridgeLedgerForRun,
  readPluginWorkloadSdkStatus,
  sandboxUiViewUrlPrefix,
  sdkInvocationCount,
  typeEmbedded,
} from './pluginWorkloadSdkSandboxUi'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  requireRecorderConfirm,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop Apps opens the Plugin Workload SDK sandbox UI
 * through the main-process WebContentsView and EmbeddedContents bridge. The
 * renderer has no HTTP response to await for that transition; the recipe
 * status, native view title, and the absence of a Codex provider attempt in
 * the persisted ledger are the visible/business signals.
 *
 * Regression guard for issue #533: an SDK-only Codex recipe whose execution
 * binding is missing must refuse the prompt in the embedded UI and must never
 * reach the Codex provider or record a spend.
 *
 * This journey REQUIRES `status.pluginWorkloadSdk.state === 'awaiting_policy'`,
 * the exact opposite of the granted happy path in
 * plugin-workload-sdk-sandbox-ui.spec.ts. The two therefore run against
 * separate recipes, from separate Make targets, and this file refuses to start
 * if it is pointed at the granted fixture.
 */
const RUN_ENABLED =
  process.env.E2E_PLUGIN_SDK_DESKTOP === '1' && process.env.E2E_PLUGIN_SDK_NO_GRANT === '1'

test.skip(
  !RUN_ENABLED,
  'Set E2E_PLUGIN_SDK_DESKTOP=1 and E2E_PLUGIN_SDK_NO_GRANT=1 for the no-grant Codex guard.'
)

/** Recipe identity of the granted happy path, used only to reject a collision. */
function grantedRecipeIdentity(): string {
  const name = process.env.E2E_PLUGIN_SDK_RECIPE_NAME || 'evenfire-prompt-notify-app'
  const namespace = process.env.E2E_PLUGIN_SDK_RECIPE_NAMESPACE || 'sandbox-recipes'
  return `${namespace}/${name}`
}

/**
 * Resolve the ungranted fixture from its own variables. There is deliberately
 * no default recipe: the guard needs a recipe that is missing its Codex
 * execution binding, and silently borrowing the granted recipe would turn this
 * regression test into a guaranteed failure (or, worse, into a pass that
 * proves nothing about the no-grant path).
 *
 * Built inside the test rather than at module scope so a misconfigured value
 * fails this journey loudly instead of aborting collection of the whole
 * Desktop Playwright suite.
 */
function ungrantedFixture(): SandboxUiFixture {
  const recipeName = (process.env.E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME ?? '').trim()
  if (!recipeName) {
    throw new Error(
      'E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME is required: install a Codex SDK-only recipe whose ' +
        'execution binding is missing. This guard must never share the granted happy-path recipe.'
    )
  }
  const appTitle = (process.env.E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE ?? '').trim()
  if (!appTitle) {
    throw new Error(
      'E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE is required: the ungranted app must be distinguishable ' +
        'from the granted app in the Desktop Apps catalog.'
    )
  }
  const fixture = assertSandboxUiFixture(
    {
      recipeName,
      recipeNamespace: process.env.E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE || 'sandbox-recipes',
      appTitle,
    },
    'E2E_PLUGIN_SDK_NO_GRANT'
  )
  const identity = `${fixture.recipeNamespace}/${fixture.recipeName}`
  if (identity === grantedRecipeIdentity()) {
    throw new Error(
      `Refusing to run the no-grant guard against the granted happy-path recipe ${identity}. ` +
        'The two journeys require opposite pluginWorkloadSdk states on the same object.'
    )
  }
  return fixture
}

test('Desktop Apps refuses a Codex prompt when the execution binding is missing', async ({}, testInfo) => {
  requireRecorderConfirm(
    'E2E_PLUGIN_SDK_WRITE_CONFIRM',
    'This journey submits one promptBridge request that must be refused before any provider dispatch.'
  )
  const fixture = ungrantedFixture()
  // Hard precondition, not a skip: this guard exists only for Codex, so a
  // non-Codex fixture means the regression was never exercised. A skipped
  // guard is indistinguishable from a passing one in the lane summary.
  assertSteplessSdkRecipePrecondition(fixture, 'codex-subscription')
  const sdkStatus = readPluginWorkloadSdkStatus(fixture)
  expect(sdkStatus.state).not.toBe('validated')
  expect(sdkStatus.state).toBe('awaiting_policy')
  expect(sdkStatus.message).toMatch(
    /codex_execution_binding_missing|grant_missing|policy is not ready/i
  )
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    const credentials = desktopCredentials()
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)
    await page.getByTestId('nav-sandbox-ui').click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
    const appCard = page
      .getByRole('main')
      .getByRole('button', { name: `Open ${fixture.appTitle}`, exact: true })
    // Exactly one card: a title shared with the granted app would make this
    // locator ambiguous and the guard could open the wrong sandbox UI.
    await expect(appCard).toHaveCount(1)
    await expect(appCard).toBeVisible({ timeout: 30_000 })
    await appCard.click()
    await expect(page.getByRole('button', { name: 'Back to apps' })).toBeVisible({
      timeout: 30_000,
    })
    let embedded: EmbeddedContents | null = null
    await expect
      .poll(async () => {
        embedded = await findSandboxUiContents(app!, fixture)
        return embedded?.url ?? ''
      })
      .toContain(sandboxUiViewUrlPrefix(fixture))
    const webContentsId = embedded!.id
    const runStartedAt = new Date().toISOString()
    const before = sdkInvocationCount(fixture, 'promptBridge')
    await typeEmbedded(app, webContentsId, '#prompt', 'This prompt must not dispatch Codex.')
    await activateEmbedded(app, webContentsId, '#run')
    await expect
      .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), { timeout: 60_000 })
      .toMatch(
        /provider_unavailable|codex_execution_binding_missing|policy is not ready|not authorized/i
      )
    const promptResult = await embeddedText(app, webContentsId, '#prompt-out')
    expect(promptResult).not.toMatch(/Running…/)
    const after = sdkInvocationCount(fixture, 'promptBridge')
    const ledger = promptBridgeLedgerForRun(fixture, runStartedAt)
    expect(ledger.codexAttemptId).toBe('')
    expect(ledger.spendOutcome).not.toBe('exact')
    expect(after).toBeGreaterThanOrEqual(before)
    expect(after).toBeLessThanOrEqual(before + 1)
    if (after > before) {
      expect(latestSdkInvocationStatus(fixture, 'promptBridge')).not.toBe('complete')
    }
    await page.getByRole('button', { name: 'Back to apps' }).click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  } finally {
    await finalizeRecording(app, page)
  }
})
