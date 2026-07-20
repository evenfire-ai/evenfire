import { type Page, expect, test } from '@playwright/test'
import { clearSession, loginAs } from '../workflowUi'
import {
  type FakeTelegramClientPortForward,
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
import { approveAndExpectConsumed } from './telegramApprovalAssertions'
import { cleanupTelegramAuthzFixture } from './telegramAuthzCleanup'
import {
  E2E_ALT_EMAIL,
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  expectTelegramWorkflowList,
  openTelegramClient,
  sendTelegramClientMessage,
  sendTelegramClientMessageExpectRejected,
  telegramReplyItems,
  waitForPendingApprovalId,
  waitForTelegramFinalReplyTextAfter,
} from './telegramE2eClient'
import { waitForWorkflowUnavailableReply } from './telegramUnavailableAssertions'
import {
  approvalStatus,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  createE2ETeamForUser,
  enrollTelegramMedium,
  grantWorkflowRecipeToTeam,
  installWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  pendingApprovalCountForRecipe,
  workflowRunCountForApproval,
  workflowRunCountForRecipe,
} from './workflowApprovalJourney'

test.describe('3rd-party AuthN + 1st-party MCP-host through channel-reader', () => {
  test('Fake Telegram enforces account, conversation, and team grant boundaries', async ({
    browser,
  }) => {
    test.setTimeout(900_000)
    expect(process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS ?? '').not.toBe('1')

    const userARecipe = makeScopedE2ERecipeName('testuser-personal')
    const userBRecipe = makeScopedE2ERecipeName('belen-personal')
    const teamOnlyRecipe = makeScopedE2ERecipeName('acme-team')
    const membershipOnlyRecipe = makeScopedE2ERecipeName('membership-only')
    const ambiguousRecipe = makeScopedE2ERecipeName('shared-risk-review')
    const markerA = `telegram-authz-user-a-${Date.now()}`
    const markerB = `telegram-authz-user-b-${Date.now()}`
    const markerTeam = `telegram-authz-team-only-${Date.now()}`
    const markerMembership = `telegram-authz-membership-only-${Date.now()}`
    const markerAmbiguous = `telegram-authz-ambiguous-${Date.now()}`
    const teamName = `e2e-acme-risk-team-${Date.now().toString(36)}`
    const membershipOnlyTeamName = `e2e-membership-only-team-${Date.now().toString(36)}`
    const telegramIdentitySeed = Date.now() % 1_000_000
    const telegramUserA: TelegramClientIdentity = {
      providerUserId: String(800_000_000 + telegramIdentitySeed * 10 + 1),
      providerChannelId: String(800_000_000 + telegramIdentitySeed * 10 + 1),
      conversationLabel: 'Test User - Telegram private chat',
    }
    const telegramUserB: TelegramClientIdentity = {
      providerUserId: String(800_000_000 + telegramIdentitySeed * 10 + 2),
      providerChannelId: String(800_000_000 + telegramIdentitySeed * 10 + 2),
      conversationLabel: 'Belen QA - Telegram private chat',
    }
    const telegramUserAWrongChannel: TelegramClientIdentity = {
      providerUserId: telegramUserA.providerUserId,
      providerChannelId: String(810_000_000 + telegramIdentitySeed * 10 + 3),
      providerChannelType: 'group',
      conversationLabel: 'Test User - unconfigured Telegram group',
    }
    const telegramMessageBase = Math.floor(Date.now() / 1000) * 1000
    let telegramPage: Page | null = null
    let telegramPortForward: FakeTelegramClientPortForward | null = null
    let teamId: string | undefined
    let membershipOnlyTeamId: string | undefined

    try {
      await test.step('Prepare fake Telegram with two provider identities and isolated grants', async () => {
        await clearSession()
        for (const recipeName of [
          userARecipe,
          userBRecipe,
          teamOnlyRecipe,
          membershipOnlyRecipe,
          ambiguousRecipe,
        ]) {
          cleanupWorkflowRecipe(recipeName)
        }
        cleanupTelegramMediumBinding(telegramUserA)
        cleanupTelegramMediumBinding(telegramUserB)
        cleanupTelegramMediumBinding(telegramUserAWrongChannel)

        const { userId: userAId, userToken: userAToken } = await loginAs(E2E_EMAIL)
        const { userId: userBId, userToken: userBToken } = await loginAs(E2E_ALT_EMAIL)
        installFakeTelegramProvider()
        configureChannelReaderTelegramApiRoot()
        applyTelegramCommunicationChannel(
          HOST_REF,
          [telegramUserA, telegramUserB],
          [userAId, userBId]
        )
        waitForChannelReader(HOST_REF)
        expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
        expectChannelReaderCanReachMcpHost(HOST_REF)
        await expect
          .poll(() => fakeTelegramPollingCount(), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'channel-reader should poll fake Telegram before authz messages are sent',
          })
          .toBeGreaterThan(0)

        await enrollTelegramMedium(userAToken, userAId, telegramUserA)
        await enrollTelegramMedium(userBToken, userBId, telegramUserB)

        await installWorkflowRecipeForUser({
          recipeName: userARecipe,
          marker: markerA,
          userId: userAId,
        })
        await installWorkflowRecipeForUser({
          recipeName: userBRecipe,
          marker: markerB,
          userId: userBId,
        })
        await installWorkflowRecipeForUser({
          recipeName: ambiguousRecipe,
          marker: markerAmbiguous,
          userId: userAId,
        })
        installWorkflowRecipe({ recipeName: teamOnlyRecipe, marker: markerTeam })
        installWorkflowRecipe({ recipeName: membershipOnlyRecipe, marker: markerMembership })
        teamId = createE2ETeamForUser({ teamName, userId: userAId })
        membershipOnlyTeamId = createE2ETeamForUser({
          teamName: membershipOnlyTeamName,
          userId: userAId,
        })
        grantWorkflowRecipeToTeam(teamOnlyRecipe, teamId)
        grantWorkflowRecipeToTeam(ambiguousRecipe, teamId)

        const telegram = await openTelegramClient(browser)
        telegramPage = telegram.page
        telegramPortForward = telegram.portForward
      })

      await test.step('User A lists direct user and unique team workflows without typing a team', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          'List the workflow recipes I can run. Include exact workflow recipe names only.',
          telegramMessageBase + 11,
          telegramUserA
        )
        await expectTelegramWorkflowList(
          telegramPage,
          [userARecipe, teamOnlyRecipe, ambiguousRecipe],
          [userBRecipe, membershipOnlyRecipe]
        )
      })

      await test.step('User A cannot trigger User B recipe through Telegram', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await telegramReplyItems(telegramPage).count()
        await sendTelegramClientMessage(
          telegramPage,
          `Run ${userBRecipe} with marker: ${markerB}.`,
          telegramMessageBase + 12,
          telegramUserA
        )
        await waitForWorkflowUnavailableReply(telegramPage, before, userBRecipe)
        await expect(telegramPage.getByTestId('telegram-approval-card')).not.toContainText(
          userBRecipe
        )
        expect(pendingApprovalCountForRecipe(userBRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(userBRecipe)).toBe(0)
      })

      await test.step('User A team membership without workflow grant cannot list or trigger a recipe', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await telegramReplyItems(telegramPage).count()
        await sendTelegramClientMessage(
          telegramPage,
          `Run ${membershipOnlyRecipe} with marker: ${markerMembership}.`,
          telegramMessageBase + 13,
          telegramUserA
        )
        await waitForWorkflowUnavailableReply(telegramPage, before, membershipOnlyRecipe)
        await expect(telegramPage.getByTestId('telegram-approval-card')).not.toContainText(
          membershipOnlyRecipe
        )
        expect(pendingApprovalCountForRecipe(membershipOnlyRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(membershipOnlyRecipe)).toBe(0)
      })

      let teamApprovalId: string | null = null
      await test.step('User A triggers the unique team workflow by name without providing a team label', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          `Trigger the workflow recipe named ${teamOnlyRecipe} with marker: ${markerTeam}.`,
          telegramMessageBase + 14,
          telegramUserA
        )
        teamApprovalId = await waitForPendingApprovalId(teamOnlyRecipe)
        expect(approvalStatus(teamApprovalId)).toBe('pending')
        expect(workflowRunCountForApproval(teamApprovalId)).toBe(0)
        await approveAndExpectConsumed(
          telegramPage,
          teamOnlyRecipe,
          teamApprovalId,
          'User A team target provider decision should consume only that approval',
          'unique team target should create exactly one workflow run',
          { waitForFinalReply: teamOnlyRecipe }
        )
        expect(workflowRunCountForRecipe(teamOnlyRecipe)).toBe(1)
      })

      await test.step('Ambiguous personal/team workflow asks for a human label before creating approval', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await telegramReplyItems(telegramPage).count()
        await sendTelegramClientMessage(
          telegramPage,
          `Run ${ambiguousRecipe} with marker: ${markerAmbiguous}.`,
          telegramMessageBase + 16,
          telegramUserA
        )
        await waitForTelegramFinalReplyTextAfter(telegramPage, before, ambiguousRecipe)
        const replies = telegramPage.getByTestId('telegram-bot-replies')
        await expect(replies).toContainText(ambiguousRecipe, { timeout: 180_000 })
        await expect(replies).toContainText('Personal')
        await expect(replies).toContainText(teamName)
        await expect(replies).not.toContainText(teamId!)
        await expect(telegramPage.getByTestId('telegram-approval-card')).not.toContainText(
          ambiguousRecipe
        )
        expect(pendingApprovalCountForRecipe(ambiguousRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(ambiguousRecipe)).toBe(0)
      })

      await test.step('User A disambiguates by team label and completes the workflow from Telegram', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          `Trigger the workflow recipe named ${ambiguousRecipe} for team ${teamName} with marker: ${markerAmbiguous}.`,
          telegramMessageBase + 17,
          telegramUserA
        )
        const approvalId = await waitForPendingApprovalId(ambiguousRecipe)
        await approveAndExpectConsumed(
          telegramPage,
          ambiguousRecipe,
          approvalId,
          'disambiguated provider decision should consume its approval',
          'disambiguated target should create exactly one workflow run',
          { waitForFinalReply: ambiguousRecipe }
        )
        expect(workflowRunCountForRecipe(ambiguousRecipe)).toBe(1)
      })

      await test.step('Same Telegram profile from an unconfigured group does not inherit User A grants', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessageExpectRejected(
          telegramPage,
          'List the workflow recipes I can run. Include exact workflow recipe names only.',
          telegramMessageBase + 19,
          telegramUserAWrongChannel
        )
        expect(pendingApprovalCountForRecipe(userARecipe)).toBe(0)
        expect(workflowRunCountForRecipe(userARecipe)).toBe(0)
      })

      await test.step('User B sees only User B recipe and completes a Telegram approval/run', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          'List the workflow recipes I can run. Include exact workflow recipe names only.',
          telegramMessageBase + 21,
          telegramUserB
        )
        await expectTelegramWorkflowList(
          telegramPage,
          [userBRecipe],
          [userARecipe, teamOnlyRecipe, ambiguousRecipe]
        )

        await sendTelegramClientMessage(
          telegramPage,
          `Run ${userBRecipe} now with marker: ${markerB}. Start a new workflow run; do not check the status of an existing run.`,
          telegramMessageBase + 22,
          telegramUserB
        )
        const approvalId = await waitForPendingApprovalId(userBRecipe)
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(workflowRunCountForApproval(approvalId)).toBe(0)
        await approveAndExpectConsumed(
          telegramPage,
          userBRecipe,
          approvalId,
          'User B provider decision should consume only User B approval',
          'User B provider decision should create exactly one workflow run',
          { waitForFinalReply: userBRecipe }
        )
        expect(workflowRunCountForRecipe(userARecipe)).toBe(0)
        expect(workflowRunCountForRecipe(teamOnlyRecipe)).toBe(1)
        expect(workflowRunCountForRecipe(membershipOnlyRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(ambiguousRecipe)).toBe(1)
      })
    } finally {
      if (telegramPage) await telegramPage.close().catch(() => undefined)
      telegramPortForward?.stop()
      cleanupTelegramAuthzFixture({
        recipeNames: [
          userARecipe,
          userBRecipe,
          teamOnlyRecipe,
          membershipOnlyRecipe,
          ambiguousRecipe,
        ],
        teamIds: [teamId, membershipOnlyTeamId],
        identities: [telegramUserA, telegramUserB, telegramUserAWrongChannel],
      })
    }
  })
})
