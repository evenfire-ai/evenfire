import { describe, expect, it } from 'vitest'
import { ConversationState, type PendingApproval } from '../../types'
import { ConversationManager } from '../conversation'

function approval(scope?: PendingApproval['authorization_scope']): PendingApproval {
  return {
    request_id: 'approval-scope-test',
    authorization_scope: scope,
    tool_name: 'shell_exec',
    parameters: { command: 'printf exact-call' },
    description: 'Unit approval scope',
    tool_call_id: 'tool-scope-test',
    context_snapshot: [],
  }
}

async function approvedScope(scope?: PendingApproval['authorization_scope'], always = false) {
  const manager = new ConversationManager()
  const conversation = await manager.getOrCreate('scope-user:rpc:scope-agent:chat')
  conversation.state = ConversationState.Processing
  await manager.suspendForApproval(conversation, approval(scope))
  await manager.approve(conversation, always)
  return conversation.auto_approved_tools
}

describe('approval authorization scope', () => {
  it('keeps an exact invocation from creating turn-wide or persistent grants', async () => {
    await expect(approvedScope('exact_invocation', true)).resolves.toEqual(new Set())
  })

  it('preserves explicitly consented turn-wide behavior for ordinary new approvals', async () => {
    await expect(approvedScope('turn_tools', true)).resolves.toEqual(new Set(['*', 'shell_exec']))
  })

  it('treats a legacy unknown scope as exact rather than granting a wildcard', async () => {
    await expect(approvedScope(undefined, true)).resolves.toEqual(new Set())
  })

  it.each(['exact_invocation', undefined] as const)(
    'removes an ambiguous wildcard for scope %s while preserving explicit grants',
    async scope => {
      const manager = new ConversationManager()
      const conversation = await manager.getOrCreate('scope-user:rpc:scope-agent:legacy')
      conversation.state = ConversationState.Processing
      conversation.auto_approved_tools = new Set(['*', 'http_request', 'trusted-server'])
      await manager.suspendForApproval(conversation, approval(scope))
      await manager.approve(conversation, true)

      expect(conversation.auto_approved_tools).toEqual(new Set(['http_request', 'trusted-server']))
    }
  )
})
