/**
 * Only the external OAuth verification page is simulated. Grant creation,
 * encrypted device state, polling, catalog publication and assignment all use
 * real Control API routes. The isolated OAuth provider has preapproved consent.
 * Real-account mode uses the explicitly prepared existing grant unchanged.
 */
import { type Page, type Route, expect } from '@playwright/test'
import { beginConnectionCapture } from '../../../../scripts/e2e/approved-tools-connection-journal.mjs'
import { ControlUiShell, SecretsLlmSubscriptionsPage } from '../pages/codex-subscription'
import { type Scenario, required } from './approved-tools-scenarios'

const verificationUrl = 'https://auth.openai.com/codex/device'

export async function prepareSubscriptionVisible(page: Page, scenario: Scenario): Promise<string> {
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') === 'real') {
    if (!scenario.connectionKey || scenario.connectionKey === 'unassigned')
      throw new Error('Real mode requires an existing approved subscription grant')
    return scenario.connectionKey
  }
  await new ControlUiShell(page).openSecretsLlmSubscriptions()
  const subscriptions = new SecretsLlmSubscriptionsPage(page)
  const scenarioLabel = scenario.runId.split('-').at(-1)!
  const run = scenario.runId.slice(0, -(scenarioLabel.length + 1))
  const capture = beginConnectionCapture(required('APPROVED_TOOLS_EVIDENCE_DIR'), {
    run,
    profile: required('MINIKUBE_PROFILE'),
    context: required('CONTROL_API_REAL_PG_CONTEXT'),
    scenario: scenarioLabel,
    fixtureUserId: required('APPROVED_TOOLS_FIXTURE_USER_ID'),
  })
  let connectionKey: string
  try {
    connectionKey = await subscriptions.createGrant(scenario.subscriptionName, metadata =>
      capture.record(metadata)
    )
  } finally {
    capture.close()
  }
  expect(connectionKey).not.toBe('unassigned')
  const context = page.context()
  const externalConsent = async (route: Route) => {
    expect(route.request().url()).toBe(verificationUrl)
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Isolated OAuth consent</title><h1>Isolated OAuth consent</h1><p>Consent belongs to the synthetic account provisioned for this local test.</p>',
    })
  }
  // Exact external URL only; no Control UI/API route or browser session is mocked.
  await context.route(verificationUrl, externalConsent)
  let popup: Page | undefined
  try {
    const popupOpened = context.waitForEvent('page')
    const started = page.waitForResponse(
      response =>
        new URL(response.url()).pathname ===
          `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/device/start` &&
        response.request().method() === 'POST'
    )
    const connected = page.waitForResponse(
      async response => {
        if (
          new URL(response.url()).pathname !==
            `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/device/poll` ||
          response.request().method() !== 'GET' ||
          !response.ok()
        )
          return false
        return (await response.json()).status === 'connected'
      },
      { timeout: 120_000 }
    )
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Sign in with ChatGPT', exact: true })
      .click()
    popup = await popupOpened
    await expect(popup).toHaveURL(verificationUrl)
    await expect(
      popup.getByRole('heading', { name: 'Isolated OAuth consent', exact: true })
    ).toBeVisible()
    expect((await started).ok()).toBe(true)
    const result = await (await connected).json()
    expect(result.connection).toMatchObject({ connectionKey, catalogStatus: 'ready' })
    await expect(page.getByTestId('codex-device-code')).toHaveCount(0)
    await expect(page.getByLabel(scenario.modelName, { exact: true })).toBeVisible()
    await expect(page.getByLabel(scenario.modelName, { exact: true })).toBeChecked()
    await subscriptions.closeConnectModal()
    await expect(subscriptions.grantRow(scenario.subscriptionName)).toBeVisible()
    return connectionKey
  } finally {
    if (popup && !popup.isClosed()) await popup.close()
    await context.unroute(verificationUrl, externalConsent)
  }
}
