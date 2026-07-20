/**
 * Complements the full fake Telegram approval journey by proving status and
 * health checks through the same channel-reader -> first-party mcp-host route.
 */
import { type Page, expect, test } from '@playwright/test'
import {
  applyTelegramCommunicationChannel,
  configureChannelReaderTelegramApiRoot,
  expectChannelReaderCanReachMcpHost,
  expectChannelReaderHasNoProviderHttpIngress,
  fakeTelegramPollingCount,
  installFakeTelegramProvider,
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
  waitForChannelReader,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import {
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  UUID_RE,
  approveWorkflowFromTelegramClient,
  openTelegramClient,
  sendTelegramClientMessage,
  setTelegramClientIdentity,
  telegramReplyItems,
  waitForPendingApprovalId,
  waitForTelegramFinalReplyTextAfter,
  waitForWorkflowApprovalInTelegramClient,
} from './third-party-authn-first-party-mcphost/telegramE2eClient'
import { verifyTelegramMediumWithFakeProvider } from './third-party-authn-first-party-mcphost/telegramMediumChallengeSetup'
import {
  approvalStatus,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  providerDecisionEventSignal,
  workflowRunCountForApproval,
  workflowRunCountForRecipe,
  workflowRunPhaseForApproval,
  workflowRunSignalForApproval,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { clearSession, loginAs } from './workflowUi'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe('fake Telegram workflow status and health through first-party mcp-host', () => {
  test('Telegram can check workflow_status and workflow_health after provider approval', async ({
    browser,
  }) => {
    test.setTimeout(600_000)
    expect(process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS ?? '').not.toBe('1')

    const runEpochMs = Date.now()
    const recipeName = makeScopedE2ERecipeName('telegram-status-health')
    const marker = `telegram-status-health-${runEpochMs}`
    const telegramMessageBase = runEpochMs * 10
    const telegramIdentityId = String(runEpochMs * 1_000 + (process.pid % 1_000))
    const verifiedTelegramIdentity: TelegramClientIdentity = {
      providerUserId: telegramIdentityId,
      providerChannelId: telegramIdentityId,
      conversationLabel: 'Test User - verified Telegram private chat',
    }
    let telegramPage: Page | null = null
    let telegramPortForward: { stop: () => void } | null = null

    try {
      await clearSession()
      cleanupWorkflowRecipe(recipeName)
      cleanupTelegramMediumBinding(verifiedTelegramIdentity)

      const { userId, userToken } = await loginAs(E2E_EMAIL)
      installFakeTelegramProvider()
      configureChannelReaderTelegramApiRoot()
      applyTelegramCommunicationChannel(HOST_REF, [verifiedTelegramIdentity], [userId])
      waitForChannelReader(HOST_REF)
      expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
      expectChannelReaderCanReachMcpHost(HOST_REF)
      await expect
        .poll(() => fakeTelegramPollingCount(), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'channel-reader should poll fake Telegram before updates are pushed',
        })
        .toBeGreaterThan(0)

      const telegram = await openTelegramClient(browser)
      telegramPage = telegram.page
      telegramPortForward = telegram.portForward
      await setTelegramClientIdentity(telegramPage, verifiedTelegramIdentity)

      await verifyTelegramMediumWithFakeProvider(
        telegramPage,
        userToken,
        telegramMessageBase,
        verifiedTelegramIdentity
      )
      await installWorkflowRecipeForUser({ recipeName, marker, userId })

      await sendTelegramClientMessage(
        telegramPage,
        `Trigger the workflow recipe named ${recipeName} with marker: ${marker}.`,
        telegramMessageBase + 1
      )
      const approvalId = await waitForPendingApprovalId(recipeName)
      expect(approvalStatus(approvalId)).toBe('pending')
      expect(workflowRunCountForApproval(approvalId)).toBe(0)

      await waitForWorkflowApprovalInTelegramClient(telegramPage, recipeName)
      const decisionMessageId = await approveWorkflowFromTelegramClient(telegramPage, recipeName)
      const decisionEventId = `telegram:${verifiedTelegramIdentity.providerChannelId}:${decisionMessageId}`
      await expect(telegramPage.getByTestId('telegram-bot-replies')).toContainText(
        'Approved. Workflow approval recorded.',
        { timeout: 60_000 }
      )

      await expect
        .poll(() => approvalStatus(approvalId), {
          timeout: 180_000,
          intervals: [500, 1_000, 2_000],
          message: 'provider decision should consume the Telegram approval',
        })
        .toBe('consumed')
      await expect
        .poll(() => workflowRunCountForApproval(approvalId), {
          timeout: 60_000,
          intervals: [500, 1_000, 2_000],
          message: 'provider decision should create exactly one run for the approval',
        })
        .toBe(1)
      await expect
        .poll(() => workflowRunCountForRecipe(recipeName), {
          timeout: 60_000,
          intervals: [500, 1_000, 2_000],
          message: 'provider decision should create exactly one run for the recipe',
        })
        .toBe(1)
      expect(providerDecisionEventSignal(decisionEventId)).toBe('decided:1')
      expect(workflowRunSignalForApproval(approvalId)).toBe(
        `user:onDemand:sandbox-recipes/${recipeName}`
      )
      await expect
        .poll(() => workflowRunPhaseForApproval(approvalId), {
          timeout: 180_000,
          intervals: [500, 1_000, 2_000],
          message: 'approved workflow run should finish before status and health checks',
        })
        .toBe('Succeeded')

      const statusReplyCount = await telegramReplyItems(telegramPage).count()
      await sendTelegramClientMessage(
        telegramPage,
        `Check workflow status for ${recipeName}. Include the exact workflow recipe name and current phase.`,
        telegramMessageBase + 2
      )
      await waitForTelegramFinalReplyTextAfter(
        telegramPage,
        statusReplyCount,
        new RegExp(
          `${escapeRegExp(recipeName)}[\\s\\S]*(status|phase|Succeeded|Running|Pending)`,
          'i'
        )
      )

      const healthReplyCount = await telegramReplyItems(telegramPage).count()
      await sendTelegramClientMessage(
        telegramPage,
        `Check workflow health for ${recipeName}. Include the exact workflow recipe name and health summary.`,
        telegramMessageBase + 3
      )
      await waitForTelegramFinalReplyTextAfter(
        telegramPage,
        healthReplyCount,
        new RegExp(`${escapeRegExp(recipeName)}[\\s\\S]*(health|active|last run|Succeeded)`, 'i')
      )
      await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(UUID_RE)
    } finally {
      if (telegramPage) await telegramPage.close().catch(() => undefined)
      telegramPortForward?.stop()
      cleanupWorkflowRecipe(recipeName)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot()
      removeFakeTelegramProvider()
      cleanupTelegramMediumBinding(verifiedTelegramIdentity)
    }
  })
})
