/**
 * E2E_GUARDIAN_ENTRY_POINT: root entry, visible configuration and login.
 * E2E_GUARDIAN_IPC_FLOW: chat and both approval decisions use genuine Desktop
 * IPC. The prepared workflow workload produces a receipt and its JSON artifact;
 * this helper only reads receipt evidence after the real workflow executes.
 */
import { type Page, type TestInfo, expect, test } from '@playwright/test'
import { AgentListPage, AgentModelPage, ControlUiShell } from '../pages/codex-subscription'
import { readAgentDeploymentGeneration, waitForAgentRollout } from './agent-rollout'
import {
  type Scenario,
  browserApiPath,
  localUrl,
  readEvidence,
  readUpstreamEvidence,
  required,
  scenarios,
} from './approved-tools-scenarios'
import { prepareSubscriptionVisible } from './approved-tools-subscription'
import { expectSignedOutLaunch, signOutDesktop } from './desktop-session'
import { launchDesktopApp } from './launch-desktop'
import { loginControlUiVisible } from './visible-login'

type WorkflowScenario = Scenario & { workflowName: string; workflowNamespace: string }

function workflowScenario(): WorkflowScenario {
  const value = JSON.parse(required('APPROVED_TOOLS_WORKFLOW_SCENARIO')) as WorkflowScenario
  for (const key of [
    'agentName',
    'agentDisplayName',
    'contextName',
    'subscriptionName',
    'connectionKey',
    'modelName',
    'workflowName',
    'workflowNamespace',
    'runId',
  ] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim())
      throw new Error(`Missing workflow precondition: ${key}`)
  }
  for (const key of [
    'agentName',
    'contextName',
    'workflowName',
    'workflowNamespace',
    'runId',
  ] as const) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value[key]))
      throw new Error(`Invalid workflow precondition: ${key}`)
  }
  if (![83, 150, 250].includes(value.catalogSize))
    throw new Error('Workflow receipt fixture must use a supported catalog')
  localUrl(value.fixtureUrl)
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') === 'deterministic')
    localUrl(value.upstreamEvidenceUrl)
  if (
    scenarios().some(
      row =>
        row.agentName === value.agentName ||
        row.runId === value.runId ||
        row.fixtureUrl === value.fixtureUrl ||
        (required('APPROVED_TOOLS_UPSTREAM_MODE') === 'deterministic' &&
          row.subscriptionName === value.subscriptionName)
    )
  )
    throw new Error('Workflow fixture must be isolated from receipt scenarios')
  return value
}

export async function workflowJourney(page: Page, testInfo: TestInfo) {
  const scenario = workflowScenario()
  const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
  expect((await readEvidence(scenario)).calls).toEqual([])
  // Saving the model binding changes the runtime-token contract, so HCC rewrites
  // the pod-template annotation `clerum.io/runtime-token-revision`
  // (`host-context-controller/src/hostReconciler.ts:3013`) and the Deployment
  // rolls. The baseline belongs before that save: read afterwards it already
  // holds the post-rollout generation, which nothing can exceed.
  let rolloutBaseline = 0
  await test.step('Select the isolated workflow agent and bind its subscription visibly', async () => {
    await page.goto('/')
    await loginControlUiVisible(page)
    scenario.connectionKey = await prepareSubscriptionVisible(page, scenario)
    await new ControlUiShell(page).openAgents()
    await new AgentListPage(page).openNamed(scenario.agentName)
    const model = new AgentModelPage(page)
    await model.openEditor()
    await model.chooseSubscription(scenario.subscriptionName)
    await page.getByLabel('Current model', { exact: true }).click()
    await page.getByRole('option', { name: scenario.modelName, exact: true }).click()
    rolloutBaseline = readAgentDeploymentGeneration(scenario.agentName)
    const saved = await model.saveHost(scenario.agentName)
    expect(saved.spec?.model).toMatchObject({
      provider: 'codex-subscription',
      name: scenario.modelName,
      connectionRef: scenario.connectionKey,
    })
    expect(
      (saved.spec as { llmPolicy?: { fallbacks?: unknown[] } })?.llmPolicy?.fallbacks ?? []
    ).toEqual([])
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  })

  await test.step('Require approval for the real native workflow trigger through Advanced settings', async () => {
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/agents/${scenario.agentName}/advanced$`))
    await page.getByRole('tab', { name: 'Per-tool approval', exact: true }).click()
    const advanced = page.getByRole('region', { name: 'Advanced', exact: true })
    await advanced.getByRole('button', { name: /Advanced: conditional tools/ }).click()
    await advanced.getByLabel('Tool name', { exact: true }).fill('workflow_trigger')
    await advanced
      .getByLabel('Approval state for the new custom tool', { exact: true })
      .selectOption('required')
    await advanced.getByRole('button', { name: 'Add', exact: true }).click()
    const update = page.waitForResponse(
      response =>
        new URL(response.url()).pathname ===
          browserApiPath(`/api/v1/admin/hosts/${scenario.agentName}`) &&
        response.request().method() === 'PUT'
    )
    await advanced.getByRole('button', { name: 'Save', exact: true }).click()
    const response = await update
    expect(response.ok()).toBe(true)
    expect((await response.json()).spec.approval.tools.workflow_trigger).toBe(true)
    await expect(advanced.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    // Saving reloads the agent: `persistApprovalTools`
    // (`control-ui/app/hosts/[name]/page.tsx:1084-1112`) calls `loadData('none')`,
    // which sets `initialLoading`, so `HostApprovalSection` unmounts and remounts
    // with its conditional-tools block collapsed
    // (`HostApprovalSection/index.tsx:187`) and the custom rows unrendered
    // (`:260`). The row is hidden, not missing, and asserting the collapsed
    // state first is what tells those two apart.
    const conditionalTools = advanced.getByRole('button', {
      name: /Advanced: conditional tools/,
    })
    await expect(conditionalTools).toHaveAttribute('aria-expanded', 'false')
    await conditionalTools.click()
    await expect(conditionalTools).toHaveAttribute('aria-expanded', 'true')
    await expect(advanced.getByText('workflow_trigger', { exact: true })).toBeVisible()
  })

  // The approval map is not part of the runtime-token contract: HCC never reads
  // `spec.approval` (no match in `host-context-controller/src`), and the only
  // consumer is `mcp-host/src/core/extensions/mcpApprovalGateController.ts`.
  // What has to converge before Desktop launches is the model binding's rollout.
  await test.step('Wait for the agent rollout the model binding triggered', async () => {
    await waitForAgentRollout(scenario.agentName, rolloutBaseline)
  })

  const app = await launchDesktopApp()
  let journeyPassed = false
  try {
    const desktop = await app.firstWindow()
    await test.step('Sign in to Desktop, select the same agent and subscription model', async () => {
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
      // The menu labels an option with the allowlist entry's displayName and
      // falls back to the model id when there is none (ModelSelector.tsx:276).
      // The Codex allowlist carries no displayName, so the id is what renders.
      // Keying on the testid (ModelSelector.tsx:269) anchors this to the same
      // id the Control UI step bound, instead of to a label nothing defines.
      const option = desktop.getByTestId(`model-option-${scenario.modelName}`)
      await expect(option).toHaveCount(1)
      await option.click()
      await expect(
        desktop.getByRole('button', { name: `Model — ${scenario.modelName}`, exact: true })
      ).toBeVisible()
    })

    await test.step('Request the workflow and approve its native invocation and bound recipe approval', async () => {
      const upstreamBefore =
        mode === 'deterministic' ? await readUpstreamEvidence(scenario) : undefined
      const started = Date.now()
      const prompt = `Run my ${scenario.workflowName} workflow, check that it finishes, and show the business ID from its result artifact.`
      await desktop.getByTestId('chat-input').fill(prompt)
      await desktop.getByTestId('send-button').click()
      await expect(
        desktop.getByTestId('message-list').getByText(prompt, { exact: true })
      ).toBeVisible()
      const approval = desktop
        .getByTestId('progress-stepper')
        .filter({ has: desktop.getByTestId('approval-approve-btn') })
      await expect(approval).toHaveCount(1)
      await expect(approval).toContainText('workflow_trigger')
      expect((await readEvidence(scenario)).calls).toEqual([])
      await approval.getByTestId('approval-approve-btn').click()
      await expect(approval).toHaveCount(0)

      await desktop.getByTestId('notification-bell').click()
      const panel = desktop.getByRole('dialog', { name: 'Notifications and approvals' })
      await expect(panel).toBeVisible()
      const card = panel
        .getByTestId('workflow-approval-card')
        .filter({ hasText: scenario.workflowName })
      await expect(card).toHaveCount(1)
      await expect(card).toContainText(scenario.workflowNamespace)
      await expect(card).toContainText(
        `Step: workflow_trigger:${scenario.workflowNamespace}/${scenario.workflowName}`
      )
      expect((await readEvidence(scenario)).calls).toEqual([])
      await card.getByTestId('workflow-approval-approve').click()
      await expect(card).toHaveCount(0)
      await desktop.getByTestId('notification-bell').click()
      await expect(panel).toHaveCount(0)
      await expect
        .poll(async () => (await readEvidence(scenario)).calls.length, { timeout: 120_000 })
        .toBe(1)
      const receipt = (await readEvidence(scenario)).calls[0]!
      expect(receipt).toMatchObject({ runId: scenario.runId, tool: 'workitem_read_receipt' })
      expect(receipt.businessId).toMatch(/^[0-9a-f-]{36}$/)
      await expect(
        desktop.getByTestId('agent-response').filter({ hasText: receipt.businessId })
      ).toBeVisible({ timeout: 120_000 })
      await expect(desktop.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
      expect((await readEvidence(scenario)).calls).toHaveLength(1)
      let requests = null
      if (upstreamBefore) {
        const after = await readUpstreamEvidence(scenario)
        expect(after.rejected).toBe(upstreamBefore.rejected)
        requests = after.requests.slice(upstreamBefore.requests.length)
        const stages = requests.map(request => request.stage)
        expect(stages.slice(0, 2)).toEqual(['workflow_list', 'workflow_trigger'])
        expect(stages.slice(2, -2).length).toBeGreaterThan(0)
        expect(stages.slice(2, -2).every(stage => stage === 'workflow_status')).toBe(true)
        expect(stages.slice(-2)).toEqual(['workflow_result', 'final'])
      }
      // Read-only exact provider-reported UI telemetry, never inferred from bytes.
      const reportedTokenLabels = await desktop
        .getByLabel(/^Turn token usage/)
        .evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
      await testInfo.attach('native-workflow-result', {
        body: JSON.stringify({
          mode,
          workflowName: scenario.workflowName,
          receipt,
          requests,
          elapsedMs: Date.now() - started,
          reportedTokenLabels,
          subscriptionUsage: null,
        }),
        contentType: 'application/json',
      })
    })
    journeyPassed = true
  } finally {
    // Sign out before closing, or this journey's session is inherited by the
    // next Electron test and its login form never renders.
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
    if (cleanupError && journeyPassed) throw new Error(cleanupError)
  }
}
