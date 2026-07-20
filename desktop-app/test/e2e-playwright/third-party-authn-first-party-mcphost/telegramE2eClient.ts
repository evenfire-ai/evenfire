import { type Browser, type Locator, type Page, expect } from '@playwright/test'
import { openWorkflowsPage, selectWorkflow, shortRunId } from '../workflowUi'
import {
  type FakeTelegramClientPortForward,
  TELEGRAM_CHAT_ID,
  TELEGRAM_PROVIDER_USER_ID,
  channelReaderProviderMessageAuthorizationSignal,
  fakeTelegramSentMessages,
  openFakeTelegramClientPortForward,
} from './fakeTelegramProvider'
import { markProviderMessageSent, waitBeforeProviderMessage } from './providerMessagePacing'
import {
  type TelegramMediumBinding,
  latestPendingApprovalIdOrNull,
} from './workflowApprovalJourney'

export const E2E_EMAIL = process.env.E2E_EMAIL || 'test@clerum.io'
export const E2E_ALT_EMAIL =
  process.env.E2E_EMAIL_ALT || process.env.E2E_DEV_LOGIN_EMAIL_2 || 'test2@clerum.io'
export const HOST_REF =
  process.env.E2E_SHARED_MCP_HOST_NAME || process.env.E2E_HOST_REF || 'chatllm'
export const HUMAN_E2E_RECORDED = process.env.HUMAN_E2E_RECORDED === '1'
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export type TelegramClientIdentity = TelegramMediumBinding & {
  conversationLabel: string
  providerChannelType?: 'private' | 'group' | 'supergroup'
}

export const DEFAULT_TELEGRAM_CLIENT_IDENTITY: TelegramClientIdentity = {
  providerUserId: TELEGRAM_PROVIDER_USER_ID,
  providerChannelId: TELEGRAM_CHAT_ID,
  conversationLabel: 'Test User - Telegram private chat',
}

async function humanPause(minMs = 220, maxMs = 520): Promise<void> {
  if (!HUMAN_E2E_RECORDED) return
  const delay = Math.floor(minMs + Math.random() * (maxMs - minMs + 1))
  await new Promise(resolve => setTimeout(resolve, delay))
}

export async function humanClick(locator: Locator): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.click()
    return
  }
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  await humanPause(260, 720)
  const box = await locator.boundingBox()
  if (box) {
    await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 16,
    })
  } else {
    await locator.hover()
  }
  await humanPause(140, 360)
  await locator.click({ delay: 80 })
  await humanPause(280, 760)
}

async function humanType(locator: Locator, value: string): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.fill(value)
    return
  }
  await humanClick(locator)
  await locator.fill('')
  await locator.pressSequentially(value, { delay: 12 })
  await humanPause(320, 720)
}

export async function waitForNotificationStreamReady(page: Page): Promise<void> {
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

export async function waitForPendingApprovalId(
  recipeName: string,
  timeout = 300_000
): Promise<string> {
  await expect
    .poll(() => latestPendingApprovalIdOrNull(recipeName), {
      timeout,
      intervals: [500, 1_000, 2_000],
      message: 'Telegram workflow_trigger should create a durable pending workflow approval',
    })
    .toMatch(/^[0-9a-f-]{36}$/)
  const approvalId = latestPendingApprovalIdOrNull(recipeName)
  if (!approvalId) throw new Error(`approval was not created for ${recipeName}`)
  return approvalId
}

export async function expectDesktopPendingApprovalVisible(
  page: Page,
  recipeName: string
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') await humanClick(bell)
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: recipeName }).first()
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card.getByTestId('workflow-approval-approve')).toBeVisible()
}

export async function expectPendingApprovalCleared(page: Page, recipeName: string): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  if ((await bell.getAttribute('aria-expanded')) !== 'true') await humanClick(bell)
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: recipeName }).first()
  await expect(card).toHaveCount(0)
  await expect(panel.getByTestId('workflow-approval-approve')).toHaveCount(0)
}

export async function expectWorkflowRunVisible(
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

export async function openTelegramClient(browser: Browser): Promise<{
  page: Page
  portForward: FakeTelegramClientPortForward
}> {
  const portForward = await openFakeTelegramClientPortForward()
  const page = await browser.newPage()
  await page.goto(portForward.url)
  await expect(page.getByRole('heading', { name: 'Telegram E2E Client' })).toBeVisible()
  await expectTelegramHumanIdentity(page, DEFAULT_TELEGRAM_CLIENT_IDENTITY)
  return { page, portForward }
}

export async function waitForWorkflowApprovalInTelegramClient(
  page: Page,
  recipeName: string,
  timeout = 120_000,
  previousDecisionMessageId?: string
): Promise<string> {
  const card = page.getByTestId('telegram-approval-card')
  await expect(card).toBeVisible({ timeout })
  await expect(card).toContainText(`Approve workflow ${recipeName}`, { timeout })
  await expect(card).not.toContainText(UUID_RE)
  const button = page.getByTestId('telegram-approve-workflow')
  await expect
    .poll(async () => (await button.getAttribute('data-decision-message-id'))?.trim() || '', {
      timeout,
      intervals: [500, 1_000, 2_000],
      message: 'Telegram approval card should expose a fresh provider decision message id',
    })
    .toMatch(/^\d+$/)
  if (previousDecisionMessageId) {
    await expect
      .poll(async () => (await button.getAttribute('data-decision-message-id'))?.trim() || '', {
        timeout,
        intervals: [500, 1_000, 2_000],
        message: 'Telegram approval card should advance to the new workflow approval request',
      })
      .not.toBe(previousDecisionMessageId)
  }
  const decisionMessageId = (await button.getAttribute('data-decision-message-id'))?.trim() || ''
  expect(decisionMessageId).toMatch(/^\d+$/)
  return decisionMessageId
}

export async function sendTelegramClientMessage(
  page: Page,
  text: string,
  messageId: number,
  identity?: TelegramClientIdentity
): Promise<void> {
  if (identity) await setTelegramClientIdentity(page, identity)
  await waitBeforeProviderMessage(page)
  await page.getByTestId('telegram-message-id').evaluate((element, value) => {
    ;(element as HTMLInputElement).value = value
  }, String(messageId))
  await humanType(page.getByTestId('telegram-message-text'), text)
  await humanClick(page.getByTestId('telegram-send'))
  await expect(page.getByTestId('telegram-status')).toContainText('Telegram message sent', {
    timeout: 10_000,
  })
  markProviderMessageSent(page)
  await expectCurrentTelegramTechnicalIdsHidden(page)
}

export async function sendTelegramClientMessageExpectRejected(
  page: Page,
  text: string,
  messageId: number,
  identity: TelegramClientIdentity
): Promise<void> {
  const outboundBefore = fakeTelegramSentMessages(identity.providerChannelId).length
  await sendTelegramClientMessage(page, text, messageId, identity)

  await expect
    .poll(
      () =>
        channelReaderProviderMessageAuthorizationSignal({
          hostName: HOST_REF,
          providerUserId: identity.providerUserId,
          providerChannelId: identity.providerChannelId,
          messageId,
        }),
      {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: 'channel-reader should fail closed for the rejected Telegram provider message',
      }
    )
    .toMatch(/^(?:control-plane|adapter)-denied:/)

  expect(fakeTelegramSentMessages(identity.providerChannelId)).toHaveLength(outboundBefore)
  await expect(telegramReplyItems(page)).toHaveCount(outboundBefore)
}

export async function setTelegramClientIdentity(
  page: Page,
  identity: TelegramClientIdentity
): Promise<void> {
  await page.evaluate(selectedIdentity => {
    const register = (window as any).__registerTelegramConversation
    if (typeof register !== 'function') {
      throw new Error('Fake Telegram client did not expose conversation registration')
    }
    register(selectedIdentity)
  }, identity)
  await page.getByTestId('telegram-conversation-select').selectOption({
    label: identity.conversationLabel,
  })
  await expectTelegramHumanIdentity(page, identity)
}

export async function expectTelegramHumanIdentity(
  page: Page,
  identity: TelegramClientIdentity
): Promise<void> {
  await expect(page.getByTestId('telegram-conversation-card')).toContainText(
    identity.conversationLabel
  )
  await expect(page.getByTestId('telegram-conversation-select')).toHaveValue(
    identity.conversationLabel
  )
  await expectCurrentTelegramTechnicalIdsHidden(page)
}

export async function expectCurrentTelegramTechnicalIdsHidden(page: Page): Promise<void> {
  const main = page.locator('main')
  const providerUserId = (await page.getByTestId('telegram-provider-user-id').inputValue()).trim()
  const providerChannelId = (
    await page.getByTestId('telegram-provider-channel-id').inputValue()
  ).trim()
  if (providerUserId) await expect(main).not.toContainText(providerUserId)
  if (providerChannelId) await expect(main).not.toContainText(providerChannelId)
}

export function telegramReplyItems(page: Page): Locator {
  return page.getByTestId('telegram-bot-replies').getByTestId('telegram-bot-reply')
}

export async function waitForTelegramReplyAfter(page: Page, previousCount: number): Promise<void> {
  await expect
    .poll(() => telegramReplyItems(page).count(), {
      timeout: 180_000,
      intervals: [500, 1_000, 2_000],
      message: 'Telegram fake client should show a new bot reply for the visible chat',
    })
    .toBeGreaterThan(previousCount)
}

export async function waitForTelegramReplyTextAfter(
  page: Page,
  previousCount: number,
  expectedText: string | RegExp,
  timeout = 180_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const replies = await telegramReplyItems(page).evaluateAll(
          (nodes, count) => nodes.slice(count).map(node => node.textContent || ''),
          previousCount
        )
        return replies.some(text =>
          typeof expectedText === 'string' ? text.includes(expectedText) : expectedText.test(text)
        )
      },
      {
        timeout,
        intervals: [500, 1_000, 2_000],
        message: `Telegram fake client should show a new bot reply containing ${String(expectedText)}`,
      }
    )
    .toBe(true)
}

export async function waitForTelegramFinalReplyTextAfter(
  page: Page,
  previousCount: number,
  expectedText: string | RegExp,
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
          const matches =
            typeof expectedText === 'string' ? text.includes(expectedText) : expectedText.test(text)
          return matches
        })
      },
      {
        timeout,
        intervals: [500, 1_000, 2_000],
        message: `Telegram fake client should show a final bot reply containing ${String(expectedText)}`,
      }
    )
    .toBe(true)
}

export async function expectTelegramWorkflowList(
  page: Page,
  expectedRecipes: string[],
  forbiddenRecipes: string[],
  timeout = 180_000
): Promise<void> {
  const list = page.getByTestId('telegram-workflow-list')
  for (const recipe of expectedRecipes) {
    await expect(list).toContainText(recipe, { timeout })
  }
  for (const recipe of forbiddenRecipes) {
    await expect(list).not.toContainText(recipe)
  }
  await expect(list).not.toContainText('third-party-authn-first-party-mcphost')
  await expect(page.getByTestId('telegram-bot-replies')).not.toContainText(UUID_RE)
}

export async function expectTelegramWorkflowResultDocument(
  page: Page,
  filename: string,
  artifactProof: string,
  timeout = 180_000
): Promise<void> {
  const documentReply = page.locator(`[data-document-filename="${filename}"]`)
  await expect(documentReply).toHaveCount(1, { timeout })
  await expect(documentReply).toBeVisible({ timeout })
  await expect(documentReply).toHaveAttribute('data-document-mime', 'application/octet-stream')
  await expect(documentReply).toContainText('bytes')
  await expect(documentReply).toContainText('Workflow artifact')
  await expect(documentReply).toHaveAttribute('data-document-sample', new RegExp(artifactProof))
  await expect(documentReply).toHaveAttribute('data-document-sha256', /^[a-f0-9]{64}$/)
  await expect(documentReply).not.toContainText(UUID_RE)
}

export async function approveWorkflowFromTelegramClient(
  page: Page,
  recipeName: string
): Promise<string> {
  const button = page.getByTestId('telegram-approve-workflow')
  const decisionMessageId = await button.evaluate(element => {
    const value = (element as HTMLElement).dataset.decisionMessageId || ''
    return value.trim()
  })
  expect(decisionMessageId).toMatch(/^\d+$/)
  await waitBeforeProviderMessage(page)
  await humanClick(button)
  await expect(page.getByTestId('telegram-message-text')).toHaveValue(`/approve ${recipeName}`)
  await expect(page.getByTestId('telegram-message-text')).not.toHaveValue(UUID_RE)
  await expect(page.getByTestId('telegram-status')).toContainText('Telegram message sent', {
    timeout: 10_000,
  })
  markProviderMessageSent(page)
  return decisionMessageId
}
