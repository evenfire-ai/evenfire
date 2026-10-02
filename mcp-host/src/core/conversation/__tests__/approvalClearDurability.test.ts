import { describe, expect, it, vi } from 'vitest'
import { ConversationState, type PendingApproval } from '../../types'
import { ConversationManager } from '../conversation'
import { InMemoryConversationStore } from '../conversationStore'

async function setup() {
  const store = new InMemoryConversationStore()
  const manager = new ConversationManager(store)
  const conversation = await manager.getOrCreate('user:rpc:agent:chat')
  await manager.startTurn(conversation, 'pending turn', 'task')
  const approval: PendingApproval = {
    request_id: 'request',
    tool_name: 'shell_exec',
    tool_call_id: 'call',
    parameters: { command: 'pwd' },
    description: 'pending action',
    context_snapshot: [],
  }
  await manager.suspendForApproval(conversation, approval)
  return { store, manager, conversation, approval: conversation.pending_approval! }
}

describe('acknowledged approval cancellation', () => {
  it('keeps the exact RAM request until durability succeeds and preserves it for retry after failure', async () => {
    const f = await setup()
    const persist = vi
      .spyOn(f.store, 'persistApprovalResolved')
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined)
    await expect(f.manager.clearPendingApproval('user:rpc:agent:chat')).rejects.toThrow(
      'write failed'
    )
    expect(f.conversation.pending_approval).toBe(f.approval)
    expect(f.conversation.state).toBe(ConversationState.AwaitingApproval)
    await f.manager.clearPendingApproval('user:rpc:agent:chat')
    expect(persist.mock.calls.map(call => call[1])).toEqual(['request', 'request'])
    expect(f.conversation.pending_approval).toBeUndefined()
    expect(f.conversation.state).toBe(ConversationState.Idle)
  })
  it('does not overwrite newer RAM state while the captured durable clear is pending', async () => {
    const f = await setup()
    let finish!: () => void
    vi.spyOn(f.store, 'persistApprovalResolved').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const clear = f.manager.clearPendingApproval('user:rpc:agent:chat')
    expect(f.conversation.pending_approval).toBe(f.approval)
    f.conversation.state = ConversationState.Processing
    f.conversation.activeTaskId = 'new-task'
    f.conversation.pending_approval = undefined
    f.conversation.updated_at = new Date(f.conversation.updated_at.getTime() + 1)
    finish()
    await clear
    expect(f.conversation.state).toBe(ConversationState.Processing)
    expect(f.conversation.activeTaskId).toBe('new-task')
  })
})
