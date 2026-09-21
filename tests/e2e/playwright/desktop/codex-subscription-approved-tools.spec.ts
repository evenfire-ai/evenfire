/**
 * Contract: prepared isolated user/agent/subscription and unapproved fixture
 * connector -> visible Control UI login/configuration/approval -> isolated
 * Desktop login/chat -> persisted MCP receipt -> visible revocation -> denial.
 * Every transition checks UI/state and the saved binding or actual MCP result.
 * E2E_GUARDIAN_ENTRY_POINT: Control UI starts at its application root.
 * E2E_GUARDIAN_IPC_FLOW: Desktop uses real main-process login and chat IPC.
 * Completed messages and MCP evidence replace renderer response waits. Tests
 * never inject IPC calls or authentication. Only the external OAuth and model
 * providers are simulated in deterministic mode.
 */
import { type Page, expect, test } from '@playwright/test'
import { readAgentDeploymentGeneration, waitForAgentRollout } from '../helpers/agent-rollout'
import {
  type Scenario,
  type UpstreamEvidence,
  browserApiPath,
  localUrl,
  readEvidence,
  readUpstreamEvidence,
  required,
  scenarios,
} from '../helpers/approved-tools-scenarios'
import { prepareSubscriptionVisible } from '../helpers/approved-tools-subscription'
import { workflowJourney } from '../helpers/approved-tools-workflow'
import { expectSignedOutLaunch, signOutDesktop } from '../helpers/desktop-session'
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
      new URL(response.url()).pathname ===
        browserApiPath(`/api/v1/admin/contexts/${scenario.contextName}`) &&
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

test('native workflow: visible approval, trigger, status and result artifact', async ({
  page,
}, testInfo) => {
  await workflowJourney(page, testInfo)
})

async function send(page: Page, prompt: string) {
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await page.getByTestId('chat-input').fill(prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('message-list').getByText(prompt, { exact: true })).toBeVisible()
}

async function newAgentResponses(page: Page) {
  const responses = page.getByTestId('agent-response')
  // Snapshot stable message identities before sending; previous turns must not
  // satisfy the new turn's result, even when their visible text is identical.
  const previousIds = await responses.evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-chat-message-id'))
  )
  expect(previousIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  const exclusions = previousIds
    .map(id => `:not([data-chat-message-id=${JSON.stringify(id)}])`)
    .join('')
  return responses.and(page.locator(`[data-chat-message-id]${exclusions}`))
}

async function openAgentChat(desktop: Page, scenario: Scenario) {
  await expectSignedOutLaunch(desktop)
  await desktop.getByLabel('Email', { exact: true }).fill(required('TEST_USER_EMAIL'))
  await desktop.getByLabel('Password', { exact: true }).fill(required('TEST_USER_PASSWORD'))
  await desktop.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(desktop.getByTestId('nav-chat')).toBeVisible()
  await desktop.getByTestId('nav-chat').click()
  await desktop.getByTestId('nav-new-chat').click()
  await expect(
    desktop.getByRole('heading', { name: 'Start a new conversation with:', exact: true })
  ).toBeVisible()
  await desktop.getByRole('button', { name: 'Switch chat agent', exact: true }).click()
  await desktop.getByRole('menuitem', { name: scenario.agentDisplayName, exact: true }).click()
  await expect(
    desktop.getByRole('button', { name: 'Switch chat agent', exact: true })
  ).toContainText(scenario.agentDisplayName)
  await desktop.getByRole('button', { name: 'Model — Select model', exact: true }).click()
  const modelOption = desktop.getByRole('menuitemradio').filter({ hasText: scenario.modelLabel })
  await expect(modelOption).toHaveCount(1)
  await modelOption.click()
  await expect(
    desktop.getByRole('button', { name: `Model — ${scenario.modelLabel}`, exact: true })
  ).toBeVisible()
  await expect(desktop.getByTestId('agent-response')).toHaveCount(0)
}

async function receiptApproval(page: Page, scenario: Scenario, previousCalls: number) {
  const pending = page
    .getByTestId('progress-stepper')
    .filter({ has: page.getByTestId('approval-approve-btn') })
  await expect(pending).toHaveCount(1)
  await expect(pending).toContainText('workitem_read_receipt')
  await expect(pending).toContainText('requires approval')
  await expect(pending).not.toContainText('clerum__tool_call requires approval')
  expect((await readEvidence(scenario)).calls).toHaveLength(previousCalls)
  return pending
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

test('authenticated user without agent access cannot select the protected agents', async () => {
  const before = await Promise.all(cases.map(readEvidence))
  const app = await launchDesktopApp()
  let journeyPassed = false
  try {
    const page = await app.firstWindow()
    await expectSignedOutLaunch(page)
    await page
      .getByLabel('Email', { exact: true })
      .fill(required('APPROVED_TOOLS_UNAUTHORIZED_EMAIL'))
    await page
      .getByLabel('Password', { exact: true })
      .fill(required('APPROVED_TOOLS_UNAUTHORIZED_PASSWORD'))
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    // Agents, Connectors and Plugins are menu items of the Settings submenu and
    // are not rendered while it is collapsed (SidebarNav renders them under
    // `settingsMenuOpen`), so the journey opens it the way a user does.
    await expect(page.getByTestId('nav-settings-menu')).toHaveAttribute('aria-expanded', 'false')
    await page.getByTestId('nav-settings-menu').click()
    await expect(page.getByTestId('nav-settings-menu')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('nav-agents')).toBeVisible()
    await page.getByTestId('nav-agents').click()
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'No agents available', exact: true })
    ).toBeVisible()
    for (const scenario of cases) {
      await expect(page.getByText(scenario.agentDisplayName, { exact: true })).toHaveCount(0)
    }
    await page.getByTestId('nav-chat').click()
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
    await expect(
      page.getByText('You do not currently have authorized agents in this team.', { exact: true })
    ).toBeVisible()
    await expect(page.getByTestId('chat-input')).toHaveCount(0)
    await expect(page.getByTestId('send-button')).toHaveCount(0)
    expect(await Promise.all(cases.map(readEvidence))).toEqual(before)
    // Sign out before the window closes. The session token lives in the macOS
    // Keychain, keyed by the REST+RPC origin, which a fresh --user-data-dir does
    // not isolate: leaving it behind signs the next launch in as this
    // unauthorized user, and the next test's login form never renders. Signing
    // out is part of this journey, so a failure here fails this test rather
    // than the one that inherits the session.
    await page.getByTestId('nav-settings-menu').click()
    await page.getByTestId('logout-btn').click()
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
    journeyPassed = true
  } finally {
    try {
      await app.close()
    } catch {
      if (journeyPassed) throw new Error('Desktop cleanup failed')
      // Preserve the original assertion failure when cleanup also fails.
    }
  }
})

for (const scenario of cases) {
  test(`approved tools ${scenario.catalogSize}: ordinary discovery, reuse, approval decisions and revocation`, async ({
    page,
  }, testInfo) => {
    testInfo.annotations.push({ type: 'upstream', description: mode })
    await test.step('Sign in at Control UI root and select the isolated agent', async () => {
      expect((await readEvidence(scenario)).calls).toEqual([])
      await page.goto('/')
      await loginControlUiVisible(page)
      scenario.connectionKey = await prepareSubscriptionVisible(page, scenario)
      await new ControlUiShell(page).openAgents()
      await new AgentListPage(page).openNamed(scenario.agentName)
      // The detail header leads with the agent's display name, not the route
      // slug: `control-ui/app/hosts/[name]/page.tsx:1201` renders
      // `Agent: ${hostDisplaySaved || routeName}` since `313ddeb26`, and every
      // fixture agent is created with a display name. Asserting the heading
      // role also keeps this off the loading skeleton, which carries
      // `role=progressbar` while the first Overview read is in flight.
      await expect(
        page.getByRole('heading', { name: `Agent: ${scenario.agentDisplayName}`, exact: true })
      ).toBeVisible()
    })
    // Recorded before the save so the wait below can prove the rollout it
    // waits for is the one this test caused, not one that was already done.
    let rolloutBaseline = 0
    await test.step('Select the prepared subscription and persist its model binding', async () => {
      const model = new AgentModelPage(page)
      rolloutBaseline = readAgentDeploymentGeneration(scenario.agentName)
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
    await test.step('Wait for the agent rollout the model binding triggered', async () => {
      await waitForAgentRollout(scenario.agentName, rolloutBaseline)
    })
    const app = await launchDesktopApp()
    const corpusStarted = Date.now()
    const completedTasks: string[] = []
    let corpusOutcome = 'failed'
    try {
      const desktop = await app.firstWindow()
      await test.step('Sign in visibly to Desktop and start a chat with the same agent', async () => {
        await openAgentChat(desktop, scenario)
      })
      await test.step('Find only the verification receipt tool and return its real business ID', async () => {
        const upstreamBefore =
          mode === 'deterministic' ? await readUpstreamEvidence(scenario) : undefined
        const started = Date.now()
        await send(desktop, 'Show my verification receipt and its business ID.')
        const pending = await receiptApproval(desktop, scenario, 0)
        await pending.getByTestId('approval-approve-btn').click()
        await expect(pending).toHaveCount(0)
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
            expect(request.explicitNonStrictCount).toBe(request.definitionCount)
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
        completedTasks.push('ordinary-receipt')
      })
      await test.step('Repeat an ordinary request using the current schema without rediscovering it', async () => {
        const before = await readEvidence(scenario)
        const upstreamBefore =
          mode === 'deterministic' ? await readUpstreamEvidence(scenario) : undefined
        const started = Date.now()
        await send(desktop, 'Show my verification receipt again.')
        const pending = await receiptApproval(desktop, scenario, 1)
        await pending.getByTestId('approval-approve-btn').click()
        await expect(pending).toHaveCount(0)
        await expect
          .poll(async () => (await readEvidence(scenario)).calls.length, { timeout: 120_000 })
          .toBe(2)
        const after = await readEvidence(scenario)
        expect(after.calls.map(call => call.tool)).toEqual([
          'workitem_read_receipt',
          'workitem_read_receipt',
        ])
        // MCP JSON-RPC ids are connection-local and may be reused after reconnect;
        // the two separately completed turns and exact call count prove reuse.
        await expect(
          desktop.getByTestId('agent-response').filter({ hasText: before.calls[0]!.businessId })
        ).toHaveCount(2)
        await expect(desktop.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
        let requests = null
        if (upstreamBefore) {
          const after = await readUpstreamEvidence(scenario)
          expect(after.rejected).toBe(upstreamBefore.rejected)
          expect(after.describeCalls).toBe(upstreamBefore.describeCalls)
          expect(after.searchCalls).toBe(upstreamBefore.searchCalls)
          expect(after.businessCalls - upstreamBefore.businessCalls).toBe(1)
          requests = after.requests.slice(upstreamBefore.requests.length)
          expect(requests.map(request => request.stage)).toEqual(['clerum__tool_call', 'final'])
          for (const request of requests) {
            expect(request.connectorDefinitionCount).toBe(0)
            expect(request.leakedSchema).toBe(false)
            expect(request.explicitNonStrictCount).toBe(request.definitionCount)
          }
        }
        await testInfo.attach('repeat-task-metrics', {
          body: JSON.stringify({
            mode,
            catalogSize: scenario.catalogSize,
            outcome: 'receipt-read',
            businessCalls: 1,
            requests,
            elapsedMs: Date.now() - started,
            inputTokens: null,
            outputTokens: null,
          }),
          contentType: 'application/json',
        })
        completedTasks.push('repeat-receipt')
      })
      for (const decision of ['deny', 'cancel'] as const) {
        await test.step(`${decision} the real tool approval without executing the connector`, async () => {
          const before = await readEvidence(scenario)
          const cancelled = desktop.getByTestId('progress-stepper').filter({ hasText: 'Cancelled' })
          const cancelledBefore = await cancelled.count()
          const responses = await newAgentResponses(desktop)
          await send(
            desktop,
            decision === 'deny'
              ? 'Please read my verification receipt once more.'
              : 'Please fetch my verification receipt now.'
          )
          const pending = await receiptApproval(desktop, scenario, 2)
          await pending
            .getByTestId(decision === 'deny' ? 'approval-deny-btn' : 'progress-cancel-btn')
            .click()
          await expect(pending).toHaveCount(0)
          if (decision === 'deny') {
            // Deny completes the turn locally; it does not cancel or request a
            // follow-up response from the upstream model.
            await expect(responses).toHaveCount(1)
            await expect(responses).toBeVisible()
            await expect(responses).toContainText('workitem_read_receipt')
            await expect(responses).toContainText(
              'was denied by the user. The operation was not performed.'
            )
            await expect(cancelled).toHaveCount(cancelledBefore)
          } else {
            await expect(cancelled).toHaveCount(cancelledBefore + 1)
          }
          await expect(desktop.getByTestId('send-button')).toHaveAttribute(
            'aria-label',
            'Send message'
          )
          expect((await readEvidence(scenario)).calls).toEqual(before.calls)
          completedTasks.push(decision)
        })
      }
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
        // Reopen through navigation so an optimistic PUT echo cannot stand in
        // for persisted removal from this agent's exact context binding.
        await new ControlUiShell(page).openAgents()
        const persistedDetail = page.waitForResponse(
          response =>
            new URL(response.url()).pathname ===
              browserApiPath(`/api/v1/admin/hosts/${scenario.agentName}/detail`) &&
            response.request().method() === 'GET'
        )
        await new AgentListPage(page).openNamed(scenario.agentName)
        const detailResponse = await persistedDetail
        expect(detailResponse.ok()).toBe(true)
        const detail = await detailResponse.json()
        expect(detail.host.metadata.name).toBe(scenario.agentName)
        expect(detail.host.spec.contextRef).toBe(scenario.contextName)
        const boundContexts = detail.contexts.filter(
          (context: { metadata: { name: string } }) =>
            context.metadata.name === scenario.contextName
        )
        expect(boundContexts).toHaveLength(1)
        expect(boundContexts[0].spec.mcpServers).not.toContain(scenario.connectorName)
        await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/agents/${scenario.agentName}/connectors$`))
        await expect(page.getByText('No connectors attached yet.', { exact: true })).toBeVisible()
        const responses = await newAgentResponses(desktop)
        await send(desktop, 'Show my verification receipt again, please.')
        const denied =
          mode === 'real'
            ? /unavailable|not available|no longer|cannot access|could not find|not found/i
            : /"found"\s*:\s*0/
        await expect(responses).toHaveCount(1, { timeout: 120_000 })
        await expect(responses).toBeVisible()
        await expect(responses).toContainText(denied, { timeout: 120_000 })
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
            expect(request.explicitNonStrictCount).toBe(request.definitionCount)
          }
          await testInfo.attach('upstream-revocation-evidence', {
            body: JSON.stringify({ upstream: mode, requests }),
            contentType: 'application/json',
          })
        }
        completedTasks.push('revoked-receipt')
      })
      corpusOutcome = 'passed'
    } finally {
      const cleanupFailures: string[] = []
      try {
        const desktop = await app.firstWindow()
        // Read-only measurement snapshot, not a readiness or correctness assertion.
        // Preserve exact provider-reported UI figures; never infer tokens from bytes.
        const reportedTokenLabels = await desktop
          .getByLabel(/^Turn token usage/)
          .evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
        await testInfo.attach('provider-parity-corpus', {
          body: JSON.stringify({
            mode,
            catalogSize: scenario.catalogSize,
            outcome: corpusOutcome,
            completedTasks,
            elapsedMs: Date.now() - corpusStarted,
            reportedTokenLabels,
            subscriptionUsage: null,
          }),
          contentType: 'application/json',
        })
      } catch {
        cleanupFailures.push('measurement unavailable')
      }
      try {
        await signOutDesktop(await app.firstWindow())
      } catch {
        cleanupFailures.push('Desktop sign-out failed; the session stays in the Keychain')
      }
      try {
        await app.close()
      } catch {
        cleanupFailures.push('Desktop cleanup failed')
      }
      if (cleanupFailures.length) {
        testInfo.annotations.push({ type: 'cleanup', description: cleanupFailures.join('; ') })
        if (corpusOutcome === 'passed') throw new Error(cleanupFailures.join('; '))
      }
    }
  })
}

// Only the deterministic upstream can answer with more function calls than the
// contract allows, or with exactly that many, so these cases are registered in
// deterministic mode only. They run after the approved-tools journeys and reuse
// the first prepared agent, whose subscription model binding those journeys
// persisted.
if (mode === 'deterministic') {
  test('tool call limit: Desktop shows Too Many Tool Calls without retry or connector call', async () => {
    const scenario = cases[0]!
    const before = await readEvidence(scenario)
    // Witness for the negative connector assertion below: the receipt journey
    // of this run executed the connector through the same fixture.
    expect(before.calls.map(call => call.tool)).toEqual([
      'workitem_read_receipt',
      'workitem_read_receipt',
    ])
    const upstreamBefore = await readUpstreamEvidence(scenario)
    const app = await launchDesktopApp()
    let journeyPassed = false
    try {
      const desktop = await app.firstWindow()
      await test.step('Sign in visibly to Desktop and start a chat with the prepared agent', async () => {
        await openAgentChat(desktop, scenario)
      })
      const responses = await newAgentResponses(desktop)
      await test.step('Send the tool call limit probe and wait for the completed turn', async () => {
        await send(desktop, 'tool call limit probe')
        await expect(responses).toHaveCount(1, { timeout: 120_000 })
        await expect(desktop.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
      })
      await test.step('The assistant message is in the error state', async () => {
        await expect(responses).toHaveClass(/(^|\s)chat-bubble--error(\s|$)/)
      })
      await test.step('The error names the tool-call limit, not an overloaded model', async () => {
        // The label div appends the provider that raised the error.
        await expect(responses.locator('.error-bubble-label')).toHaveText(
          'Too Many Tool Calls · CODEX-SUBSCRIPTION'
        )
        await expect(responses.getByText('Model Overloaded')).toHaveCount(0)
      })
      await test.step('One upstream completion, no retry, no connector call', async () => {
        const upstreamAfter = await readUpstreamEvidence(scenario)
        expect(upstreamAfter.limitProbe.turns - upstreamBefore.limitProbe.turns).toBe(1)
        expect(upstreamAfter.limitProbe.completions - upstreamBefore.limitProbe.completions).toBe(1)
        expect(upstreamAfter.limitProbe.unexpectedRetries).toBe(0)
        expect(upstreamAfter.rejected).toBe(upstreamBefore.rejected)
        const requests = upstreamAfter.requests.slice(upstreamBefore.requests.length)
        expect(requests.map(request => request.stage)).toEqual(['limit_probe'])
        expect((await readEvidence(scenario)).calls).toEqual(before.calls)
      })
      journeyPassed = true
    } finally {
      // Sign out before closing: the session lives in the host Keychain, so a
      // window closed while authenticated signs the next launch in and that
      // launch never renders a login form.
      let cleanupError: string | undefined
      try {
        await signOutDesktop(await app.firstWindow())
      } catch {
        cleanupError = 'Desktop sign-out failed; the session stays in the Keychain'
      }
      try {
        await app.close()
      } catch {
        cleanupError = cleanupError
          ? `${cleanupError}; Desktop cleanup failed`
          : 'Desktop cleanup failed'
      }
      // Raise cleanup problems only when the journey passed; otherwise the
      // original assertion failure is the one worth reporting.
      if (cleanupError && journeyPassed) throw new Error(cleanupError)
    }
  })

  test('tool call limit boundary: Desktop completes a turn of exactly 256 tool calls', async () => {
    const scenario = cases[0]!
    const before = await readEvidence(scenario)
    const upstreamBefore = await readUpstreamEvidence(scenario)
    const app = await launchDesktopApp()
    let journeyPassed = false
    try {
      const desktop = await app.firstWindow()
      await test.step('Sign in visibly to Desktop and start a chat with the prepared agent', async () => {
        await openAgentChat(desktop, scenario)
      })
      const responses = await newAgentResponses(desktop)
      await test.step('Send the boundary turn and wait for the final answer', async () => {
        await send(desktop, 'tool call limit boundary')
        await expect(responses).toHaveCount(1, { timeout: 240_000 })
        await expect(responses).toContainText(
          'Tool call limit boundary complete: 256 tool results received.',
          { timeout: 240_000 }
        )
        await expect(desktop.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
      })
      await test.step('The answer is not an error and names no tool-call limit', async () => {
        await expect(responses).not.toHaveClass(/(^|\s)chat-bubble--error(\s|$)/)
        await expect(responses.getByText(/Too Many Tool Calls/)).toHaveCount(0)
      })
      await test.step('All 256 results reached the model once, with no retry', async () => {
        const upstreamAfter = await readUpstreamEvidence(scenario)
        const delta = (field: keyof UpstreamEvidence['limitBoundary']) =>
          upstreamAfter.limitBoundary[field] - upstreamBefore.limitBoundary[field]
        expect(delta('turns')).toBe(1)
        expect(delta('completions')).toBe(2)
        expect(delta('toolResults')).toBe(256)
        expect(delta('finalResponses')).toBe(1)
        expect(upstreamAfter.limitBoundary.unexpectedRetries).toBe(0)
        expect(upstreamAfter.rejected).toBe(upstreamBefore.rejected)
        const requests = upstreamAfter.requests.slice(upstreamBefore.requests.length)
        expect(requests.map(request => request.stage)).toEqual([
          'limit_boundary',
          'limit_boundary_final',
        ])
        // The continuation carried 256 calls and 256 results, so its input is
        // far larger than the request that started the turn.
        expect(requests[1]!.inputBytes).toBeGreaterThan(requests[0]!.inputBytes)
        // Only discovery searches ran; the connector was never called.
        expect((await readEvidence(scenario)).calls).toEqual(before.calls)
      })
      journeyPassed = true
    } finally {
      // Sign out before closing: the session lives in the host Keychain, so a
      // window closed while authenticated signs the next launch in and that
      // launch never renders a login form.
      let cleanupError: string | undefined
      try {
        await signOutDesktop(await app.firstWindow())
      } catch {
        cleanupError = 'Desktop sign-out failed; the session stays in the Keychain'
      }
      try {
        await app.close()
      } catch {
        cleanupError = cleanupError
          ? `${cleanupError}; Desktop cleanup failed`
          : 'Desktop cleanup failed'
      }
      // Raise cleanup problems only when the journey passed; otherwise the
      // original assertion failure is the one worth reporting.
      if (cleanupError && journeyPassed) throw new Error(cleanupError)
    }
  })
}
