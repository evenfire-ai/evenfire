import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import {
  parseWorkflowApprovalDecisionCommand,
  providerIdentityFromMessage,
} from '../workflowApprovalDecision'

function message(overrides: Partial<Message>): Message {
  return {
    channelType: 'telegram',
    channelId: '424242',
    sender: '123456',
    content: '/approve risk-review',
    timestamp: new Date('2026-05-29T10:00:00.000Z'),
    messageId: '9001',
    ...overrides,
  }
}

describe('workflowApprovalDecision stable provider identity', () => {
  it('derives Telegram identity from stable from.id and chat.id', () => {
    const identity = providerIdentityFromMessage(message({}))

    expect(identity).toEqual({
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '424242',
      providerEventId: 'telegram:424242:9001',
    })
  })

  it('parses Telegram workflow decisions after a leading bot mention', () => {
    const command = parseWorkflowApprovalDecisionCommand(
      message({
        content: '@evenfire_test_bot /approve risk-review',
        providerIdentity: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: '424242',
          providerEventId: 'telegram:424242:9001',
          providerTarget: {
            hostRef: 'chatllm',
            communicationChannelNamespace: 'channels',
            communicationChannelName: 'telegram-only',
            providerBotUsername: 'evenfire_test_bot',
          },
        },
      })
    )

    expect(command?.recipeName).toBe('risk-review')
    expect(command?.decision).toBe('approve')
  })

  it('derives Slack identity from stable user_id, workspace/team id, and channel id', () => {
    const command = parseWorkflowApprovalDecisionCommand(
      message({
        channelType: 'slack',
        channelId: 'C123',
        sender: '@display-name',
        messageId: '1700000001.000001',
        rawData: {
          user: 'U123',
          team: 'T123',
        },
      })
    )

    expect(command).toEqual({
      recipeName: 'risk-review',
      decision: 'approve',
      providerIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
        providerEventId: 'slack:T123:C123:1700000001.000001',
      },
    })
  })

  it('fails closed for Slack workflow approval commands without workspace identity', () => {
    const command = parseWorkflowApprovalDecisionCommand(
      message({
        channelType: 'slack',
        channelId: 'C123',
        sender: 'U123',
        messageId: '1700000001.000001',
        rawData: { user: 'U123' },
      })
    )

    expect(command).toBeNull()
  })

  it('rejects UUID-looking workflow approval targets from chat', () => {
    const command = parseWorkflowApprovalDecisionCommand(
      message({
        content: '/approve 00000000-0000-4000-8000-000000000001',
      })
    )

    expect(command).toBeNull()
  })
})
