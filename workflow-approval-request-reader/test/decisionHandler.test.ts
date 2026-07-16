import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  normalizeGenericDecision,
  normalizeProviderDecision,
  normalizeProviderEnrollment,
  normalizeProviderMessage,
  normalizeSlackDecision,
  normalizeTeamsDecision,
  normalizeTeamsFileConsent,
  normalizeTelegramDecision,
} from '../src/decisionHandler.js'

const APPROVAL_ID = '99999999-8888-7777-6666-555555555555'
const WORKFLOW_RUN_ID = '11111111-2222-3333-4444-555555555555'
const COMPACT_APPROVAL_ID = Buffer.from(APPROVAL_ID.replace(/-/g, ''), 'hex').toString('base64url')
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
    expect(result).toMatchObject({
      decision: 'approve',
      mcpHostRef: 'sandbox-recipes/runtime-recipe',
    })
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

  it('normalizes Teams Adaptive Card approval decisions', () => {
    const channelAlias = 'abcdef0123456789'
    expect(
      normalizeTeamsDecision({
        type: 'invoke',
        id: 'activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: {
          id: '19:channel-1@thread.tacv2;messageid=root-post-1',
          conversationType: 'channel',
          tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        },
        channelData: {
          tenant: { id: '21e08d37-8d53-4144-87cb-557b8298aed3' },
          channel: { id: '19:channel-1@thread.tacv2' },
        },
        value: {
          action: `approve:${APPROVAL_ID}:sandbox-recipes/runtime-recipe:${channelAlias}`,
        },
      })
    ).toMatchObject({
      medium: 'teams',
      decision: 'approve',
      approvalRequestId: APPROVAL_ID,
      mcpHostRef: 'sandbox-recipes/runtime-recipe',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerChannelType: 'channel',
      providerEventId:
        'teams:21e08d37-8d53-4144-87cb-557b8298aed3:' + '19:channel-1@thread.tacv2:activity-1',
      channelAlias,
    })
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

  it('uses the stable Teams channel id for enrollment and keeps the thread id for replies', () => {
    const result = normalizeProviderEnrollment('teams', {
      type: 'message',
      id: 'activity-1',
      text: '<at>evenfire</at> verify 123456',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: '19:channel-1@thread.tacv2;messageid=post-1',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    expect(result).toMatchObject({
      medium: 'teams',
      nonce: '123456',
      providerUserId: 'teams-user-1',
      providerWorkspaceId: 'tenant-1',
      providerChannelId: '19:channel-1@thread.tacv2',
      providerConversationId: '19:channel-1@thread.tacv2;messageid=post-1',
      providerReplyToMessageId: 'post-1',
      providerChannelType: 'channel',
    })
  })

  it('captures Teams conversation metadata during enrollment', () => {
    expect(
      normalizeProviderEnrollment('teams', {
        type: 'message',
        id: 'activity-1',
        text: '<at>evenfire</at> verify 123456',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1', name: 'Josue Sosa' },
        conversation: {
          id: '19:channel-1@thread.tacv2;messageid=post-1',
          conversationType: 'channel',
          tenantId: 'tenant-1',
        },
        channelData: {
          tenant: { id: 'tenant-1' },
          team: { id: 'team-1', name: 'Engineering' },
          channel: { id: '19:channel-1@thread.tacv2', name: 'General' },
        },
      })
    ).toMatchObject({
      providerChannelTitle: 'General',
      providerTeamId: 'team-1',
      providerTeamsChannelId: '19:channel-1@thread.tacv2',
    })
  })

  it('maps different Teams posts to one verified channel identity', () => {
    const teamsMessage = (postId: string, activityId: string) => ({
      type: 'message',
      id: activityId,
      text: '<at>evenfire</at> hello',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: `19:channel-1@thread.tacv2;messageid=${postId}`,
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    const first = normalizeProviderMessage('teams', teamsMessage('post-1', 'activity-1'))
    const second = normalizeProviderMessage('teams', teamsMessage('post-2', 'activity-2'))

    expect(first?.providerChannelId).toBe('19:channel-1@thread.tacv2')
    expect(second?.providerChannelId).toBe('19:channel-1@thread.tacv2')
    expect(first?.providerConversationId).toBe('19:channel-1@thread.tacv2;messageid=post-1')
    expect(second?.providerConversationId).toBe('19:channel-1@thread.tacv2;messageid=post-2')
    expect(first?.providerReplyToMessageId).toBe('post-1')
    expect(second?.providerReplyToMessageId).toBe('post-2')
  })

  it('uses the Teams reply root when a message is sent inside an existing post thread', () => {
    const result = normalizeProviderMessage('teams', {
      type: 'message',
      id: 'reply-activity-1',
      replyToId: 'root-post-1',
      text: '<at>evenfire</at> hello',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: '19:channel-1@thread.tacv2',
        conversationType: 'channel',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
        channel: { id: '19:channel-1@thread.tacv2' },
      },
    })

    expect(result?.providerConversationId).toBe('19:channel-1@thread.tacv2')
    expect(result?.providerReplyToMessageId).toBe('root-post-1')
    expect(result?.providerMessageTs).toBe('reply-activity-1')
  })

  it('keeps a personal Teams chat scoped to its conversation', () => {
    const result = normalizeProviderMessage('teams', {
      type: 'message',
      id: 'activity-1',
      text: 'hello',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      from: { id: 'teams-user-1' },
      conversation: {
        id: 'personal-conversation-1',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      channelData: {
        tenant: { id: 'tenant-1' },
      },
    })

    expect(result?.providerChannelId).toBe('personal-conversation-1')
    expect(result?.providerConversationId).toBe('personal-conversation-1')
    expect(result?.providerReplyToMessageId).toBe('activity-1')
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
        actions: [{ value: `workflow_result_run:${WORKFLOW_RUN_ID}`, action_ts: '171.0002' }],
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        container: { message_ts: '171.0001' },
        message: { ts: '171.0001', thread_ts: '170.9999' },
      })
    ).toMatchObject({
      medium: 'slack',
      content: 'Download the completed workflow result',
      workflowRunId: WORKFLOW_RUN_ID,
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerEventId: 'slack:T123:C123:trigger-1',
      providerMessageTs: '171.0001',
      threadTs: '170.9999',
    })
  })

  it('normalizes accepted Teams file consent invokes', () => {
    expect(
      normalizeTeamsFileConsent({
        type: 'invoke',
        name: 'fileConsent/invoke',
        id: 'consent-activity-1',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        from: { id: 'teams-user-1' },
        conversation: {
          id: 'personal-conversation-1',
          conversationType: 'personal',
          tenantId: 'tenant-1',
        },
        channelData: { tenant: { id: 'tenant-1' } },
        value: {
          action: 'accept',
          context: { workflowRunId: WORKFLOW_RUN_ID, artifactName: 'result.pdf' },
          uploadInfo: {
            contentUrl: 'https://tenant.sharepoint.com/result.pdf',
            uploadUrl: 'https://tenant.sharepoint.com/upload-session',
            uniqueId: 'file-1',
            name: 'result.pdf',
            fileType: 'pdf',
          },
        },
      })
    ).toMatchObject({
      action: 'accept',
      workflowRunId: WORKFLOW_RUN_ID,
      artifactName: 'result.pdf',
      providerConversationId: 'personal-conversation-1',
      uploadInfo: {
        uploadUrl: 'https://tenant.sharepoint.com/upload-session',
        uniqueId: 'file-1',
      },
    })
  })

  it('normalizes Slack tool approval buttons as threaded channel messages', () => {
    expect(
      normalizeProviderMessage('slack', {
        type: 'block_actions',
        trigger_id: 'trigger-tool-1',
        user: { id: 'U123' },
        team: { id: 'T123' },
        channel: { id: 'C123' },
        message: { ts: '1710000000.000002', thread_ts: '1710000000.000001' },
        actions: [{ value: 'tool:l:abcdefghijklmnop' }],
      })
    ).toMatchObject({
      medium: 'slack',
      content: 'tool:l:abcdefghijklmnop',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
      providerMessageTs: '1710000000.000002',
      threadTs: '1710000000.000001',
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
