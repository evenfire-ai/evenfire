import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  type EmbeddedContents,
  type SandboxUiFixture,
  activateEmbedded,
  assertSandboxUiFixture,
  assertSteplessSdkRecipePrecondition,
  attachVisualLayout,
  captureDesktopWindow,
  captureEmbeddedView,
  embeddedOptions,
  embeddedRect,
  embeddedText,
  embeddedValue,
  findSandboxUiContents,
  latestSdkInvocationStatus,
  notificationDeliverySignal,
  promptBridgeLedgerForRun,
  readPluginWorkloadSdkStatus,
  requireExpectedSdkProvider,
  sandboxUiViewUrlPrefix,
  sdkInvocationCount,
  selectEmbeddedRecipient,
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
  openSettings,
  requireRecorderConfirm,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop Apps opens the Plugin Workload SDK sandbox UI
 * through the main-process WebContentsView and EmbeddedContents bridge. The
 * renderer has no HTTP response to await for that transition; the recipe
 * precondition, native view title, and persisted promptBridge ledger are the
 * visible/business signals.
 *
 * This file owns ONLY the validated (granted) happy path. The no-grant Codex
 * guard lives in plugin-workload-sdk-no-grant-guard.spec.ts with its own
 * recipe: the two journeys assert mutually exclusive cluster state on
 * `status.pluginWorkloadSdk.state`, so they must never share a fixture.
 */
const RUN_ENABLED = process.env.E2E_PLUGIN_SDK_DESKTOP === '1'
const CAPTURE_VISUALS = process.env.E2E_PLUGIN_SDK_CAPTURE === '1'

test.skip(
  !RUN_ENABLED,
  'Set E2E_PLUGIN_SDK_DESKTOP=1 for the branch-owned Electron/Apps/WebContentsView gate.'
)

/**
 * Resolve the granted fixture. Built inside the test rather than at module
 * scope so a misconfigured value fails this journey loudly instead of aborting
 * collection of the whole Desktop Playwright suite.
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

test('Desktop Apps executes promptBridge and clientNotifications inside the real WebContentsView', async ({}, testInfo) => {
  requireRecorderConfirm(
    'E2E_PLUGIN_SDK_WRITE_CONFIRM',
    'This journey performs one paid promptBridge call and sends one test notification.'
  )
  const fixture = grantedFixture()
  // The provider under test is declared by the operator and then asserted
  // against the live recipe. Without it a Codex lane could report green while
  // an OpenAI recipe served every prompt, because both providers satisfy the
  // generic SDK-only precondition.
  const expectedProvider = requireExpectedSdkProvider('E2E_PLUGIN_SDK_EXPECT_PROVIDER')
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)
  // Read-only setup assertion. Every functional action that follows is through
  // the real Desktop UI and its native WebContentsView.
  assertSteplessSdkRecipePrecondition(fixture, expectedProvider)
  const requiresCodex = expectedProvider === 'codex-subscription'
  await expect
    .poll(() => readPluginWorkloadSdkStatus(fixture).state, { timeout: 180_000 })
    .toBe('validated')
  if (requiresCodex) {
    expect(readPluginWorkloadSdkStatus(fixture).bootstrapContractVersion).toBe(3)
  }

  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    const credentials = desktopCredentials()
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)

    await test.step('configure in-app notifications through visible Desktop settings', async () => {
      await openSettings(page!)
      await page!.getByRole('tab', { name: 'Notifications', exact: true }).click()
      const inAppSection = page!.locator('form').filter({
        has: page!.getByRole('heading', { name: 'In App Notifications', exact: true }),
      })
      const always = inAppSection.locator('input[type="radio"][value="always"]')
      await expect(always).toBeVisible()
      if (!(await always.isChecked())) {
        await always.check()
      }
      const save = inAppSection.getByRole('button', { name: 'Save changes', exact: true })
      if (await save.isVisible()) {
        await save.click()
        await expect(
          page!.getByText('In app notification settings saved.', { exact: true })
        ).toBeVisible()
      }
    })

    await page.getByTestId('nav-sandbox-ui').click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
    // The sidebar also exposes an "Open <app>" control for the same app. Scope
    // the action to the Apps main content so this journey follows the visible
    // catalog card a user would select, rather than relying on a strict-mode
    // ambiguous global locator.
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
    await expect.poll(() => embeddedRect(app!, webContentsId, '#run')).not.toBeNull()

    if (CAPTURE_VISUALS) {
      await page.screenshot({
        path: testInfo.outputPath('desktop-app-sandbox-ui-open.png'),
        fullPage: true,
      })
      await captureDesktopWindow(app, testInfo.outputPath('desktop-app-sandbox-ui-window-open.png'))
      await captureEmbeddedView(
        app,
        webContentsId,
        testInfo.outputPath('desktop-app-sandbox-ui-webcontents.png')
      )
      await attachVisualLayout(page, app, webContentsId, testInfo, 'open')
    }

    const marker = `desktop-sdk-${Date.now()}`
    const runStartedAt = new Date().toISOString()

    await test.step('reject an empty prompt without creating an invocation', async () => {
      const before = sdkInvocationCount(fixture, 'promptBridge')
      await activateEmbedded(app!, webContentsId, '#run')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'))
        .toContain('Enter a prompt first.')
      expect(sdkInvocationCount(fixture, 'promptBridge')).toBe(before)
    })

    await test.step('run the real prompt through the embedded UI', async () => {
      await typeEmbedded(
        app!,
        webContentsId,
        '#prompt',
        `Reply with a short confirmation for test marker ${marker}.`
      )
      const before = sdkInvocationCount(fixture, 'promptBridge')
      await activateEmbedded(app!, webContentsId, '#run')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), {
          timeout: 5_000,
          intervals: [1, 5, 10, 25, 50],
        })
        .toContain('Running…')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#prompt-out'), { timeout: 120_000 })
        .not.toMatch(/^(?:|Running…|Enter a prompt first\.)$/)
      await expect
        .poll(() => sdkInvocationCount(fixture, 'promptBridge'), { timeout: 30_000 })
        .toBe(before + 1)
      await expect
        .poll(() => latestSdkInvocationStatus(fixture, 'promptBridge'), { timeout: 30_000 })
        .toBe('complete')
    })
    const promptResult = await embeddedText(app, webContentsId, '#prompt-out')
    expect(promptResult).not.toMatch(/"error"|provider_unavailable|requires a resolvable agent/i)
    const ledger = promptBridgeLedgerForRun(fixture, runStartedAt)
    expect(ledger.invocationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(ledger.sdkAttemptId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(ledger.sdkAttemptId).not.toBe(ledger.invocationId)
    if (requiresCodex) {
      // Unconditional for a declared Codex run: a linked llm_provider_attempts
      // row and an exact spend outcome are the only proof the prompt was
      // actually dispatched to Codex rather than to another granted provider.
      expect(ledger.codexAttemptId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(ledger.codexAttemptId).not.toBe(ledger.sdkAttemptId)
      expect(ledger.spendOutcome).toBe('exact')
    }

    // Business signal for notifications: the real app loaded the grant-backed
    // recipient list and the native view selected a visible email handle. The
    // opaque userRef is produced by the select control, never typed by the test.
    await expect
      .poll(
        async () =>
          (await embeddedOptions(app!, webContentsId, '#userRef')).filter(
            option => option.value && /@/.test(option.label)
          ).length,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    // The sample UI receives exactly one grant-authorized recipient and the
    // native select therefore adopts it as its initial value. Verify that
    // visible grant-backed choice before continuing; the missing-field guard
    // below still proves the form rejects an incomplete notification without
    // creating an SDK invocation.
    await selectEmbeddedRecipient(app, webContentsId, '#userRef', credentials.email)
    await typeEmbedded(app, webContentsId, '#title', `Evenfire E2E ${marker}`)
    await test.step('reject a notification missing its body before the SDK call', async () => {
      const before = sdkInvocationCount(fixture, 'clientNotifications')
      await activateEmbedded(app!, webContentsId, '#notify')
      await expect
        .poll(() => embeddedText(app!, webContentsId, '#notify-out'))
        .toContain('Title and body are required.')
      expect(sdkInvocationCount(fixture, 'clientNotifications')).toBe(before)
    })
    await typeEmbedded(
      app,
      webContentsId,
      '#message',
      `Plugin Workload SDK Desktop validation ${marker}.`
    )
    await expect
      .poll(() => embeddedValue(app!, webContentsId, '#title'))
      .toBe(`Evenfire E2E ${marker}`)
    await expect
      .poll(() => embeddedValue(app!, webContentsId, '#message'))
      .toBe(`Plugin Workload SDK Desktop validation ${marker}.`)
    await activateEmbedded(app, webContentsId, '#notify')
    await expect
      .poll(() => embeddedText(app!, webContentsId, '#notify-out'), { timeout: 30_000 })
      .toMatch(/"notificationId"\s*:\s*"[0-9a-f-]{36}"/i)
    const notificationResult = await embeddedText(app, webContentsId, '#notify-out')
    const notificationId = notificationResult.match(
      /"notificationId"\s*:\s*"([0-9a-f-]{36})"/i
    )?.[1]
    expect(notificationId).toBeTruthy()
    await expect
      .poll(() => latestSdkInvocationStatus(fixture, 'clientNotifications'), { timeout: 30_000 })
      .toMatch(/^(accepted|delivered)$/)
    await expect
      .poll(() => notificationDeliverySignal(notificationId!), { timeout: 30_000 })
      .toMatch(/^plugin_workload_sdk\.notification\|(queued|retrying|sent)$/)

    // Prove the end-user journey in the Desktop shell, not only the embedded
    // app response or the persisted delivery signal: the notification must be
    // visible in the authenticated inbox with the unique marker from this run.
    await test.step('open the Desktop notification inbox and read the delivered item', async () => {
      const bell = page!.getByTestId('notification-bell')
      await expect(bell).toBeVisible({ timeout: 20_000 })
      await bell.click()
      await expect(bell).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })
      const inbox = page!.getByRole('dialog', { name: 'Notifications and approvals' })
      await expect(inbox).toBeVisible({ timeout: 20_000 })
      const deliveredItem = inbox
        .getByTestId('notification-menu-item')
        .filter({ hasText: `Plugin Workload SDK Desktop validation ${marker}.` })
      await expect(deliveredItem).toBeVisible({ timeout: 30_000 })
      await expect(inbox).not.toContainText('No notifications or pending approvals right now.')
      await bell.click()
      await expect(bell).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 })
    })

    if (CAPTURE_VISUALS) {
      await page.screenshot({
        path: testInfo.outputPath('desktop-app-sandbox-ui-complete.png'),
        fullPage: true,
      })
      await captureDesktopWindow(
        app,
        testInfo.outputPath('desktop-app-sandbox-ui-window-complete.png')
      )
      await captureEmbeddedView(
        app,
        webContentsId,
        testInfo.outputPath('desktop-app-sandbox-ui-webcontents-complete.png')
      )
      await attachVisualLayout(page, app, webContentsId, testInfo, 'complete')
    }

    // Renderer chrome + native view both remain alive after the two backend
    // operations, proving the Desktop Apps path rather than a direct proxy call.
    await expect(page.getByRole('button', { name: 'Back to apps' })).toBeVisible()
    expect(await findSandboxUiContents(app, fixture)).toMatchObject({ id: webContentsId })
    await page.getByRole('button', { name: 'Back to apps' }).click()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
  } finally {
    await finalizeRecording(app, page)
  }
})
