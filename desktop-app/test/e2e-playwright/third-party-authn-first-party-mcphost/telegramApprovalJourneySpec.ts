import { type Page, expect, test } from '@playwright/test'
import { clearSession, loginAs } from '../workflowUi'
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
} from './fakeTelegramProvider'
import {
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  UUID_RE,
  approveWorkflowFromTelegramClient,
  expectTelegramWorkflowList,
  expectTelegramWorkflowResultDocument,
  openTelegramClient,
  sendTelegramClientMessage,
  setTelegramClientIdentity,
  telegramReplyItems,
  waitForPendingApprovalId,
  waitForTelegramFinalReplyTextAfter,
  waitForTelegramReplyTextAfter,
  waitForWorkflowApprovalInTelegramClient,
} from './telegramE2eClient'
import { verifyTelegramMediumWithFakeProvider } from './telegramMediumChallengeSetup'
import {
  approvalRequestCountForRecipe,
  approvalStatus,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  markWorkflowApprovalCancelledByHost,
  providerDecisionEventSignalForApproval,
  replayWorkflowTerminalPhase,
  sentApprovalUpdatedNotificationCountForApproval,
  sentWorkflowRunCompletedNotificationCount,
  workflowApprovalTriggerCaller,
  workflowRunCompletedNotificationCount,
  workflowRunCountForApproval,
  workflowRunCountForRecipe,
  workflowRunIdForApproval,
  workflowRunPhaseForApproval,
  workflowRunSignalForApproval,
  workflowRunTypedIntentSignalForApproval,
} from './workflowApprovalJourney'

test.describe('3rd-party AuthN + 1st-party MCP-host through channel-reader', () => {
  test('Telegram verifies identity, approves the workflow, and receives the result artifact', async ({
    browser,
  }) => {
    test.setTimeout(900_000)
    expect(process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS ?? '').not.toBe('1')

    const runEpochMs = Date.now()
    const recipeName = makeScopedE2ERecipeName('telegram')
    const marker = `tg-${runEpochMs.toString(36)}`
    const artifactProof = `artifact-output-${marker}`
    const telegramMessageBase = Math.floor(runEpochMs / 1000) * 1000
    const telegramIdentityId = String(runEpochMs)
    const verifiedTelegramIdentity: TelegramClientIdentity = {
      providerUserId: telegramIdentityId,
      providerChannelId: telegramIdentityId,
      conversationLabel: 'Test User - verified Telegram private chat',
    }
    const wrongChannelIdentity: TelegramClientIdentity = {
      providerUserId: verifiedTelegramIdentity.providerUserId,
      providerChannelId: `${telegramIdentityId}-wrong`,
      conversationLabel: 'Test User - Telegram wrong chat',
    }
    const unboundIdentity: TelegramClientIdentity = {
      providerUserId: `${telegramIdentityId}-unbound`,
      providerChannelId: `${telegramIdentityId}-unbound`,
      conversationLabel: 'Unbound Telegram private chat',
    }
    let telegramPage: Page | null = null
    let telegramPortForward: { stop: () => void } | null = null

    try {
      await test.step('Prepare isolated channel-reader, Telegram, user binding, and workflow recipe', async () => {
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
            message:
              'channel-reader should be polling the Telegram provider before updates are pushed',
          })
          .toBeGreaterThan(0)
        const telegram = await openTelegramClient(browser)
        telegramPage = telegram.page
        telegramPortForward = telegram.portForward

        await verifyTelegramMediumWithFakeProvider(
          telegramPage,
          userToken,
          telegramMessageBase,
          verifiedTelegramIdentity
        )
        await installWorkflowRecipeForUser({ recipeName, marker, userId })
      })

      let approvalId: string | null = null
      let cancelledApprovalId: string | null = null
      let approvedDecisionMessageId: string | null = null

      await test.step('Telegram user lists granted workflows through channel-reader and first-party mcp-host', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          'List the workflow recipes I can run. Include the exact workflow recipe names.',
          telegramMessageBase + 1
        )
        await expectTelegramWorkflowList(telegramPage, [recipeName], [])
        await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(UUID_RE)
      })

      await test.step('Telegram workflow trigger with a typed typo fails fast without creating approval or run', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const typoRecipeName = recipeName.slice(1)
        const replyCountBeforeTypo = await telegramReplyItems(telegramPage).count()
        await sendTelegramClientMessage(
          telegramPage,
          `Run workflow named ${typoRecipeName} with marker: ${marker}.`,
          telegramMessageBase + 2
        )
        await waitForTelegramFinalReplyTextAfter(
          telegramPage,
          replyCountBeforeTypo,
          `Workflow not found: ${typoRecipeName}. Did you mean ${recipeName}?`,
          180_000
        )
        await expect(
          telegramPage
            .getByTestId('telegram-approval-card')
            .filter({ hasText: `Approve workflow ${recipeName}` })
        ).toHaveCount(0)
        await expect(
          telegramPage
            .getByTestId('telegram-approval-card')
            .filter({ hasText: `Approve workflow ${typoRecipeName}` })
        ).toHaveCount(0)
        await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(UUID_RE)
        expect(approvalRequestCountForRecipe(recipeName)).toBe(0)
        expect(workflowRunCountForRecipe(recipeName)).toBe(0)
        expect(approvalRequestCountForRecipe(typoRecipeName)).toBe(0)
        expect(workflowRunCountForRecipe(typoRecipeName)).toBe(0)
      })

      await test.step('Telegram user requests one workflow trigger and creates the durable provider approval', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const triggerText = [
          `Run ${recipeName} with marker: ${marker}.`,
          'Give me the workflow result in this Telegram chat after it starts.',
        ].join(' ')
        await sendTelegramClientMessage(telegramPage, triggerText, telegramMessageBase + 3)

        approvalId = await waitForPendingApprovalId(recipeName)
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(approvalRequestCountForRecipe(recipeName)).toBe(1)
        expect(workflowRunCountForApproval(approvalId)).toBe(0)

        await sendTelegramClientMessage(telegramPage, triggerText, telegramMessageBase + 3)
        await expect
          .poll(() => approvalRequestCountForRecipe(recipeName), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'retrying the same Telegram provider event must not create another approval',
          })
          .toBe(1)
        expect(workflowRunCountForRecipe(recipeName)).toBe(0)
      })

      await test.step('chatllm cancellation reconciles the provider approval cache before a fresh trigger', async () => {
        if (!approvalId) {
          throw new Error('Telegram workflow trigger approval was not initialized')
        }
        cancelledApprovalId = approvalId
        expect(workflowApprovalTriggerCaller(cancelledApprovalId)).toBe(HOST_REF)
        markWorkflowApprovalCancelledByHost(cancelledApprovalId, HOST_REF)
        expect(approvalStatus(cancelledApprovalId)).toBe('cancelled')
        await expect
          .poll(
            () =>
              sentApprovalUpdatedNotificationCountForApproval(cancelledApprovalId!, 'cancelled'),
            {
              timeout: 60_000,
              intervals: [500, 1_000, 2_000],
              message:
                'channel-reader should consume the chatllm cancellation update before a same-workflow retry',
            }
          )
          .toBe(1)
        expect(workflowRunCountForApproval(cancelledApprovalId)).toBe(0)
      })

      await test.step('Telegram user approves a fresh same-workflow request after cancellation', async () => {
        if (!telegramPage || !cancelledApprovalId) {
          throw new Error('Telegram user client or pending approval was not initialized')
        }
        const retryTriggerText = [
          `Run ${recipeName} with marker: ${marker}-after-cancel.`,
          'Give me the workflow result in this Telegram chat after it starts.',
        ].join(' ')
        await sendTelegramClientMessage(telegramPage, retryTriggerText, telegramMessageBase + 4)
        approvalId = await waitForPendingApprovalId(recipeName)
        expect(approvalId).not.toBe(cancelledApprovalId)
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(approvalRequestCountForRecipe(recipeName)).toBe(2)

        await waitForWorkflowApprovalInTelegramClient(telegramPage, recipeName)
        approvedDecisionMessageId = await approveWorkflowFromTelegramClient(
          telegramPage,
          recipeName
        )
        await expect(telegramPage.getByTestId('telegram-bot-replies')).toContainText(
          'Approved. Workflow approval recorded.',
          { timeout: 60_000 }
        )
        await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(UUID_RE)

        await expect
          .poll(() => approvalStatus(approvalId!), {
            timeout: 90_000,
            intervals: [500, 1_000, 2_000],
            message:
              'provider decision should let the waiting first-party mcp-host consume approval',
          })
          .toBe('consumed')
        await expect
          .poll(() => workflowRunCountForApproval(approvalId!), {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'provider decision should create exactly one workflow run',
          })
          .toBe(1)
        expect(providerDecisionEventSignalForApproval(approvalId)).toBe('decided:1')
        expect(workflowRunSignalForApproval(approvalId)).toBe(
          `user:onDemand:sandbox-recipes/${recipeName}`
        )
        expect(workflowRunTypedIntentSignalForApproval(approvalId)).toBe('matched:1')
      })

      await test.step('Telegram user receives the workflow result artifact through channel-reader', async () => {
        if (!telegramPage || !approvalId) {
          throw new Error('Telegram user client or consumed approval was not initialized')
        }
        const replyCountBeforeTerminal = await telegramReplyItems(telegramPage).count()
        await expect
          .poll(() => workflowRunPhaseForApproval(approvalId!), {
            timeout: 90_000,
            intervals: [500, 1_000, 2_000],
            message: 'approved workflow run should finish before Telegram asks for its output',
          })
          .toBe('Succeeded')
        const firstRunId = workflowRunIdForApproval(approvalId)
        const completionReplyPattern = new RegExp(
          `Workflow ${recipeName} completed\\. Results are ready\\.`,
          'i'
        )
        await waitForTelegramReplyTextAfter(
          telegramPage,
          replyCountBeforeTerminal,
          completionReplyPattern,
          90_000
        )
        await expect
          .poll(() => workflowRunCompletedNotificationCount(firstRunId), {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'terminal workflow run should enqueue exactly one completion notification',
          })
          .toBe(1)
        await expect
          .poll(() => sentWorkflowRunCompletedNotificationCount(firstRunId), {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'completion notification should be acknowledged as sent',
          })
          .toBe(1)

        const completionReplyCountAfterTerminal = await telegramReplyItems(telegramPage)
          .filter({ hasText: completionReplyPattern })
          .count()
        replayWorkflowTerminalPhase(firstRunId)
        await expect
          .poll(() => workflowRunCompletedNotificationCount(firstRunId), {
            timeout: 15_000,
            intervals: [500, 1_000, 2_000],
            message: 'replaying the same terminal phase must not duplicate completion delivery',
          })
          .toBe(1)
        await expect
          .poll(
            () =>
              telegramReplyItems(telegramPage!).filter({ hasText: completionReplyPattern }).count(),
            {
              timeout: 5_000,
              intervals: [500, 1_000],
              message: 'replaying terminal phase must not add another Telegram completion reply',
            }
          )
          .toBe(completionReplyCountAfterTerminal)

        await setTelegramClientIdentity(telegramPage, wrongChannelIdentity)
        await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(
          `Workflow ${recipeName} completed`
        )
        await setTelegramClientIdentity(telegramPage, unboundIdentity)
        await expect(telegramPage.getByTestId('telegram-bot-replies')).not.toContainText(
          `Workflow ${recipeName} completed`
        )
        await setTelegramClientIdentity(telegramPage, verifiedTelegramIdentity)

        const replies = telegramPage.getByTestId('telegram-bot-replies')
        await expectTelegramWorkflowResultDocument(
          telegramPage,
          'third-party-authn-first-party-mcphost-result.json',
          artifactProof
        )
        await expect(replies).not.toContainText(UUID_RE)
        await expect(replies).not.toContainText(/could not retrieve the workflow result artifact/i)
      })

      await test.step('A later valid Telegram trigger creates a fresh approval instead of reusing the consumed one', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const secondMarker = `${marker}-second`
        await sendTelegramClientMessage(
          telegramPage,
          `Run ${recipeName} with marker: ${secondMarker}.`,
          telegramMessageBase + 6
        )
        const secondApprovalId = await waitForPendingApprovalId(recipeName)
        expect(secondApprovalId).not.toBe(approvalId)
        expect(approvalStatus(secondApprovalId)).toBe('pending')
        expect(approvalRequestCountForRecipe(recipeName)).toBe(3)
        const replyCountBeforeSecondApproval = await telegramReplyItems(telegramPage).count()
        await waitForWorkflowApprovalInTelegramClient(
          telegramPage,
          recipeName,
          120_000,
          approvedDecisionMessageId ?? undefined
        )
        const secondDecisionMessageId = await approveWorkflowFromTelegramClient(
          telegramPage,
          recipeName
        )
        expect(secondDecisionMessageId).not.toBe(approvedDecisionMessageId)
        await waitForTelegramReplyTextAfter(
          telegramPage,
          replyCountBeforeSecondApproval,
          'Approved. Workflow approval recorded.',
          60_000
        )
        await expect
          .poll(() => approvalStatus(secondApprovalId), {
            timeout: 90_000,
            intervals: [500, 1_000, 2_000],
            message: 'second valid provider event should consume a fresh approval',
          })
          .toBe('consumed')
        await expect
          .poll(() => workflowRunCountForRecipe(recipeName), {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'second valid provider event should create a second run',
          })
          .toBe(2)
        expect(providerDecisionEventSignalForApproval(secondApprovalId)).toBe('decided:1')
      })
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
