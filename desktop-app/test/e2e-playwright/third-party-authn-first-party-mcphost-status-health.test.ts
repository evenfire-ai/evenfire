/**
 * Complements the full fake Telegram approval journey by proving status and
 * health checks through the same channel-reader -> first-party mcp-host route.
 */
import { type Browser, type Locator, type Page, expect, test } from '@playwright/test'
import {
  type FakeTelegramClientPortForward,
  TELEGRAM_CHAT_ID,
  TELEGRAM_PROVIDER_USER_ID,
  applyTelegramCommunicationChannel,
  configureChannelReaderTelegramApiRoot,
  expectChannelReaderCanReachMcpHost,
  expectChannelReaderHasNoProviderHttpIngress,
  fakeTelegramPollingCount,
  installFakeTelegramProvider,
  openFakeTelegramClientPortForward,
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
  waitForChannelReader,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import {
  markProviderMessageSent,
  waitBeforeProviderMessage,
} from './third-party-authn-first-party-mcphost/providerMessagePacing'
import { waitForPendingApprovalId } from './third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  type TelegramMediumBinding,
  approvalStatus,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  enrollTelegramMedium,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  providerDecisionEventSignal,
  workflowRunCountForApproval,
  workflowRunCountForRecipe,
  workflowRunPhaseForApproval,
  workflowRunSignalForApproval,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { clearSession, loginAs } from './workflowUi'

const E2E_EMAIL = process.env.E2E_EMAIL || 'test@clerum.io'
const HOST_REF = process.env.E2E_SHARED_MCP_HOST_NAME || process.env.E2E_HOST_REF || 'chatllm'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

type TelegramClientIdentity = TelegramMediumBinding & {
  conversationLabel: string
}

const DEFAULT_TELEGRAM_CLIENT_IDENTITY: TelegramClientIdentity = {
  providerUserId: TELEGRAM_PROVIDER_USER_ID,
  providerChannelId: TELEGRAM_CHAT_ID,
  conversationLabel: 'Test User - Telegram private chat',
}

async function click(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  await locator.click()
}

async function openTelegramClient(browser: Browser): Promise<{
  page: Page
  portForward: FakeTelegramClientPortForward
}> {
  const portForward = await openFakeTelegramClientPortForward()
  const page = await browser.newPage()
  await page.goto(portForward.url)
  await expect(page.getByRole('heading', { name: 'Telegram E2E Client' })).toBeVisible()
  await expect(page.getByTestId('telegram-conversation-card')).toContainText(
    DEFAULT_TELEGRAM_CLIENT_IDENTITY.conversationLabel
  )
  await expectCurrentTelegramTechnicalIdsHidden(page)
  return { page, portForward }
}

async function expectCurrentTelegramTechnicalIdsHidden(page: Page): Promise<void> {
  const main = page.locator('main')
  const providerUserId = (await page.getByTestId('telegram-provider-user-id').inputValue()).trim()
  const providerChannelId = (
    await page.getByTestId('telegram-provider-channel-id').inputValue()
  ).trim()
  if (providerUserId) await expect(main).not.toContainText(providerUserId)
  if (providerChannelId) await expect(main).not.toContainText(providerChannelId)
}

function telegramReplyItems(page: Page): Locator {
  return page.getByTestId('telegram-bot-replies').getByTestId('telegram-bot-reply')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function sendTelegramClientMessage(
  page: Page,
  text: string,
  messageId: number
): Promise<void> {
  await waitBeforeProviderMessage(page)
  await page.getByTestId('telegram-message-id').evaluate((element, value) => {
    ;(element as HTMLInputElement).value = value
  }, String(messageId))
  await page.getByTestId('telegram-message-text').fill(text)
  await click(page.getByTestId('telegram-send'))
  await expect(page.getByTestId('telegram-status')).toContainText('Telegram message sent', {
    timeout: 10_000,
  })
  markProviderMessageSent(page)
  await expectCurrentTelegramTechnicalIdsHidden(page)
}

async function waitForTelegramFinalReplyTextAfter(
  page: Page,
  previousCount: number,
  expectedText: RegExp,
  timeout = 180_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const replies = await telegramReplyItems(page).evaluateAll(
          (nodes, count) => nodes.slice(count).map(node => node.textContent || ''),
          previousCount
        )
        return replies.some(text => {
          if (text.includes('Processing your request')) return false
          if (text.includes('Approved. Workflow approval recorded.')) return false
          return expectedText.test(text)
        })
      },
      {
        timeout,
        intervals: [500, 1_000, 2_000],
        message: `Telegram fake client should show a final bot reply matching ${expectedText}`,
      }
    )
    .toBe(true)
}

async function waitForWorkflowApprovalInTelegramClient(
  page: Page,
  recipeName: string
): Promise<void> {
  const card = page.getByTestId('telegram-approval-card')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText(`Approve workflow ${recipeName}`, { timeout: 120_000 })
  await expect(card).not.toContainText(UUID_RE)
}

async function approveWorkflowFromTelegramClient(page: Page, recipeName: string): Promise<string> {
  const button = page.getByTestId('telegram-approve-workflow')
  const decisionMessageId = await button.evaluate(element => {
    const value = (element as HTMLElement).dataset.decisionMessageId || ''
    return value.trim()
  })
  expect(decisionMessageId).toMatch(/^\d+$/)
  await waitBeforeProviderMessage(page)
  await click(button)
  await expect(page.getByTestId('telegram-message-text')).toHaveValue(`/approve ${recipeName}`)
  await expect(page.getByTestId('telegram-message-text')).not.toHaveValue(UUID_RE)
  await expect(page.getByTestId('telegram-status')).toContainText('Telegram message sent', {
    timeout: 10_000,
  })
  markProviderMessageSent(page)
  return decisionMessageId
}

test.describe('fake Telegram workflow status and health through first-party mcp-host', () => {
  test('Telegram can check workflow_status and workflow_health after provider approval', async ({
    browser,
  }) => {
    test.setTimeout(600_000)
    expect(process.env.E2E_WORKFLOW_APPROVAL_QUADRANTS ?? '').not.toBe('1')

    const recipeName = makeScopedE2ERecipeName('telegram-status-health')
    const marker = `telegram-status-health-${Date.now()}`
    const telegramMessageBase = Math.floor(Date.now() / 1000) * 1000
    let telegramPage: Page | null = null
    let telegramPortForward: FakeTelegramClientPortForward | null = null

    try {
      await clearSession()
      cleanupWorkflowRecipe(recipeName)
      cleanupTelegramMediumBinding()

      installFakeTelegramProvider()
      configureChannelReaderTelegramApiRoot()
      applyTelegramCommunicationChannel(HOST_REF)
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

      const { userId, userToken } = await loginAs(E2E_EMAIL)
      await enrollTelegramMedium(userToken, userId)
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
      const decisionEventId = `telegram:${TELEGRAM_CHAT_ID}:${decisionMessageId}`
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
        `autonomous:autonomous:sandbox-recipes/${recipeName}`
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
      cleanupTelegramMediumBinding()
    }
  })
})
