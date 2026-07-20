/**
 * Human-recorded Telegram acceptance for:
 * 3rd-party AuthN + 1st-party MCP-host.
 *
 * This spec intentionally does not fake Telegram and does not call an internal
 * provider-decision endpoint. A human uses the real Telegram client/bot; the
 * test only prepares bounded state and observes Desktop + business signals.
 */
import { type Page, expect, test } from '@playwright/test'
import {
  expectChannelReaderCanReachMcpHost,
  expectChannelReaderHasNoProviderHttpIngress,
  expectChannelReaderLoadedTelegram,
  waitForChannelReader,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import {
  applyRealTelegramCommunicationChannel,
  assertRealTelegramConfig,
  expectRealTelegramPollingReady,
  removeRealTelegramCommunicationChannel,
} from './third-party-authn-first-party-mcphost/realTelegramChannel'
import {
  artifactConfirmed,
  openHumanInstructions,
  showArtifactInstructions,
  updateHumanInstructions,
} from './third-party-authn-first-party-mcphost/realTelegramHumanInstructions'
import {
  approvalStatus,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  enrollTelegramMedium,
  installWorkflowRecipeForUser,
  latestPendingApprovalIdOrNull,
  makeE2ERecipeName,
  providerDecisionEventSignalForApproval,
  workflowRunCountForApproval,
  workflowRunIdForApproval,
  workflowRunPhaseForApproval,
  workflowRunSignalForApproval,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import {
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  selectWorkflow,
  shortRunId,
} from './workflowUi'

const E2E_EMAIL = process.env.E2E_EMAIL || 'test@clerum.io'
const HOST_REF = process.env.E2E_SHARED_MCP_HOST_NAME || process.env.E2E_HOST_REF || 'chatllm'

test.describe('3rd-party AuthN + 1st-party MCP-host through real Telegram', () => {
  test.skip(
    process.env.E2E_REAL_TELEGRAM !== '1',
    'real Telegram gate is opt-in: set E2E_REAL_TELEGRAM=1'
  )
  test.skip(
    process.env.HUMAN_E2E_RECORDED !== '1',
    'real Telegram gate must be human-recorded: set HUMAN_E2E_RECORDED=1'
  )

  test('human lists, triggers, receives approval, approves, and downloads the artifact in Telegram while Desktop observes', async ({
    browser,
  }) => {
    test.setTimeout(900_000)
    expect(process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS ?? '').not.toBe('1')

    const realTelegram = assertRealTelegramConfig()
    const recipeName = makeE2ERecipeName()
    const marker = `real-telegram-third-party-authn-first-party-mcphost-${Date.now()}`
    const artifactProof = `artifact-output-${marker}`
    let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null
    let observerPage: Page | null = null
    let instructionPage: Page | null = null
    let approvalId: string | null = null

    try {
      await test.step('Prepare real Telegram channel, user binding, and workflow grant', async () => {
        await clearSession()
        cleanupWorkflowRecipe(recipeName)
        cleanupTelegramMediumBinding({
          providerUserId: realTelegram.providerUserId,
          providerChannelId: realTelegram.providerChannelId,
        })

        removeRealTelegramCommunicationChannel()
        applyRealTelegramCommunicationChannel(realTelegram, HOST_REF)
        waitForChannelReader(HOST_REF)
        expectChannelReaderLoadedTelegram(HOST_REF)
        expectRealTelegramPollingReady(HOST_REF)
        expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
        expectChannelReaderCanReachMcpHost(HOST_REF)

        const { userId, userToken } = await loginAs(E2E_EMAIL)
        await enrollTelegramMedium(userToken, userId, {
          providerUserId: realTelegram.providerUserId,
          providerChannelId: realTelegram.providerChannelId,
        })
        await installWorkflowRecipeForUser({ recipeName, marker, userId })
      })

      await test.step('Open Desktop observer and human instruction surface', async () => {
        const launched = await launchAndLogin(E2E_EMAIL)
        app = launched.app
        observerPage = launched.page
        instructionPage = await openHumanInstructions(browser, {
          botName: realTelegram.botName,
          visualUsername: realTelegram.visualUsername,
          recipeName,
          marker,
          artifactProof,
        })
        await waitForNotificationStreamReady(observerPage)
      })

      await test.step('Human uses Telegram to list workflows and trigger the recipe', async () => {
        if (!observerPage || !instructionPage) {
          throw new Error('observer and instruction pages must be ready')
        }
        await expect
          .poll(() => latestPendingApprovalIdOrNull(recipeName), {
            timeout: 420_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'human Telegram journey should trigger a durable pending workflow approval',
          })
          .toMatch(/^[0-9a-f-]{36}$/)
        approvalId = latestPendingApprovalIdOrNull(recipeName)
        await updateHumanInstructions(instructionPage, { recipeName })
        await expectDesktopPendingApprovalVisible(observerPage, recipeName)
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(workflowRunCountForApproval(approvalId)).toBe(0)
      })

      await test.step('Human approves the workflow request in real Telegram', async () => {
        if (!approvalId) throw new Error('approval id must be known')
        await expect
          .poll(() => approvalStatus(approvalId as string), {
            timeout: 420_000,
            intervals: [1_000, 2_000, 5_000],
            message:
              'human Telegram approval should be consumed through channel-reader -> mcp-host -> control-api',
          })
          .toBe('consumed')
        await expect
          .poll(() => workflowRunCountForApproval(approvalId as string), {
            timeout: 90_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'human Telegram approval should create exactly one workflow run',
          })
          .toBe(1)
        expect(providerDecisionEventSignalForApproval(approvalId)).toBe('decided:1')
        expect(workflowRunSignalForApproval(approvalId)).toBe(
          `user:onDemand:sandbox-recipes/${recipeName}`
        )
      })

      await test.step('Desktop observer sees approval cleared and exact workflow run', async () => {
        if (!observerPage || !approvalId) {
          throw new Error('observer page and approval id must be ready')
        }
        await expectPendingApprovalCleared(observerPage, recipeName)
        await expectWorkflowRunVisible(
          observerPage,
          recipeName,
          workflowRunIdForApproval(approvalId)
        )
      })

      await test.step('Human retrieves the workflow result artifact document in real Telegram', async () => {
        if (!approvalId || !instructionPage) {
          throw new Error('approval id and instruction page must be ready')
        }
        await expect
          .poll(() => workflowRunPhaseForApproval(approvalId as string), {
            timeout: 180_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'approved workflow run should succeed before Telegram asks for its artifact',
          })
          .toBe('Succeeded')
        await showArtifactInstructions(instructionPage, { recipeName, artifactProof })
        await expect
          .poll(() => artifactConfirmed(instructionPage as Page, artifactProof), {
            timeout: 420_000,
            intervals: [1_000, 2_000, 5_000],
            message:
              'human recorder should confirm the exact artifact proof was visible in a real Telegram document attachment',
          })
          .toBe(true)
      })
    } finally {
      if (instructionPage) await instructionPage.close().catch(() => undefined)
      if (app) await app.close().catch(() => undefined)
      cleanupWorkflowRecipe(recipeName)
      cleanupTelegramMediumBinding({
        providerUserId: realTelegram.providerUserId,
        providerChannelId: realTelegram.providerChannelId,
      })
      removeRealTelegramCommunicationChannel()
    }
  })
})

async function waitForNotificationStreamReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const status = await (window as any).clerum.notifications.status()
          return Number(status?.open || 0) > 0 && Number(status?.snapshot || 0) > 0
        }),
      {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
        message: 'Desktop notification stream should be connected before approval is requested',
      }
    )
    .toBe(true)
}

async function expectDesktopPendingApprovalVisible(page: Page, recipeName: string): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: recipeName }).first()
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card.getByTestId('workflow-approval-approve')).toBeVisible()
}

async function expectPendingApprovalCleared(page: Page, recipeName: string): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: recipeName }).first()
  await expect(card).toHaveCount(0)
  await expect(panel.getByTestId('workflow-approval-approve')).toHaveCount(0)
}

async function expectWorkflowRunVisible(
  page: Page,
  recipeName: string,
  runId: string
): Promise<void> {
  await openWorkflowsPage(page)
  const detailCard = await selectWorkflow(page, recipeName, 'sandbox-recipes')
  const row = detailCard.getByTestId('workflow-run-row').filter({ hasText: shortRunId(runId) })
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row).toContainText(/Pending|Running|Succeeded/)
}
