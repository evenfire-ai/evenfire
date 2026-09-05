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
  profilesNow,
  promptBridgeAttemptsForRun,
  promptBridgeGrantTargets,
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
import { expectDeploymentReady, kubectlOut } from './workflow-approval-quadrants/cluster'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop Apps opens the Plugin Workload SDK sandbox UI
 * through the main-process WebContentsView and EmbeddedContents bridge. The
 * renderer has no HTTP response to await for that transition; the prompt
 * output and the persisted dual ledger are the visible/business signals.
 *
 * Acceptance criterion 8 of issue #533: "a real user-journey E2E covers
 * sdk-only -> codex-subscription primary -> successful prompt, PLUS an eligible
 * failure that reaches a Z.ai fallback". The happy half lives in
 * plugin-workload-sdk-sandbox-ui.spec.ts. This file is the other half, and it
 * is the one that matters most, because the missing fallback WAS the original
 * bug: #533's root cause records that a local no_grant was wrapped as
 * provider_unavailable, classified as a non-retryable authentication failure,
 * and so "the ordered Z.ai fallback is never attempted".
 *
 * Fault injection: `codex-llm-proxy` is scaled to zero. The resulting fetch
 * rejection carries no provider code, so mcp-host's classifyError falls through
 * to classifyUnknown -> {ApiCallFailed, retryable:true} -> failover class
 * `provider_unavailable`, which is in the default triggerOn set. A more
 * specific fault (revoked credential, disallowed model) would classify as
 * non-eligible and propagate WITHOUT failover, proving nothing. control-api's
 * authorize path never contacts the proxy, so attempt 0 is still reserved and
 * the displaced-attempt bookkeeping is exercised for real.
 *
 * This journey therefore also covers `settlePriorProviderAttemptFloors`, the
 * server-side prior-attempt discovery: attempt 0 never reaches finalize when a
 * later target wins, so its spend floor exists only if that path ran.
 *
 * Its own file, its own Make target: the two sandbox journeys previously shared
 * module-scope state, and this one additionally mutates cluster state.
 */
const RUN_ENABLED =
  process.env.E2E_PLUGIN_SDK_DESKTOP === '1' && process.env.E2E_PLUGIN_SDK_CODEX_FALLBACK === '1'

test.skip(
  !RUN_ENABLED,
  'Set E2E_PLUGIN_SDK_DESKTOP=1 and E2E_PLUGIN_SDK_CODEX_FALLBACK=1 for the Codex fallback journey.'
)

const PROXY_NAMESPACE = 'control-plane'
const PROXY_DEPLOYMENT = 'codex-llm-proxy'

/**
 * The granted happy-path fixture. The fallback needs a working grant with an
 * ordered target list, which is exactly what that recipe already has — unlike
 * the no-grant guard, this journey has no reason to install a second recipe.
 */
function grantedFixture(): SandboxUiFixture {
  return assertSandboxUiFixture(
    {
      recipeName: process.env.E2E_PLUGIN_SDK_RECIPE_NAME || 'evenfire-prompt-notify-app',
      recipeNamespace: process.env.E2E_PLUGIN_SDK_RECIPE_NAMESPACE || 'sandbox-recipes',
      appTitle: process.env.E2E_PLUGIN_SDK_APP_TITLE || 'Prompt & Notify',
    },
    'E2E_PLUGIN_SDK'
  )
}

function scaleProxy(replicas: number): void {
  kubectlOut([
    '-n',
    PROXY_NAMESPACE,
    'scale',
    `deployment/${PROXY_DEPLOYMENT}`,
    `--replicas=${replicas}`,
  ])
}

/**
 * Wait until no proxy Pod is left serving. Scaling returns immediately, so
 * prompting before termination completes would race the fault into a normal
 * success and silently turn this into a second happy-path run.
 */
async function expectProxyStopped(): Promise<void> {
  await expect
    .poll(
      () =>
        kubectlOut([
          '-n',
          PROXY_NAMESPACE,
          'get',
          'pods',
          '-l',
          `app=${PROXY_DEPLOYMENT}`,
          '-o',
          'jsonpath={.items[*].metadata.name}',
        ]).trim(),
      { timeout: 120_000 }
    )
    .toBe('')
}

test('Desktop Apps falls back to the authorized non-Codex target when Codex is unavailable', async ({}, testInfo) => {
  requireRecorderConfirm(
    'E2E_PLUGIN_SDK_WRITE_CONFIRM',
    'This journey stops codex-llm-proxy, performs one paid promptBridge call served by the fallback provider, and restores the proxy.'
  )
  const fixture = grantedFixture()
  // Hard preconditions, never branches. An earlier defect was exactly this shape: the
  // happy path kept its only Codex assertions behind a guard, so an OpenAI
  // recipe passed it green without touching Codex, and the static auditor
  // reported PASS because it validates form and cannot reach semantics.
  assertSteplessSdkRecipePrecondition(fixture, 'codex-subscription')
  await expect
    .poll(() => readPluginWorkloadSdkStatus(fixture).state, { timeout: 180_000 })
    .toBe('validated')
  expect(readPluginWorkloadSdkStatus(fixture).bootstrapContractVersion).toBe(3)

  // Without a second authorized target there is nowhere to fall to, and the
  // journey would pass while proving nothing.
  const targets = promptBridgeGrantTargets(fixture)
  expect(targets.length).toBeGreaterThanOrEqual(2)
  expect(targets[0]?.provider).toBe('codex-subscription')
  expect(targets[1]?.provider).not.toBe('codex-subscription')
  expect(targets[1]?.provider).not.toBe('')
  const fallbackProvider = targets[1]!.provider

  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  let app: ElectronApplication | undefined
  let page: Page | undefined
  let proxyStopped = false
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

    await test.step('stop the Codex proxy so the primary target fails eligibly', async () => {
      scaleProxy(0)
      proxyStopped = true
      await expectProxyStopped()
    })

    const runStartedAt = profilesNow()
    const before = sdkInvocationCount(fixture, 'promptBridge')
    await typeEmbedded(
      app,
      webContentsId,
      '#prompt',
      'Reply with the single word OK. Codex is down; the authorized fallback must serve this.'
    )
    await activateEmbedded(app, webContentsId, '#run')
    await expect
      .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), { timeout: 180_000 })
      .not.toMatch(/Running…/)

    const promptResult = await embeddedText(app, webContentsId, '#prompt-out')
    expect(promptResult.trim()).not.toBe('')
    expect(sdkInvocationCount(fixture, 'promptBridge')).toBe(before + 1)
    expect(latestSdkInvocationStatus(fixture, 'promptBridge')).toBe('complete')

    // The dual ledger is the business/audit signal: ordering, attempt limits
    // and spend fencing are all row-level facts here, not inferences from the
    // rendered text.
    const attempts = promptBridgeAttemptsForRun(fixture, runStartedAt)
    await testInfo.attach('promptBridge-attempts.json', {
      body: JSON.stringify(attempts, null, 2),
      contentType: 'application/json',
    })
    expect(attempts).toHaveLength(2)

    const [codexAttempt, fallbackAttempt] = attempts
    expect(codexAttempt!.attemptIndex).toBe(0)
    expect(codexAttempt!.provider).toBe('codex-subscription')
    expect(codexAttempt!.status).toBe('provider_unavailable')
    // The floor for a displaced Codex attempt is honest uncertainty. The fetch
    // rejection leaves providerDispatched undefined, which is read as
    // dispatched, so the ledger records `unknown` rather than claiming the
    // subscription was never touched. `exact` would mean a spend was proven.
    expect(codexAttempt!.spendOutcome).toBe('unknown')
    expect(codexAttempt!.spendOutcome).not.toBe('exact')

    expect(fallbackAttempt!.attemptIndex).toBe(1)
    expect(fallbackAttempt!.provider).toBe(fallbackProvider)
    expect(fallbackAttempt!.provider).not.toBe('codex-subscription')
    // `complete` is the success terminal for a physical attempt; the schema's
    // CHECK allows only reserved/in_progress/complete/failed/
    // provider_unavailable/skipped.
    expect(fallbackAttempt!.status).toBe('complete')
    expect(fallbackAttempt!.codexAttemptId).toBe('')

    await page.getByRole('button', { name: 'Back to apps' }).click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  } finally {
    if (proxyStopped) {
      // Fail loudly rather than leave the cluster degraded. A silent restore
      // failure would poison every later lane on this profile.
      scaleProxy(1)
      expectDeploymentReady(PROXY_NAMESPACE, PROXY_DEPLOYMENT)
    }
    await finalizeRecording(app, page)
  }
})
