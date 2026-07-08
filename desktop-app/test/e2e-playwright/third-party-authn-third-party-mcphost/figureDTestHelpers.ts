import { type Page, expect } from '@playwright/test'
import { profilesSql, sqlLiteral } from '../workflow-approval-quadrants/cluster'
import { providerDecisionCount, providerEventResult } from './figureDApprovalSignals'
import { providerRequests } from './figureDProviderApi'
import { expectedFigureDReaderEventId } from './figureDProviderHarness'
import { submitTelegramDecision } from './providerWebhookActions'

const APPROVE_ACTION_VALUE_RE =
  /^(?:approve:[0-9a-f-]{36}:sandbox-recipes\/[a-z0-9.-]+(?::[a-f0-9]{16})?|a:[A-Za-z0-9_-]{22}:~[a-f0-9]{16}(?::[a-f0-9]{16})?)$/i
const DENY_ACTION_VALUE_RE =
  /^(?:deny:[0-9a-f-]{36}:sandbox-recipes\/[a-z0-9.-]+(?::[a-f0-9]{16})?|d:[A-Za-z0-9_-]{22}:~[a-f0-9]{16}(?::[a-f0-9]{16})?)$/i

export function logFigureD(message: string): void {
  process.stderr.write(`[figure-d] ${message}\n`)
}

export async function expectFigureDHealth(url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 2_000)
        try {
          const response = await fetch(url, { signal: controller.signal })
          return response.status
        } catch {
          return 0
        } finally {
          clearTimeout(timeout)
        }
      },
      { timeout: 30_000, intervals: [250, 500, 1000, 2000] }
    )
    .toBe(200)
}

export async function reloadApprovalDms(
  page: Page,
  medium: 'telegram' | 'slack',
  expectedId: string
) {
  await page.getByRole('button', { name: 'Reload approval DMs' }).click()
  const row = page.getByRole('row').filter({ hasText: expectedId })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText(medium)
}

export async function waitForProviderAction(
  providerUrl: string,
  medium: 'telegram' | 'slack',
  recipeName: string,
  label: 'Approve' | 'Deny',
  expectedProviderChannelId?: string
): Promise<string> {
  let actionValue = ''
  await expect
    .poll(
      async () => {
        const requests = await providerRequests(providerUrl)
        const request = requests.find(item => {
          const text = String(item.body.text || '')
          const actualChannelId =
            medium === 'telegram'
              ? String(item.body.chat_id || '')
              : String(item.body.channel || '')
          return (
            item.path.includes(medium === 'telegram' ? 'sendMessage' : 'chat.postMessage') &&
            text.includes(recipeName) &&
            (!expectedProviderChannelId || actualChannelId === expectedProviderChannelId)
          )
        })
        if (!request) return ''
        if (medium === 'telegram') {
          const keyboard = (request.body.reply_markup as any)?.inline_keyboard?.[0] ?? []
          actionValue = String(
            keyboard.find((action: any) => action.text === label)?.callback_data || ''
          )
          return actionValue
        }
        const blocks = Array.isArray(request.body.blocks) ? request.body.blocks : []
        const actions =
          (blocks.find((block: any) => block.type === 'actions') as any)?.elements ?? []
        actionValue = String(
          actions.find((action: any) => action.text?.text === label)?.value || ''
        )
        return actionValue
      },
      { timeout: 120_000, intervals: [500, 1000, 2000, 5000] }
    )
    .toMatch(label === 'Approve' ? APPROVE_ACTION_VALUE_RE : DENY_ACTION_VALUE_RE)
  return actionValue
}

function triggerApprovalId(actionValue: string): string {
  const legacyId =
    actionValue.match(
      /^[a-z]+:([0-9a-f-]{36}):sandbox-recipes\/[a-z0-9.-]+(?::[a-f0-9]{16})?$/i
    )?.[1] || ''
  if (legacyId) return legacyId
  const compactId =
    actionValue.match(/^[ad]:([A-Za-z0-9_-]{22}):~[a-f0-9]{16}(?::[a-f0-9]{16})?$/i)?.[1] || ''
  const bytes = Buffer.from(
    compactId
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(compactId.length / 4) * 4, '='),
    'base64'
  )
  expect(bytes.length).toBe(16)
  const hex = bytes.toString('hex')
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`
  expect(id).toMatch(/^[0-9a-f-]{36}$/i)
  return id
}

export async function approveLatestTelegramDm(params: {
  providerUrl: string
  recipeName: string
  telegramUserId: string
  telegramChatId: string
  providerEventId: string
}): Promise<string> {
  const actionValue = await waitForProviderAction(
    params.providerUrl,
    'telegram',
    params.recipeName,
    'Approve',
    params.telegramChatId
  )
  const approvalId = triggerApprovalId(actionValue)
  await submitTelegramDecision({
    actionValue,
    providerEventId: params.providerEventId,
    providerUserId: params.telegramUserId,
    chatId: params.telegramChatId,
  })
  const eventId = expectedFigureDReaderEventId(
    'telegram',
    params.telegramChatId,
    params.providerEventId
  )
  await expect
    .poll(() => providerEventResult('telegram', eventId), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe('decided:1')
  expect(providerDecisionCount(approvalId)).toBe(1)
  return approvalId
}

export async function denyLatestTelegramDm(params: {
  providerUrl: string
  recipeName: string
  telegramUserId: string
  telegramChatId: string
  providerEventId: string
}): Promise<string> {
  const actionValue = await waitForProviderAction(
    params.providerUrl,
    'telegram',
    params.recipeName,
    'Deny',
    params.telegramChatId
  )
  const approvalId = triggerApprovalId(actionValue)
  await submitTelegramDecision({
    actionValue,
    providerEventId: params.providerEventId,
    providerUserId: params.telegramUserId,
    chatId: params.telegramChatId,
  })
  const eventId = expectedFigureDReaderEventId(
    'telegram',
    params.telegramChatId,
    params.providerEventId
  )
  await expect
    .poll(() => providerEventResult('telegram', eventId), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe('decided:1')
  expect(providerDecisionCount(approvalId)).toBe(1)
  return approvalId
}

export function mediumAccountIds(providerUserIds: string[]): string[] {
  if (providerUserIds.length === 0) return []
  const raw = profilesSql(`
    SELECT id::text
      FROM workflow_approval_medium_accounts
     WHERE provider_user_id IN (${providerUserIds.map(sqlLiteral).join(', ')});
  `)
  return raw.split(/\s+/).filter(Boolean)
}
