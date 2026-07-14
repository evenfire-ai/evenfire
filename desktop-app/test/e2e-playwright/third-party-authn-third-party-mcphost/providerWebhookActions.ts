import { expect } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { READER_API } from '../workflow-approval-quadrants/constants'
import { apiRequest } from '../workflowUi'
import {
  FIGURE_D_SLACK_SIGNING_SECRET,
  FIGURE_D_SLACK_WORKSPACE,
  FIGURE_D_TELEGRAM_SECRET,
} from './figureDProviderHarness'

export async function submitTelegramEnrollment(
  nonce: string,
  providerUserId: string,
  chatId: string
) {
  const res = await apiRequest(
    'POST',
    `${READER_API}/webhooks/telegram`,
    JSON.stringify({
      message: {
        text: `/start ${nonce}`,
        from: { id: providerUserId },
        chat: { id: chatId, type: 'private' },
      },
    }),
    {
      'x-telegram-bot-api-secret-token': FIGURE_D_TELEGRAM_SECRET,
    }
  )
  expect(res.status, res.body).toBe(200)
  expect(JSON.parse(res.body)).toMatchObject({ ok: true })
}

export async function submitTelegramDecision(params: {
  actionValue: string
  providerEventId: string
  providerUserId: string
  chatId: string
}) {
  const res = await apiRequest(
    'POST',
    `${READER_API}/webhooks/telegram`,
    JSON.stringify({
      callback_query: {
        id: params.providerEventId,
        data: params.actionValue,
        from: { id: params.providerUserId },
        message: { chat: { id: params.chatId, type: 'private' } },
      },
    }),
    {
      'x-telegram-bot-api-secret-token': FIGURE_D_TELEGRAM_SECRET,
    }
  )
  expect(res.status, res.body).toBe(200)
  expect(JSON.parse(res.body)).toMatchObject({ ok: true })
}

export async function submitTelegramDecisionRaw(params: {
  actionValue: string
  providerEventId: string
  providerUserId: string
  chatId: string
}) {
  return apiRequest(
    'POST',
    `${READER_API}/webhooks/telegram`,
    JSON.stringify({
      callback_query: {
        id: params.providerEventId,
        data: params.actionValue,
        from: { id: params.providerUserId },
        message: { chat: { id: params.chatId, type: 'private' } },
      },
    }),
    {
      'x-telegram-bot-api-secret-token': FIGURE_D_TELEGRAM_SECRET,
    }
  )
}

function signedSlackBody(payload: Record<string, unknown>) {
  const bodyText = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac('sha256', FIGURE_D_SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${bodyText}`)
    .digest('hex')}`
  return {
    bodyText,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
  }
}

async function submitSlackInteractionRequest(payload: Record<string, unknown>) {
  const signed = signedSlackBody(payload)
  return apiRequest('POST', `${READER_API}/webhooks/slack`, signed.bodyText, signed.headers)
}

export async function submitSlackInteraction(payload: Record<string, unknown>) {
  const res = await submitSlackInteractionRequest(payload)
  expect(res.status, res.body).toBe(200)
  const body = JSON.parse(res.body) as { ok: boolean; duplicate?: boolean }
  expect(body).toMatchObject({ ok: true })
  return body
}

export async function submitSlackEnrollment(
  nonce: string,
  providerUserId: string,
  channelId: string
) {
  const payload = {
    trigger_id: `enroll-${Date.now()}`,
    user: { id: providerUserId },
    team: { id: FIGURE_D_SLACK_WORKSPACE },
    channel: { id: channelId },
    actions: [{ value: `link:${nonce}`, action_ts: String(Date.now() / 1000) }],
  }
  await expect
    .poll(
      async () => {
        const res = await submitSlackInteractionRequest(payload)
        if (res.status !== 200) return res.body
        const body = JSON.parse(res.body) as { ok?: boolean; error?: string }
        return body.ok === true ? 'ok' : JSON.stringify(body)
      },
      { timeout: 10_000, intervals: [250, 500, 1000] }
    )
    .toBe('ok')
}
