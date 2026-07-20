import { type Page, expect } from '@playwright/test'
import { EXT_API, apiRequest } from '../workflowUi'
import { TELEGRAM_CHANNEL_NAME } from './fakeTelegramProvider'
import {
  DEFAULT_TELEGRAM_CLIENT_IDENTITY,
  type TelegramClientIdentity,
  sendTelegramClientMessage,
  telegramReplyItems,
  waitForTelegramReplyTextAfter,
} from './telegramE2eClient'

type ApprovalChannelTarget = {
  id: string
  medium: 'telegram'
  channelName?: string
}

type TelegramProviderEventChallenge = {
  challengeId: string
  code: string
}

export async function createTelegramProviderEventChallenge(
  sessionToken: string
): Promise<TelegramProviderEventChallenge> {
  const targets = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflow-approval-mediums/targets`,
    undefined,
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(targets.status, targets.body).toBe(200)

  const targetItems = (JSON.parse(targets.body) as { items?: ApprovalChannelTarget[] }).items ?? []
  const target =
    targetItems.find(
      item => item.medium === 'telegram' && item.channelName === TELEGRAM_CHANNEL_NAME
    ) ?? targetItems.find(item => item.medium === 'telegram')
  expect(target?.id, 'user should have an accessible Telegram approval target').toBeTruthy()

  const challenge = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflow-approval-mediums/challenges`,
    JSON.stringify({ medium: 'telegram', targetId: target!.id }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(challenge.status, challenge.body).toBe(202)

  const parsed = JSON.parse(challenge.body) as { challengeId?: string; code?: string }
  expect(parsed.challengeId).toMatch(/^[0-9a-f-]{36}$/)
  expect(parsed.code).toMatch(/^\d{6}$/)
  return { challengeId: parsed.challengeId!, code: parsed.code! }
}

export async function verifyTelegramMediumWithFakeProvider(
  page: Page,
  sessionToken: string,
  messageId: number,
  identity: TelegramClientIdentity = DEFAULT_TELEGRAM_CLIENT_IDENTITY
): Promise<void> {
  const challenge = await createTelegramProviderEventChallenge(sessionToken)
  const replyCount = await telegramReplyItems(page).count()
  await sendTelegramClientMessage(page, `/verify ${challenge.code}`, messageId, identity)
  await waitForTelegramReplyTextAfter(page, replyCount, /Telegram identity confirmed/)
}
