import { describe, expect, it } from 'vitest'
import type { WorkflowCallerContext } from '../workflowShared'
import { workflowTriggerApprovalExecutionId } from '../workflowTriggerApprovalIdentity'

const baseContext: WorkflowCallerContext = {
  targetUserId: '00000000-0000-4000-8000-000000000001',
  conversationId: 'telegram:tg-chat-1:123456',
  originChannelType: 'telegram',
  providerUserId: '123456',
  providerWorkspaceId: null,
  providerChannelId: 'tg-chat-1',
  providerEventId: 'telegram:tg-chat-1:42',
  sourceMessageId: 'telegram:tg-chat-1:42',
  sourceMessageContent: 'Run due diligence with depth full',
}

function executionId(overrides: Partial<Parameters<typeof workflowTriggerApprovalExecutionId>[0]>) {
  return workflowTriggerApprovalExecutionId({
    caller: 'sandbox-recipes/source-recipe',
    namespace: 'sandbox-recipes',
    name: 'due-diligence',
    targetUserId: '00000000-0000-4000-8000-000000000001',
    inputs: { depth: 'full', scope: ['team', 'market'] },
    workflowCallerContext: baseContext,
    ...overrides,
  })
}

describe('workflowTriggerApprovalExecutionId', () => {
  it('keeps retry identity stable for the same provider event and canonical inputs', () => {
    expect(
      executionId({
        inputs: { scope: ['team', 'market'], depth: 'full' },
      })
    ).toBe(
      executionId({
        inputs: { depth: 'full', scope: ['team', 'market'] },
      })
    )
  })

  it('distinguishes provider events, inputs, and targets', () => {
    const original = executionId({})
    expect(
      executionId({
        workflowCallerContext: {
          ...baseContext,
          providerEventId: 'telegram:tg-chat-1:43',
          sourceMessageId: 'telegram:tg-chat-1:43',
        },
      })
    ).not.toBe(original)
    expect(executionId({ inputs: { depth: 'light', scope: ['team', 'market'] } })).not.toBe(
      original
    )
  })

  it('uses team target identity when targetTeamId is provided', () => {
    const teamRun = executionId({
      targetUserId: undefined,
      targetTeamId: '00000000-0000-4000-8000-0000000000aa',
    })

    expect(teamRun).toBe(
      executionId({
        targetUserId: undefined,
        targetTeamId: '00000000-0000-4000-8000-0000000000aa',
      })
    )
    expect(
      executionId({
        targetUserId: undefined,
        targetTeamId: '00000000-0000-4000-8000-0000000000bb',
      })
    ).not.toBe(teamRun)
    expect(teamRun).not.toBe(executionId({}))
  })

  it('distinguishes the requester user for provider-chat team triggers', () => {
    const teamTarget = {
      targetUserId: undefined,
      targetTeamId: '00000000-0000-4000-8000-0000000000aa',
    }
    const requesterOne = executionId(teamTarget)
    const requesterTwo = executionId({
      ...teamTarget,
      workflowCallerContext: {
        ...baseContext,
        targetUserId: '00000000-0000-4000-8000-000000000002',
      },
    })

    expect(requesterTwo).not.toBe(requesterOne)
  })

  it('falls back to source message identity without using wall clock time', () => {
    const context = {
      ...baseContext,
      providerEventId: undefined,
      sourceMessageId: 'provider-message-99',
    }
    expect(executionId({ workflowCallerContext: context })).toBe(
      executionId({ workflowCallerContext: context })
    )
  })

  it('keeps all-null source signal identity stable from authenticated context and inputs', () => {
    const context = {
      ...baseContext,
      providerEventId: undefined,
      sourceMessageId: undefined,
      sourceMessageContent: undefined,
    }
    const original = executionId({ workflowCallerContext: context })

    expect(original).toBe(executionId({ workflowCallerContext: context }))
    expect(executionId({ workflowCallerContext: context, inputs: { depth: 'light' } })).not.toBe(
      original
    )
    expect(
      executionId({
        workflowCallerContext: {
          ...context,
          conversationId: 'telegram:tg-chat-1:654321',
        },
      })
    ).not.toBe(original)
  })
})
