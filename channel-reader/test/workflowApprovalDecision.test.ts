import { describe, expect, it } from 'vitest'
import type { Message } from '../src/types.js'
import {
  parseWorkflowApprovalDecisionCallback,
  parseWorkflowApprovalDecisionCommand,
} from '../src/workflowApprovalDecision.js'

const APPROVAL_ID = '00000000-0000-0000-0000-000000000111'

function message(overrides: Partial<Message>): Message {
  return {
    channelType: 'telegram',
    channelId: 'tg-chat-1',
    sender: '123456',
    content: `/approve ${APPROVAL_ID}`,
    timestamp: new Date('2026-05-27T00:00:00.000Z'),
    messageId: '42',
    ...overrides,
  }
}

describe('parseWorkflowApprovalDecisionCommand', () => {
  it('does not parse UUID-looking targets as user-facing workflow approval commands', () => {
    expect(parseWorkflowApprovalDecisionCommand(message({}))).toBeNull()
  })

  it('parses Telegram workflow approval button callbacks by request id', () => {
    const parsed = parseWorkflowApprovalDecisionCallback(
      message({
        content: '/approve ' + APPROVAL_ID,
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:callback:callback-1',
        },
        rawData: {
          telegramCallbackApprovalRequestId: APPROVAL_ID,
          telegramCallbackDecision: 'approve',
        },
      })
    )

    expect(parsed).toEqual({
      approvalRequestId: APPROVAL_ID,
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'tg-chat-1',
        providerEventId: 'telegram:tg-chat-1:callback:callback-1',
      },
    })
  })

  it('parses Telegram workflow approval decisions by workflow recipe name', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({ content: '/approve team.daily-report' })
    )

    expect(parsed).toEqual({
      recipeName: 'team.daily-report',
      decision: 'approve',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'tg-chat-1',
        providerEventId: 'telegram:tg-chat-1:42',
      },
    })
  })

  it('parses Telegram workflow approval decisions after a leading bot mention', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({
        content: '@evenfire_test_bot  /approve research-summary-workflow',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:42',
          providerTarget: {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'telegram-only',
            providerBotUsername: 'evenfire_test_bot',
          },
        },
      })
    )

    expect(parsed?.recipeName).toBe('research-summary-workflow')
    expect(parsed?.decision).toBe('approve')
  })

  it('rejects Telegram workflow approval decisions addressed to another bot', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({
        content: '@other_bot /approve research-summary-workflow',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'tg-chat-1',
          providerEventId: 'telegram:tg-chat-1:42',
          providerTarget: {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'telegram-only',
            providerBotUsername: 'evenfire_test_bot',
          },
        },
      })
    )

    expect(parsed).toBeNull()
  })

  it('parses deny decisions by workflow recipe name', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({ content: '/deny due-diligence-review' })
    )

    expect(parsed).toEqual({
      recipeName: 'due-diligence-review',
      decision: 'deny',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'tg-chat-1',
        providerEventId: 'telegram:tg-chat-1:42',
      },
    })
  })

  it('parses Slack workflow approval decisions from provider identity envelope', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        content: '/deny due-diligence-review',
        messageId: '1700000001.000001',
        providerIdentity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerEventId: 'slack:T123:C123:1700000001.000001',
        },
      })
    )

    expect(parsed).toEqual({
      recipeName: 'due-diligence-review',
      decision: 'deny',
      providerIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:1700000001.000001',
      },
    })
  })

  it('does not synthesize Slack workflow approval identity without workspace identity', () => {
    const parsed = parseWorkflowApprovalDecisionCommand(
      message({
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        content: '/approve due-diligence-review',
        messageId: '1700000001.000001',
        rawData: { user: 'U123' },
      })
    )

    expect(parsed).toBeNull()
  })

  it('does not treat local tool approval commands as workflow approvals', () => {
    expect(parseWorkflowApprovalDecisionCommand(message({ content: '/approve' }))).toBeNull()
    expect(parseWorkflowApprovalDecisionCommand(message({ content: '/deny' }))).toBeNull()
    expect(parseWorkflowApprovalDecisionCommand(message({ content: '/approve always' }))).toBeNull()
  })
})
