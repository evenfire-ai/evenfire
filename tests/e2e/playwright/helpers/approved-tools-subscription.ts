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
const devicePath = (connectionKey: string, step: 'start' | 'poll') =>
  `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/device/${step}`
const anyDevicePath = (step: 'start' | 'poll') =>
  new RegExp(`^/api/v1/admin/llm/providers/codex-subscription/connections/[^/]+/device/${step}$`)

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
  //
  // Every listener below is registered BEFORE the Create click, because
  // "Create and set up" is the whole user gesture: handleCreate chains straight
  // into handleConnect, which opens the verification tab itself. A route or a
  // waitForEvent('page') registered after that click arrives too late for the
  // tab it already opened, and that tab then reaches the real auth.openai.com.
  await context.route(verificationUrl, externalConsent)
  let popup: Page | undefined
  try {
    const popupOpened = context.waitForEvent('page')
    // The grant does not exist yet, so neither device path can name its
    // connection key here. Both responses are matched on shape now and checked
    // against the created key below, which keeps the assertion just as strict.
    const started = page.waitForResponse(
      response =>
        anyDevicePath('start').test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST'
    )
    const connected = page.waitForResponse(
      async response => {
        if (
          !anyDevicePath('poll').test(new URL(response.url()).pathname) ||
          response.request().method() !== 'GET' ||
          !response.ok()
        )
          return false
        return (await response.json()).status === 'connected'
      },
      { timeout: 120_000 }
    )
    let connectionKey: string
    try {
      connectionKey = await subscriptions.createGrant(scenario.subscriptionName, metadata =>
        capture.record(metadata)
      )
    } finally {
      capture.close()
    }
    expect(connectionKey).not.toBe('unassigned')
    popup = await popupOpened
    await expect(popup).toHaveURL(verificationUrl)
    await expect(
      popup.getByRole('heading', { name: 'Isolated OAuth consent', exact: true })
    ).toBeVisible()
    const startResponse = await started
    expect(startResponse.ok()).toBe(true)
    expect(new URL(startResponse.url()).pathname).toBe(devicePath(connectionKey, 'start'))
    const connectedResponse = await connected
    expect(new URL(connectedResponse.url()).pathname).toBe(devicePath(connectionKey, 'poll'))
    const result = await connectedResponse.json()
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
