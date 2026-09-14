/**
 * Contract: prepared isolated user/agent/subscription and unapproved fixture
 * connector -> visible Control UI login/configuration/approval -> isolated
 * Desktop login/chat -> persisted MCP receipt -> visible revocation -> denial.
 * Every transition checks UI/state and the saved binding or actual MCP result.
 * E2E_GUARDIAN_ENTRY_POINT: Control UI starts at its application root.
 * E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process login and chat IPC.
 * Completed messages and MCP evidence replace renderer response waits. Tests
 * never inject IPC calls or authentication. Only the external model is faked.
 */
import { type Page, expect, test } from '@playwright/test'
import {
  type Scenario,
  localUrl,
  readEvidence,
  readUpstreamEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { launchDesktopApp } from '../helpers/launch-desktop'
import { loginControlUiVisible } from '../helpers/visible-login'
import { AgentListPage, AgentModelPage, ControlUiShell } from '../pages/codex-subscription'

const cases = scenarios()
const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
// Read-only comparison across serial scenarios with identical native capabilities.
let advertisedBaseline: { definitionCount: number; definitionBytes: number } | undefined
if (!['deterministic', 'real'].includes(mode))
  throw new Error('APPROVED_TOOLS_UPSTREAM_MODE must be deterministic or real')
if (mode === 'real' && process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
  throw new Error('Real subscription requires explicit CODEX_REAL_UPSTREAM_CONFIRM=1')
for (const key of [
  'TEST_ADMIN_USERNAME',
  'TEST_ADMIN_PASSWORD',
  'TEST_USER_EMAIL',
  'TEST_USER_PASSWORD',
])
  required(key)
for (const key of ['EXTERNAL_REST_API_BASE_URL', 'RPC_PROXY_BASE_URL']) localUrl(required(key))
if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true')
  throw new Error('Verified Desktop build is required; this lane never skips')

async function saveConnector(page: Page, scenario: Scenario, remove: boolean) {
  const response = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === `/api/v1/admin/contexts/${scenario.contextName}` &&
      response.request().method() === 'PUT'
  )
  if (remove) {
    await page
      .getByRole('alertdialog', { name: 'Remove connector from this agent?' })
      .getByRole('button', { name: 'Remove connector', exact: true })
      .click()
  } else {
    await page
      .getByRole('dialog', { name: 'Add connectors' })
      .getByRole('button', { name: 'Add connector', exact: true })
      .click()
  }
  const saved = await response
  expect(saved.ok()).toBe(true)
  const body = await saved.json()
  expect(body.metadata.name).toBe(scenario.contextName)
  expect(body.spec.mcpServers.includes(scenario.connectorName)).toBe(!remove)
  await expect(page.getByText('Connectors updated.', { exact: true })).toBeVisible()
  const row = page
    .getByRole('row')
    .filter({ has: page.getByText(scenario.connectorName, { exact: true }) })
  if (remove) await expect(row).toHaveCount(0)
  else await expect(row).toBeVisible()
}

async function send(page: Page, prompt: string) {
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await page.getByTestId('chat-input').fill(prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('message-list').getByText(prompt, { exact: true })).toBeVisible()
}

test('unauthenticated agent route guard prevents connector use', async ({ page }) => {
  const scenario = cases[0]!
  const before = await readEvidence(scenario)
  // Negative protected-route guard: direct navigation must not open the editor.
  await page.goto(`/agents/${scenario.agentName}/connectors`)
  await expect(page.getByLabel('Username or email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Main navigation')).toHaveCount(0)
  expect((await readEvidence(scenario)).calls).toEqual(before.calls)
})

for (const scenario of cases) {
  test(`approved tools ${scenario.catalogSize}: selective receipt and revoked connector`, async ({
    page,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'upstream', description: mode })
    await test.step('Sign in at Control UI root and select the isolated agent', async () => {
      expect((await readEvidence(scenario)).calls).toEqual([])
      await page.goto('/')
      await loginControlUiVisible(page)
      await new ControlUiShell(page).openAgents()
      await new AgentListPage(page).openNamed(scenario.agentName)
      await expect(page.getByText(`Agent: ${scenario.agentName}`, { exact: true })).toBeVisible()
    })
    await test.step('Select the prepared subscription and persist its model binding', async () => {
      const model = new AgentModelPage(page)
      await model.openEditor()
      await model.chooseSubscription(scenario.subscriptionName)
      await page.getByLabel('Current model', { exact: true }).click()
      await page.getByRole('option', { name: scenario.modelName, exact: true }).click()
      const host = await model.saveHost(scenario.agentName)
      const savedPolicy = (host.spec as { llmPolicy?: { fallbacks: unknown[] } } | undefined)
        ?.llmPolicy
      expect(
        savedPolicy?.fallbacks ?? [],
        'isolated agent must not fall back to another provider'
      ).toEqual([])
      expect(host.spec?.model).toMatchObject({
        provider: 'codex-subscription',
        name: scenario.modelName,
        connectionRef: scenario.connectionKey,
      })
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
      await expect(model.credentialSelect()).toBeDisabled()
    })
    await test.step('Approve the fixture connector through its picker', async () => {
      await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/agents/${scenario.agentName}/connectors$`))
      await expect(page.getByText('No connectors attached yet.', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Add connector', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add connectors' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('option', { name: scenario.connectorName, exact: true }).click()
      await saveConnector(page, scenario, false)
    })
    const app = await launchDesktopApp()
    try {
      const desktop = await app.firstWindow()
      await test.step('Sign in visibly to Desktop and start a chat with the same agent', async () => {
        await expect(desktop.getByLabel('Email', { exact: true })).toBeVisible()
        await desktop.getByLabel('Email', { exact: true }).fill(required('TEST_USER_EMAIL'))
        await desktop.getByLabel('Password', { exact: true }).fill(required('TEST_USER_PASSWORD'))
        await desktop.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(desktop.getByTestId('nav-chat')).toBeVisible()
        await desktop.getByTestId('nav-chat').click()
        await desktop.getByTestId('nav-new-chat').click()
        await expect(
          desktop.getByRole('heading', { name: 'New chat with', exact: true })
        ).toBeVisible()
        await desktop.getByRole('button', { name: 'Switch chat agent', exact: true }).click()
        await desktop
          .getByRole('menuitem', { name: scenario.agentDisplayName, exact: true })
          .click()
        await expect(
          desktop.getByRole('button', { name: 'Switch chat agent', exact: true })
        ).toContainText(scenario.agentDisplayName)
        await desktop.getByRole('button', { name: 'Model — Select model', exact: true }).click()
        const modelOption = desktop
          .getByRole('menuitemradio')
          .filter({ hasText: scenario.modelLabel })
        await expect(modelOption).toHaveCount(1)
        await modelOption.click()
        await expect(
          desktop.getByRole('button', { name: `Model — ${scenario.modelLabel}`, exact: true })
        ).toBeVisible()
        await expect(desktop.getByTestId('agent-response')).toHaveCount(0)
      })
      await test.step('Find only the verification receipt tool and return its real business ID', async () => {
        const upstreamBefore =
          mode === 'deterministic' ? await readUpstreamEvidence(scenario) : undefined
        const started = Date.now()
        await send(
          desktop,
          'Find the verification receipt tool in my approved connectors. Describe only that tool, call it once, and report its exact businessId. Do not call other business tools or invent a receipt.'
        )
        await expect
          .poll(async () => (await readEvidence(scenario)).calls.length, { timeout: 120_000 })
          .toBe(1)
        const evidence = await readEvidence(scenario)
        const call = evidence.calls[0]!
        expect(call).toMatchObject({ runId: scenario.runId, tool: 'workitem_read_receipt' })
        expect(call.businessId).toMatch(/^[0-9a-f-]{36}$/)
        await expect(
          desktop.getByTestId('agent-response').filter({ hasText: call.businessId })
        ).toBeVisible({ timeout: 120_000 })
        await expect(desktop.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
        expect((await readEvidence(scenario)).calls).toEqual(evidence.calls)
        if (upstreamBefore) {
          const upstreamAfter = await readUpstreamEvidence(scenario)
          expect(upstreamAfter.rejected).toBe(upstreamBefore.rejected)
          expect(upstreamAfter.searchCalls - upstreamBefore.searchCalls).toBe(1)
          expect(upstreamAfter.describeCalls - upstreamBefore.describeCalls).toBe(1)
          expect(upstreamAfter.businessCalls - upstreamBefore.businessCalls).toBe(1)
          expect(upstreamAfter.finalResponses - upstreamBefore.finalResponses).toBe(1)
          const requests = upstreamAfter.requests.slice(upstreamBefore.requests.length)
          expect(requests.map(request => request.stage)).toEqual([
            'clerum__tool_search',
            'clerum__tool_describe',
            'clerum__tool_call',
            'final',
          ])
          for (const request of requests) {
            expect(request.connectorDefinitionCount).toBe(0)
            expect(request.leakedSchema).toBe(false)
            expect(request.inputBytes).toBeGreaterThan(0)
            expect(request.definitionCount).toBeGreaterThanOrEqual(3)
            expect(request.definitionBytes).toBeGreaterThan(0)
            const advertised = {
              definitionCount: request.definitionCount,
              definitionBytes: request.definitionBytes,
            }
            advertisedBaseline ??= advertised
            expect(advertised, 'announced definitions must not grow with catalogue size').toEqual(
              advertisedBaseline
            )
          }
          await testInfo.attach('upstream-request-measurements', {
            body: JSON.stringify({
              upstream: mode,
              catalogSize: scenario.catalogSize,
              requests,
              elapsedMs: Date.now() - started,
              inputTokens: null,
              outputTokens: null,
              subscriptionUsage: null,
            }),
            contentType: 'application/json',
          })
        }
        await testInfo.attach('mcp-receipt-evidence', {
          body: JSON.stringify(evidence),
          contentType: 'application/json',
        })
      })
      await test.step('Revoke through Control UI and deny the next call in the existing chat', async () => {
        const before = await readEvidence(scenario)
        const upstreamBefore =
          mode === 'deterministic' ? await readUpstreamEvidence(scenario) : undefined
        await page
          .getByRole('button', {
            name: `Actions for connector ${scenario.connectorName}`,
            exact: true,
          })
          .click()
        await page.getByRole('menuitem', { name: 'Remove connector', exact: true }).click()
        await expect(
          page.getByRole('alertdialog', { name: 'Remove connector from this agent?' })
        ).toBeVisible()
        await saveConnector(page, scenario, true)
        await send(
          desktop,
          'Try reading the verification receipt again using the same tool. If access has been revoked or the tool is unavailable, reply exactly CONNECTOR_UNAVAILABLE. Never reuse the earlier receipt as a new result.'
        )
        const denied = mode === 'real' ? 'CONNECTOR_UNAVAILABLE' : '"found":0'
        await expect(desktop.getByTestId('agent-response').filter({ hasText: denied })).toBeVisible(
          { timeout: 120_000 }
        )
        await expect(desktop.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
        expect((await readEvidence(scenario)).calls).toEqual(before.calls)
        if (upstreamBefore) {
          const upstreamAfter = await readUpstreamEvidence(scenario)
          expect(upstreamAfter.rejected).toBe(upstreamBefore.rejected)
          expect(upstreamAfter.businessCalls).toBe(upstreamBefore.businessCalls)
          expect(upstreamAfter.deniedResponses - upstreamBefore.deniedResponses).toBe(1)
          const requests = upstreamAfter.requests.slice(upstreamBefore.requests.length)
          expect(requests.map(request => request.stage)).toEqual(['clerum__tool_search', 'denied'])
          for (const request of requests) {
            expect(request.connectorDefinitionCount).toBe(0)
            expect(request.leakedSchema).toBe(false)
          }
          await testInfo.attach('upstream-revocation-evidence', {
            body: JSON.stringify({ upstream: mode, requests }),
            contentType: 'application/json',
          })
        }
      })
    } finally {
      await app.close()
    }
  })
}
