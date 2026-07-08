import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  normalizeGenericDecision,
  normalizeProviderEnrollment,
  normalizeProviderDecision,
  normalizeProviderMessage,
  normalizeSlackDecision,
  normalizeTelegramDecision,
} from '../src/decisionHandler.js'

const APPROVAL_ID = '99999999-8888-7777-6666-555555555555'
const COMPACT_APPROVAL_ID = Buffer.from(APPROVAL_ID.replace(/-/g, ''), 'hex').toString(
  'base64url'
)
const RUNTIME_ROUTE_ALIAS = createHash('sha256')
  .update('sandbox-recipes/runtime-recipe')
  .digest('hex')
  .slice(0, 16)

describe('decisionHandler', () => {
  it('normalizes generic provider payloads', () => {
    expect(
      normalizeGenericDecision('telegram', {
        approvalRequestId: APPROVAL_ID,
        providerUserId: '123',
        providerEventId: 'event-1',
        decision: 'approve',
      })
    ).toMatchObject({ approvalRequestId: APPROVAL_ID, providerUserId: '123' })
  })

  it('normalizes Telegram callback queries', () => {
    expect(
      normalizeTelegramDecision({
        callback_query: {
          id: 'tg-event',
          data: `approve:${APPROVAL_ID}:sandbox-recipes/runtime-recipe`,
          from: { id: 123 },
          message: { chat: { id: 456 } },
        },
      })
    ).toMatchObject({
      medium: 'telegram',
      decision: 'approve',
      mcpHostRef: 'sandbox-recipes/runtime-recipe',
      providerUserId: '123',
      providerChannelId: '456',
      providerEventId: 'telegram:456:tg-event',
    })
  })

  it('normalizes compact Telegram callback data under the provider byte limit', () => {
    const callbackData = `a:${COMPACT_APPROVAL_ID}:~${RUNTIME_ROUTE_ALIAS}`
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    expect(
      normalizeTelegramDecision({
        callback_query: {
          id: 'tg-event',
          data: callbackData,
          from: { id: 123 },
          message: { chat: { id: 456 } },
        },
      })
    ).toMatchObject({
      medium: 'telegram',
      decision: 'approve',
      approvalRequestId: APPROVAL_ID,
      mcpHostRef: `sandbox-recipes/~${RUNTIME_ROUTE_ALIAS}`,
      providerUserId: '123',
      providerChannelId: '456',
    })
  })

  it('extracts the Figure D channelAlias from the 4th callback_data segment', () => {
    const channelAlias = 'abcdef0123456789' // 16 hex / 64-bit
    const callbackData = `a:${COMPACT_APPROVAL_ID}:~${RUNTIME_ROUTE_ALIAS}:${channelAlias}`
    // 16-hex channelAlias must still fit Telegram's 64-byte callback_data budget.
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    const result = normalizeTelegramDecision({
      callback_query: {
        id: 'tg-event',
        data: callbackData,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })
    expect(result).toMatchObject({
      decision: 'approve',
      approvalRequestId: APPROVAL_ID,
      mcpHostRef: `sandbox-recipes/~${RUNTIME_ROUTE_ALIAS}`,
      channelAlias,
    })
  })

  it('long-form Telegram callback_data carries NO channelAlias (legacy / Figure C)', () => {
    const result = normalizeTelegramDecision({
      callback_query: {
        id: 'tg-event',
        data: `approve:${APPROVAL_ID}:sandbox-recipes/runtime-recipe`,
        from: { id: 123 },
        message: { chat: { id: 456 } },
      },
    })
    expect(result).toMatchObject({ decision: 'approve', mcpHostRef: 'sandbox-recipes/runtime-recipe' })
    expect(result?.channelAlias).toBeUndefined()
  })

  it('rejects Telegram action payloads routed to chatllm', () => {
    expect(
      normalizeTelegramDecision({
        callback_query: {
          id: 'tg-event',
          data: `approve:${APPROVAL_ID}:chatllm`,
          from: { id: 123 },
          message: { chat: { id: 456 } },
        },
      })
    ).toBeNull()
  })

  it('rejects Telegram opaque action tokens without a resolvable approval id', () => {
    expect(
      normalizeTelegramDecision({
        callback_query: {
          id: 'tg-event',
          data: 'wa:11111111-1111-4111-8111-111111111111',
          from: { id: 123 },
          message: { chat: { id: 456 } },
        },
      })
    ).toBeNull()
  })

  it('normalizes Slack action payloads', () => {
    const channelAlias = 'abcdef0123456789'
    expect(
      normalizeSlackDecision({
        trigger_id: 'slack-event',
        actions: [{ value: `deny:${APPROVAL_ID}:sandbox-recipes/runtime-recipe:${channelAlias}` }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
      })
    ).toMatchObject({
      medium: 'slack',
      decision: 'deny',
      mcpHostRef: 'sandbox-recipes/runtime-recipe',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:slack-event',
      channelAlias,
    })
  })

  it('rejects Slack opaque action tokens without a resolvable approval id', () => {
    expect(
      normalizeSlackDecision({
        trigger_id: 'slack-event',
        actions: [{ value: 'wa:11111111-1111-4111-8111-111111111111' }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
      })
    ).toBeNull()
  })

  it('normalizes Telegram /start enrollment callbacks', () => {
    expect(
      normalizeProviderEnrollment('telegram', {
        message: {
          text: '/start nonce_1234567890123456',
          from: { id: 123 },
          chat: { id: 456 },
        },
      })
    ).toMatchObject({
      medium: 'telegram',
      nonce: 'nonce_1234567890123456',
      providerUserId: '123',
      providerChannelId: '456',
    })
  })

  it('normalizes Slack link enrollment interactions', () => {
    expect(
      normalizeProviderEnrollment('slack', {
        actions: [{ value: 'workflow_approval_link:123456' }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'D123' },
      })
    ).toMatchObject({
      medium: 'slack',
      nonce: '123456',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
    })
  })

  it('normalizes Slack message envelopes by message timestamp instead of envelope id', () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'Ev-envelope-1',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UAPP> hello',
        ts: '1710000000.000001',
      },
    }

    expect(normalizeProviderMessage('slack', payload)).toMatchObject({
      medium: 'slack',
      providerEventId: 'slack:T123:C123:1710000000.000001',
      providerMessageTs: '1710000000.000001',
    })
  })

  it('normalizes Slack workflow result button clicks as download messages', () => {
    expect(
      normalizeProviderMessage('slack', {
        type: 'block_actions',
        trigger_id: 'trigger-1',
        actions: [{ value: 'workflow_result:due-diligence-package', action_ts: '171.0002' }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        container: { message_ts: '171.0001' },
        message: { ts: '171.0001', thread_ts: '170.9999' },
      })
    ).toMatchObject({
      medium: 'slack',
      content: 'download result due-diligence-package',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:trigger-1',
      providerMessageTs: '171.0001',
      threadTs: '170.9999',
    })
  })

  it('does not expose Discord as a Figure D provider decision path', () => {
    expect(
      normalizeProviderDecision('discord', {
        id: 'discord-event',
        data: { custom_id: `approve:${APPROVAL_ID}` },
        member: { user: { id: 'D123' } },
        guild_id: 'G123',
        channel_id: 'CH123',
      })
    ).toBeNull()
  })
})
