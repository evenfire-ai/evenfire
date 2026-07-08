import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { K8S_CONTEXT, clearSession, loginAs } from '../workflowUi'
import {
  CHANNELS_NS,
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
import {
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  openTelegramClient,
  sendTelegramClientMessage,
  telegramReplyItems,
  waitForPendingApprovalId,
  waitForTelegramFinalReplyTextAfter,
} from './telegramE2eClient'
import {
  approvalRequestCountForRecipe,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  enrollTelegramMedium,
  installWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  pendingApprovalCountForRecipe,
  workflowRunCountForRecipe,
} from './workflowApprovalJourney'

function kubectlOutput(args: string[], timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    timeout,
  })
}

function sleepOneSecond(): void {
  execFileSync('sleep', ['1'])
}

function waitForStableFakeTelegramReader(hostName: string): void {
  const labelSelector = `app=channel-reader,clerum.io/host=${hostName}`
  let lastState = ''
  let stableChecks = 0
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const raw = kubectlOutput(
      [
        '-n',
        CHANNELS_NS,
        'get',
        'pod',
        '-l',
        labelSelector,
        '--field-selector=status.phase=Running',
        '-o',
        'json',
      ],
      10_000
    )
    const list = JSON.parse(raw) as {
      items?: Array<{
        metadata?: { name?: string; deletionTimestamp?: string }
        status?: { containerStatuses?: Array<{ ready?: boolean }> }
      }>
    }
    const pods = list.items ?? []
    const readyPods = pods.filter(item => {
      const statuses = item.status?.containerStatuses ?? []
      return (
        !item.metadata?.deletionTimestamp &&
        Boolean(item.metadata?.name) &&
        statuses.length > 0 &&
        statuses.every(status => status.ready)
      )
    })
    if (readyPods.length === 1) {
      const podName = readyPods[0].metadata!.name!
      const logs = kubectlOutput(
        ['-n', CHANNELS_NS, 'logs', `pod/${podName}`, '--tail=220'],
        15_000
      )
      if (logs.includes('[Telegram] Connected as @clerum_e2e_bot')) {
        stableChecks += 1
        if (stableChecks >= 5) return
      } else {
        stableChecks = 0
      }
      lastState = logs
    } else {
      stableChecks = 0
      lastState = `expected exactly one channel-reader pod and one ready pod, found pods=${pods.length}, ready=${readyPods.length}`
    }
    sleepOneSecond()
  }
  expect(
    lastState,
    'channel-reader must have exactly one ready pod connected to fake Telegram'
  ).toContain('[Telegram] Connected as @clerum_e2e_bot')
}

async function finalTelegramReplyTextAfter(page: Page, previousCount: number): Promise<string> {
  await expect
    .poll(
      async () => {
        const replies = await telegramReplyItems(page).evaluateAll(
          (nodes, count) =>
            nodes
              .slice(count)
              .map(node => node.textContent || '')
              .filter(text => !text.includes('Processing your request'))
              .filter(text => !text.includes('Approved. Workflow approval recorded.')),
          previousCount
        )
        return replies.at(-1) || ''
      },
      {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
        message: 'Telegram fake client should show a final bot reply for the provider message',
      }
    )
    .not.toBe('')
  const replies = await telegramReplyItems(page).evaluateAll(
    (nodes, count) =>
      nodes
        .slice(count)
        .map(node => node.textContent || '')
        .filter(text => !text.includes('Processing your request'))
        .filter(text => !text.includes('Approved. Workflow approval recorded.')),
    previousCount
  )
  return replies.at(-1) || ''
}

async function stableTelegramReplyCount(page: Page, minimum = 0): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const first = await telegramReplyItems(page).count()
    await page.waitForTimeout(100)
    const second = await telegramReplyItems(page).count()
    if (first === second && second >= minimum) return second
  }
  throw new Error(`Telegram reply count did not stabilize at or above ${minimum}`)
}

async function expectNoTelegramReply(page: Page): Promise<void> {
  await expect
    .poll(() => stableTelegramReplyCount(page), {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
      message: 'non-allowlisted Telegram sender should not receive an mcp-host reply',
    })
    .toBe(0)
}

test.describe('Telegram workflow identity gate scope regression', () => {
  test('Fake Telegram allows unverified normal chat but denies unverified workflow access', async ({
    browser,
  }) => {
    test.setTimeout(720_000)

    const unverifiedRecipe = makeScopedE2ERecipeName('identity-gate-unverified')
    const verifiedRecipe = makeScopedE2ERecipeName('identity-gate-verified')
    const unverifiedMarker = `telegram-identity-gate-unverified-${Date.now()}`
    const verifiedMarker = `telegram-identity-gate-verified-${Date.now()}`
    const telegramIdentitySeed = Date.now() % 1_000_000
    const unverifiedUser: TelegramClientIdentity = {
      providerUserId: String(830_000_000 + telegramIdentitySeed * 10 + 1),
      providerChannelId: String(840_000_000 + telegramIdentitySeed * 10 + 1),
      conversationLabel: 'Unverified Telegram private chat',
    }
    const verifiedUser: TelegramClientIdentity = {
      providerUserId: String(830_000_000 + telegramIdentitySeed * 10 + 2),
      providerChannelId: String(840_000_000 + telegramIdentitySeed * 10 + 2),
      conversationLabel: 'Verified Telegram private chat',
    }
    const nonAllowlistedUser: TelegramClientIdentity = {
      providerUserId: String(830_000_000 + telegramIdentitySeed * 10 + 3),
      providerChannelId: String(840_000_000 + telegramIdentitySeed * 10 + 3),
      conversationLabel: 'Non-allowlisted Telegram private chat',
    }
    const telegramMessageBase = Math.floor(Date.now() / 1000) * 1000
    let telegramPage: Page | null = null
    let telegramPortForward: FakeTelegramClientPortForward | null = null

    try {
      await test.step('Prepare fake Telegram identities and workflow fixtures', async () => {
        await clearSession()
        cleanupWorkflowRecipe(unverifiedRecipe)
        cleanupWorkflowRecipe(verifiedRecipe)
        cleanupTelegramMediumBinding(unverifiedUser)
        cleanupTelegramMediumBinding(verifiedUser)
        cleanupTelegramMediumBinding(nonAllowlistedUser)

        installFakeTelegramProvider()
        configureChannelReaderTelegramApiRoot()
        applyTelegramCommunicationChannel(HOST_REF, [unverifiedUser, verifiedUser])
        waitForChannelReader(HOST_REF)
        waitForStableFakeTelegramReader(HOST_REF)
        expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
        expectChannelReaderCanReachMcpHost(HOST_REF)
        await expect
          .poll(() => fakeTelegramPollingCount(), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'channel-reader should poll fake Telegram before regression messages are sent',
          })
          .toBeGreaterThan(0)

        const { userId, userToken } = await loginAs(E2E_EMAIL)
        await enrollTelegramMedium(userToken, userId, verifiedUser)
        installWorkflowRecipe({ recipeName: unverifiedRecipe, marker: unverifiedMarker })
        await installWorkflowRecipeForUser({
          recipeName: verifiedRecipe,
          marker: verifiedMarker,
          userId,
        })

        const telegram = await openTelegramClient(browser)
        telegramPage = telegram.page
        telegramPortForward = telegram.portForward
      })

      await test.step('Unverified allowlisted Telegram normal chat reaches mcp-host', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await stableTelegramReplyCount(telegramPage)
        await sendTelegramClientMessage(
          telegramPage,
          'Hello. Please answer with a short normal chat response.',
          telegramMessageBase + 11,
          unverifiedUser
        )
        const reply = await finalTelegramReplyTextAfter(telegramPage, before)
        expect(reply).not.toMatch(
          /Could not verify this Telegram conversation for workflow access/i
        )
        expect(approvalRequestCountForRecipe(unverifiedRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(unverifiedRecipe)).toBe(0)
      })

      await test.step('Unverified allowlisted Telegram workflow listing is denied', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await stableTelegramReplyCount(telegramPage, 1)
        await sendTelegramClientMessage(
          telegramPage,
          'what workflows are available?',
          telegramMessageBase + 12,
          unverifiedUser
        )
        await waitForTelegramFinalReplyTextAfter(
          telegramPage,
          before,
          /Could not verify this Telegram conversation for workflow access/i
        )
        expect(approvalRequestCountForRecipe(unverifiedRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(unverifiedRecipe)).toBe(0)
      })

      await test.step('Unverified allowlisted Telegram workflow trigger is denied', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const before = await stableTelegramReplyCount(telegramPage, 2)
        await sendTelegramClientMessage(
          telegramPage,
          `Run ${unverifiedRecipe} with marker: ${unverifiedMarker}.`,
          telegramMessageBase + 13,
          unverifiedUser
        )
        await waitForTelegramFinalReplyTextAfter(
          telegramPage,
          before,
          /Could not verify this Telegram conversation for workflow access/i
        )
        expect(pendingApprovalCountForRecipe(unverifiedRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(unverifiedRecipe)).toBe(0)
      })

      await test.step('Non-allowlisted Telegram sender is ignored by channel-reader', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        await sendTelegramClientMessage(
          telegramPage,
          'what workflows are available?',
          telegramMessageBase + 14,
          nonAllowlistedUser
        )
        await expectNoTelegramReply(telegramPage)
        expect(approvalRequestCountForRecipe(unverifiedRecipe)).toBe(0)
        expect(workflowRunCountForRecipe(unverifiedRecipe)).toBe(0)
      })

      await test.step('Verified Telegram workflow request still reaches the approved path', async () => {
        if (!telegramPage) throw new Error('Telegram user client was not initialized')
        const beforeList = await stableTelegramReplyCount(telegramPage)
        await sendTelegramClientMessage(
          telegramPage,
          'List the workflow recipes I can run. Include exact workflow recipe names only.',
          telegramMessageBase + 15,
          verifiedUser
        )
        const workflowListReply = await finalTelegramReplyTextAfter(telegramPage, beforeList)
        expect(workflowListReply).toContain(verifiedRecipe)
        expect(workflowListReply).not.toContain(unverifiedRecipe)

        await sendTelegramClientMessage(
          telegramPage,
          `Trigger the workflow recipe named ${verifiedRecipe} with marker: ${verifiedMarker}. Give me the workflow result in Telegram after it starts.`,
          telegramMessageBase + 16,
          verifiedUser
        )
        const approvalId = await waitForPendingApprovalId(verifiedRecipe)
        await approveAndExpectConsumed(
          telegramPage,
          verifiedRecipe,
          approvalId,
          'verified Telegram provider decision should consume the workflow approval',
          'verified Telegram provider decision should create exactly one workflow run'
        )
        expect(workflowRunCountForRecipe(verifiedRecipe)).toBe(1)
      })
    } finally {
      if (telegramPage) await telegramPage.close().catch(() => undefined)
      telegramPortForward?.stop()
      cleanupWorkflowRecipe(unverifiedRecipe)
      cleanupWorkflowRecipe(verifiedRecipe)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot()
      removeFakeTelegramProvider()
      cleanupTelegramMediumBinding(unverifiedUser)
      cleanupTelegramMediumBinding(verifiedUser)
      cleanupTelegramMediumBinding(nonAllowlistedUser)
    }
  })
})
