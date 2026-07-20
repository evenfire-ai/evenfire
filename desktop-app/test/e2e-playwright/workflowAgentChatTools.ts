import { type Locator, type Page, type TestInfo, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../src/types'
import { openAgentsPage } from './navigationHelpers.js'
import {
  EXT_API,
  K8S_CONTEXT,
  RECIPE_NS,
  apiRequest,
  openWorkflowsPage,
  rendererListWorkflowRuns,
  selectWorkflow,
  shortRunId,
} from './workflowUi'

export const CHATLLM_HOST_REF = process.env.E2E_HOST_REF || 'chatllm'
const HUMAN_E2E_RECORDED = process.env.HUMAN_E2E_RECORDED === '1'

type HumanPacingRange = [number, number]

function randomInt([min, max]: HumanPacingRange): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

export async function humanRecordedPause(range: HumanPacingRange = [220, 520]): Promise<void> {
  if (!HUMAN_E2E_RECORDED) return
  await new Promise(resolve => setTimeout(resolve, randomInt(range)))
}

export async function humanClick(
  locator: Locator,
  options: {
    beforeMs?: HumanPacingRange
    afterMs?: HumanPacingRange
    moveSteps?: number
    clickDelayMs?: number
  } = {}
): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.click()
    return
  }

  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  await humanRecordedPause(options.beforeMs ?? [260, 720])
  const box = await locator.boundingBox()
  if (box) {
    await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: options.moveSteps ?? randomInt([12, 24]),
    })
  } else {
    await locator.hover()
  }
  await humanRecordedPause([140, 360])
  await locator.click({ delay: options.clickDelayMs ?? randomInt([45, 120]) })
  await humanRecordedPause(options.afterMs ?? [280, 760])
}

async function humanType(locator: Locator, text: string): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.fill(text)
    return
  }

  await humanClick(locator, { beforeMs: [180, 420], afterMs: [120, 260] })
  await locator.fill('')
  await locator.pressSequentially(text, { delay: randomInt([8, 22]) })
  await humanRecordedPause([320, 720])
}

async function humanDownloadClick(locator: Locator): Promise<void> {
  await humanClick(locator, {
    beforeMs: [800, 1_400],
    afterMs: [900, 1_500],
    moveSteps: randomInt([18, 30]),
    clickDelayMs: randomInt([90, 170]),
  })
}

export async function captureE2eEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string
): Promise<void> {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const fileName = `${safeLabel || 'screenshot'}.png`
  const screenshotPath = testInfo.outputPath(fileName)
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
  await testInfo.attach(fileName, { path: screenshotPath, contentType: 'image/png' })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

function runProfilesSql(sql: string, timeout = 20_000): string {
  return kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-c',
      sql,
    ],
    undefined,
    timeout
  )
}

export function applyWorkflowRecipeManifest(manifest: Record<string, unknown>): void {
  kubectl(['apply', '-f', '-'], JSON.stringify(manifest, null, 2), 30_000)
}

export async function waitForWorkflowRecipeActive(name: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const raw = kubectl(
            ['-n', RECIPE_NS, 'get', 'workflowrecipe', name, '-o', 'jsonpath={.status.phase}'],
            undefined,
            10_000
          ).trim()
          return raw || 'missing'
        } catch (error) {
          return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        }
      },
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${name} should become active before chat trigger`,
      }
    )
    .toBe('active')
}

export async function waitForMcpServerReady(name: string, contextRef = 'context1'): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const status = kubectl(
            [
              '-n',
              'mcp-server',
              'get',
              'mcpserver',
              name,
              '-o',
              'jsonpath={range .status.conditions[?(@.type=="Ready")]}{.status}{end}',
            ],
            undefined,
            10_000
          ).trim()
          const contextServers = kubectl(
            ['-n', 'mcp-server', 'get', 'context', contextRef, '-o', 'jsonpath={.spec.mcpServers}'],
            undefined,
            10_000
          )
          return status === 'True' && contextServers.includes(`"${name}"`) ? 'ready' : 'waiting'
        } catch (error) {
          return error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        }
      },
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000],
        message: `mcp-server/${name} should be Ready and allowlisted in ${contextRef}`,
      }
    )
    .toBe('ready')
}

export function cleanupAgentChatRecipe(name: string): void {
  if (!/^e2e-agent-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to clean non-agent workflow recipe ${name}`)
  }

  try {
    const workflowNames = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'workflowrecipe',
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ])
      .split('\n')
      .map(item => item.trim())
      .filter(item => item === name || item.startsWith(`${name}-`))
    if (workflowNames.length > 0) {
      kubectl([
        '-n',
        RECIPE_NS,
        'delete',
        'workflowrecipe',
        ...workflowNames,
        '--ignore-not-found=true',
        '--wait=false',
      ])
    }
  } catch {
    // Preserve the original test failure; all names are scoped to this E2E.
  }

  try {
    const ns = sqlLiteral(RECIPE_NS)
    const recipe = sqlLiteral(name)
    runProfilesSql(
      `
      DELETE FROM workflow_runs
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_runs_audit
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_approval_requests
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_approval_requests_archive
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM notification_deliveries
       WHERE payload->>'recipeNamespace' = ${ns}
         AND payload->>'recipeName' = ${recipe};
      DELETE FROM user_workflow_triggers
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM team_workflow_triggers
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_recipe_allowed_teams
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      `,
      30_000
    )
  } catch {
    // Rows are test-named; a later cleanup pass can remove leftovers if needed.
  }
}

export async function enterChatllmChat(page: Page): Promise<void> {
  await openAgentsPage(page)
  await humanRecordedPause([320, 780])
  const chatInput = page.getByTestId('chat-input')
  const agentLink = page
    .locator('.agents-table-row-clickable', { hasText: CHATLLM_HOST_REF })
    .first()
  await expect(chatInput.or(agentLink)).toBeVisible({ timeout: 30_000 })
  if (await agentLink.isVisible().catch(() => false)) {
    await humanClick(agentLink, { afterMs: [520, 1_000] })
  }
  const goToChat = page.getByRole('button', { name: /^Go to Chat$/i })
  if (await goToChat.isVisible().catch(() => false)) {
    await humanClick(goToChat, { afterMs: [520, 1_000] })
  }
  await expect(chatInput).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/^Workflow capabilities$/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Workflows$/ })).toHaveCount(0)
}

export async function startFreshThread(page: Page): Promise<void> {
  await openAgentsPage(page)
  await humanRecordedPause([320, 780])
  const moreActions = page
    .getByRole('button', {
      name: new RegExp(`^More actions for ${escapeRegExp(CHATLLM_HOST_REF)}$`),
    })
    .first()
  await expect(moreActions).toBeVisible({ timeout: 30_000 })
  await humanClick(moreActions, { afterMs: [260, 620] })
  const newChat = page.getByRole('button', { name: /^New chat$/ }).first()
  await expect(newChat).toBeVisible({ timeout: 10_000 })
  await humanClick(newChat, { afterMs: [520, 980] })
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('agent-response')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText(/^Workflow capabilities$/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Workflows$/ })).toHaveCount(0)
}

export async function sendChatPrompt(page: Page, prompt: string): Promise<number> {
  const responseCountBefore = await page.getByTestId('agent-response').count()
  const chatInput = page.getByTestId('chat-input')
  await expect(chatInput).toBeEnabled({ timeout: 30_000 })
  await humanType(chatInput, prompt)
  await expect(chatInput).toHaveValue(prompt, { timeout: 10_000 })
  const sendButton = page.getByTestId('send-button')
  await expect(sendButton).toBeEnabled({ timeout: 30_000 })
  await humanClick(sendButton, {
    beforeMs: [400, 900],
    afterMs: [700, 1_200],
  })
  await expect(chatInput).toHaveValue('', { timeout: 10_000 })
  return responseCountBefore
}

export async function waitForAssistantResponse(
  page: Page,
  responseCountBefore: number,
  timeout = 180_000
): Promise<Locator> {
  const response = page.getByTestId('agent-response').nth(responseCountBefore)
  await expect(response).toBeVisible({ timeout })
  return response
}

async function hasEmptyModelResponse(response: Locator): Promise<boolean> {
  return response
    .getByText(/LLM produced empty response \(no text, no tool calls\)/i)
    .isVisible()
    .catch(() => false)
}

async function waitForEmptyModelResponse(response: Locator, timeout = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await hasEmptyModelResponse(response)) return true
    await response.page().waitForTimeout(500)
  }
  return false
}

export async function sendChatPromptWithModelRescue(
  page: Page,
  prompt: string,
  timeout = 180_000
): Promise<Locator> {
  let lastResponse: Locator | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const responseCountBefore = await sendChatPrompt(page, prompt)
    const response = await waitForAssistantResponse(page, responseCountBefore, timeout)
    lastResponse = response
    if (!(await waitForEmptyModelResponse(response))) return response
  }

  if (!lastResponse) throw new Error('Assistant response was not visible')
  return lastResponse
}

export async function expandResponseToolDetails(response: Locator): Promise<void> {
  const stepper = response.getByTestId('progress-stepper').last()
  if (!(await stepper.isVisible().catch(() => false))) return

  const toolRows = stepper.locator('.stepper-step')
  const toggle = stepper
    .getByTestId('progress-expand-btn')
    .or(stepper.getByRole('button', { name: /More details/i }))
    .first()
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  const expanded = await toggle.getAttribute('aria-expanded').catch(() => null)
  if (expanded !== 'true') {
    await humanClick(toggle, { beforeMs: [700, 1_200], afterMs: [900, 1_500] })
  }
  await expect(toolRows.first()).toBeVisible({ timeout: 15_000 })
}

export async function expandLatestResponseToolDetails(page: Page): Promise<void> {
  const response = page.getByTestId('agent-response').last()
  await expect(response).toBeVisible({ timeout: 15_000 })
  await expandResponseToolDetails(response)
}

export async function expectNoWorkflowResultToolError(response: Locator): Promise<void> {
  await expect(response).not.toContainText(/Workflow broker request failed \(403\)/i)
  await expect(response).not.toContainText(/workflow tool failed/i)
  await expect(response).not.toContainText(/could not retrieve the workflow result artifact/i)
  await expect(response).not.toContainText(/workflow_result/i)
}

export async function approveNextToolCall(page: Page, approvalCountBefore: number): Promise<void> {
  const approvalButton = page.getByTestId('approval-approve-btn').nth(approvalCountBefore)
  await expect(approvalButton).toBeVisible({ timeout: 180_000 })
  await humanClick(approvalButton, { beforeMs: [800, 1_400], afterMs: [800, 1_400] })
}

export async function denyNextToolCall(page: Page, approvalCountBefore: number): Promise<void> {
  const denialButton = page.getByTestId('approval-deny-btn').nth(approvalCountBefore)
  await expect(denialButton).toBeVisible({ timeout: 180_000 })
  await humanClick(denialButton, { beforeMs: [800, 1_400], afterMs: [800, 1_400] })
}

export async function approveNextToolCallIfPresent(
  page: Page,
  approvalCountBefore: number,
  timeout = 15_000
): Promise<boolean> {
  const approvalButton = page.getByTestId('approval-approve-btn').nth(approvalCountBefore)
  try {
    await expect(approvalButton).toBeVisible({ timeout })
  } catch {
    return false
  }
  await humanClick(approvalButton, { beforeMs: [700, 1_200], afterMs: [700, 1_200] })
  return true
}

export async function approveWorkflowNotification(page: Page, recipeName: string): Promise<void> {
  const panel = await openNotificationsPanel(page, 300_000)
  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: recipeName })
  await expect(card).toBeVisible({ timeout: 180_000 })
  const approveButton = card.getByTestId('workflow-approval-approve')
  await expect(approveButton).toBeEnabled({ timeout: 10_000 })
  await humanClick(approveButton, { beforeMs: [700, 1_300], afterMs: [700, 1_300] })
  await expect(page.getByRole('status').filter({ hasText: 'Approval accepted' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(card).not.toBeVisible({ timeout: 30_000 })
  await closeNotificationsPanel(page)
}

async function openNotificationsPanel(page: Page, badgeTimeout = 20_000): Promise<Locator> {
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  if (await panel.isVisible().catch(() => false)) return panel

  const bell = page.getByRole('button', { name: 'Notifications and approvals' })
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('notification-bell-badge')).toBeVisible({ timeout: badgeTimeout })
  await humanClick(bell, { beforeMs: [500, 900], afterMs: [500, 900] })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

async function closeNotificationsPanel(page: Page): Promise<void> {
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  if (!(await panel.isVisible().catch(() => false))) return
  const bell = page.getByRole('button', { name: 'Notifications and approvals' })
  await humanClick(bell, { beforeMs: [300, 650], afterMs: [300, 650] })
  await expect(panel).not.toBeVisible({ timeout: 10_000 })
}

async function listPendingWorkflowTriggerApprovalTexts(page: Page): Promise<string[]> {
  if (
    !(await page
      .getByTestId('notification-bell-badge')
      .isVisible()
      .catch(() => false))
  )
    return []
  const panel = await openNotificationsPanel(page, 5_000)
  const items = await pendingWorkflowTriggerApprovalItems(panel)
  const texts = await Promise.all(
    items.map(async item => ((await item.textContent().catch(() => '')) || '').trim())
  )
  await closeNotificationsPanel(page)
  return texts
}

async function pendingWorkflowTriggerApprovalItems(panel: Locator): Promise<Locator[]> {
  const items = panel.getByTestId('notification-menu-item').filter({ hasText: /workflow_trigger/i })
  const count = await items.count()
  const pendingItems: Locator[] = []
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index)
    const approveButtonCount = await item.locator('.notification-action-btn.approve').count()
    if (approveButtonCount > 0) pendingItems.push(item)
  }
  return pendingItems
}

async function approveNextToolApprovalNotification(
  page: Page,
  previousApprovalTexts: readonly string[]
): Promise<void> {
  const panel = await openNotificationsPanel(page, 180_000)
  await expect
    .poll(async () => (await pendingWorkflowTriggerApprovalItems(panel)).length, {
      timeout: 180_000,
      message: 'wait for a new workflow_trigger approval notification in the Desktop bell',
    })
    .toBeGreaterThan(previousApprovalTexts.length)

  const pendingItems = await pendingWorkflowTriggerApprovalItems(panel)
  let item: Locator | undefined
  for (const candidate of pendingItems) {
    const text = ((await candidate.textContent().catch(() => '')) || '').trim()
    if (!previousApprovalTexts.includes(text)) {
      item = candidate
      break
    }
  }
  if (!item) throw new Error('New workflow_trigger approval notification was not distinguishable')

  await expect(item).toContainText(/workflow_trigger/i)
  await expect(item).toContainText(/approval/i)
  const approveButton = item.locator('.notification-action-btn.approve')
  await expect(approveButton).toBeEnabled({ timeout: 10_000 })
  await humanClick(approveButton, { beforeMs: [700, 1_200], afterMs: [700, 1_200] })
  await expect(item).toContainText(/Approved/i, { timeout: 30_000 })
  await closeNotificationsPanel(page)
}

async function reopenActiveChatSession(page: Page): Promise<void> {
  const activeSession = page
    .locator('.nav-latest-session.active')
    .getByRole('button', { name: /^Open / })
    .first()
  if (!(await activeSession.isVisible().catch(() => false))) return
  await humanClick(activeSession, { beforeMs: [300, 650], afterMs: [600, 1_100] })
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 })
}

export async function sendChatPromptAndApproveNextToolCall(
  page: Page,
  prompt: string,
  responseTimeout = 300_000
): Promise<Locator> {
  let lastResponse: Locator | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const approvalCountBefore = await page.getByTestId('approval-approve-btn').count()
    const responseCountBefore = await sendChatPrompt(page, prompt)
    const response = page.getByTestId('agent-response').nth(responseCountBefore)
    const approvalButton = page.getByTestId('approval-approve-btn').nth(approvalCountBefore)
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (await approvalButton.isVisible().catch(() => false)) {
        await humanClick(approvalButton, { beforeMs: [700, 1_200], afterMs: [700, 1_200] })
        return waitForAssistantResponse(page, responseCountBefore, responseTimeout)
      }
      if (await response.isVisible().catch(() => false)) {
        lastResponse = response
        if (await hasEmptyModelResponse(response)) break
        const responseText = ((await response.textContent().catch(() => '')) || '').trim()
        if (responseText.length > 20) {
          await page.waitForTimeout(2_500)
          if (!(await approvalButton.isVisible().catch(() => false))) return response
        }
      }
      await page.waitForTimeout(500)
    }
    if (!(lastResponse && (await hasEmptyModelResponse(lastResponse)))) {
      await expect(approvalButton).toBeVisible({ timeout: 1_000 })
    }
  }

  if (!lastResponse) throw new Error('Assistant response was not visible')
  return lastResponse
}

export async function runWorkflowFromChat(
  page: Page,
  recipeName: string,
  prompt: string
): Promise<Locator> {
  let lastResponse: Locator | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previousToolApprovalTexts = await listPendingWorkflowTriggerApprovalTexts(page)
    const responseCountBefore = await sendChatPrompt(page, prompt)
    const response = page.getByTestId('agent-response').nth(responseCountBefore)
    const deadline = Date.now() + 180_000
    let rejoinAttempted = false
    while (Date.now() < deadline) {
      if (
        await page
          .getByTestId('notification-bell-badge')
          .isVisible()
          .catch(() => false)
      ) {
        await approveNextToolApprovalNotification(page, previousToolApprovalTexts)
        await approveWorkflowNotification(page, recipeName)
        return waitForAssistantResponse(page, responseCountBefore, 300_000)
      }
      if (!rejoinAttempted && Date.now() > deadline - 170_000) {
        rejoinAttempted = true
        await reopenActiveChatSession(page)
      }
      if (await response.isVisible().catch(() => false)) {
        lastResponse = response
        if (await hasEmptyModelResponse(response)) break
      }
      await page.waitForTimeout(500)
    }
    if (!(lastResponse && (await hasEmptyModelResponse(lastResponse)))) {
      await expect(page.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 1_000 })
    }
  }

  if (!lastResponse) throw new Error('Assistant response was not visible')
  return lastResponse
}

async function rendererListWorkflowRunArtifacts(
  page: Page,
  recipeName: string,
  runId: string
): Promise<WorkflowRunArtifact[]> {
  const result = await page.evaluate(
    ([recipeNs, workflowName, recipeRunId]) => {
      return (window as any).clerum.workflows.listRunArtifacts(recipeNs, workflowName, recipeRunId)
    },
    [RECIPE_NS, recipeName, runId]
  )
  return Array.isArray(result?.artifacts) ? result.artifacts : []
}

export async function waitForSucceededRunWithArtifact(
  page: Page,
  recipeName: string,
  previousIds: string[],
  artifactName: string
): Promise<WorkflowRunListItem> {
  let latestRun: WorkflowRunListItem | undefined
  await expect
    .poll(
      async () => {
        const runs = await rendererListWorkflowRuns(page, RECIPE_NS, recipeName, 20)
        latestRun = runs.items.find(item => !previousIds.includes(item.id))
        if (!latestRun) return 'missing'
        if (latestRun.phase !== 'Succeeded') return latestRun.phase
        const artifacts = await rendererListWorkflowRunArtifacts(page, recipeName, latestRun.id)
        latestRun = { ...latestRun, artifacts }
        return artifacts.some(artifact => artifact.name === artifactName)
          ? 'ready'
          : 'missing-artifact'
      },
      {
        timeout: 420_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${recipeName} should create a succeeded run with ${artifactName}`,
      }
    )
    .toBe('ready')

  if (!latestRun) throw new Error(`${RECIPE_NS}/${recipeName} run was not visible`)
  return latestRun
}

export async function refreshChatArtifactPanel(
  page: Page,
  _runId: string,
  artifactName: string
): Promise<Locator> {
  const panel = page.getByTestId('workflow-chat-artifacts').last()
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await humanClick(panel.getByRole('button', { name: /^Refresh$/ }), {
    beforeMs: [700, 1_200],
    afterMs: [900, 1_500],
  })
  await expect(
    panel.getByTestId('workflow-chat-artifact-download').filter({ hasText: artifactName })
  ).toBeVisible({ timeout: 60_000 })
  return panel
}

export async function downloadArtifactFromChat(
  page: Page,
  panel: Locator,
  runId: string,
  artifactName: string
): Promise<Buffer> {
  const expectedFilename = `${shortRunId(runId)}-${artifactName}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })
  const button = panel
    .getByTestId('workflow-chat-artifact-download')
    .filter({ hasText: artifactName })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await humanDownloadClick(button)
  await expect(panel).toContainText(`Saved ${expectedFilename} to Downloads.`, { timeout: 30_000 })
  await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return 0
        return fs.statSync(downloadPath).size
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads from chat`,
      }
    )
    .toBeGreaterThan(0)

  try {
    return fs.readFileSync(downloadPath)
  } finally {
    fs.rmSync(downloadPath, { force: true })
  }
}

export async function openWorkflowRunInMarketplace(
  page: Page,
  recipeName: string,
  runId: string,
  artifactName: string
): Promise<Locator> {
  await openWorkflowsPage(page)
  await selectWorkflow(page, recipeName, RECIPE_NS)
  await humanClick(page.getByRole('button', { name: /^Refresh$/ }), {
    beforeMs: [700, 1_200],
    afterMs: [900, 1_500],
  })
  const runRow = page.getByTestId('workflow-run-row').filter({ hasText: shortRunId(runId) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  await expect(runRow.getByRole('button', { name: artifactName })).toBeVisible({
    timeout: 30_000,
  })
  return runRow
}

export async function downloadJsonArtifactFromMarketplace(
  runRow: Locator,
  runId: string,
  artifactName: string
): Promise<Record<string, unknown>> {
  const expectedFilename = `${shortRunId(runId)}-${artifactName}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })
  await humanDownloadClick(runRow.getByRole('button', { name: artifactName }))
  await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return 0
        return fs.statSync(downloadPath).size
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads`,
      }
    )
    .toBeGreaterThan(0)

  try {
    return JSON.parse(fs.readFileSync(downloadPath, 'utf8')) as Record<string, unknown>
  } finally {
    fs.rmSync(downloadPath, { force: true })
  }
}

export async function downloadArtifactViaUserApi(
  userToken: string,
  recipeName: string,
  runId: string,
  artifactName: string
): Promise<Record<string, unknown>> {
  const response = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
      recipeName
    )}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
    undefined,
    { Authorization: `Bearer ${userToken}` }
  )
  if (response.status !== 200) {
    throw new Error(`download run artifact failed: HTTP ${response.status} ${response.body}`)
  }
  return JSON.parse(response.body) as Record<string, unknown>
}

export function expectNoOperationalIds(response: Locator): Promise<void> {
  return expect(response).not.toContainText(
    /targetUserId|targetTeamId|approvalRequestId|Bearer|eyJ|workflow_control|idempotencyKey|inputContract|tool call order|sandbox-recipes|\bnamespace\s*[:=]|Run ID:|approval ID|target ID/i
  )
}

export function expectNoBusinessInputsRequired(response: Locator): Promise<void> {
  return expect(response).toContainText(
    /((?:requires?|need(?:s)?) no (business )?(inputs?|information)|requires (business )?inputs?:\s*no|required (business )?(inputs?|information):?\s*none( required)?|required information before running:?\s*none|(business )?inputs? required:?\s*none|information (needed|required)( before running)?:\s*none|no additional information (needed|required|from you)|without any additional information from you|does(?: not|n't) require any additional information( from you)?|inputs? needed( before running)?:\s*none|no inputs? needed|zero (business )?(inputs?|parameters?|information)|nothing (else )?to provide|without any (additional |user )?inputs?|no (business )?(inputs?|parameters?|information) (are )?required|does(?: not|n't) (need|require) any (business )?(inputs?|parameters?|information))/i
  )
}

export function approvalPromptFor(recipeName: string): string {
  return `Run ${recipeName}`
}
