import { describe, expect, it } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { buildConnectRequiredApproval } from '../../core/extensions/mcpApprovalGateController'
import { createSessionRouteHandlers } from '../sessionRouteHandlers'

function makeHandlersUnderTest() {
  const convManager = new ConversationManager()
  const { handleSessionsList, handleSessionMessages } = createSessionRouteHandlers({
    getConversationManager: () => convManager,
    redactToolError: (_toolName, rawError) => rawError,
  })
  return { convManager, handleSessionsList, handleSessionMessages }
}

async function seed(convManager: ConversationManager, key: string): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'q', 'task')
  await convManager.completeTurn(conv, 'a')
}

/**
 * Suspend a seeded conversation with a connect_required PendingApproval built by
 * the REAL producer (`buildConnectRequiredApproval`), driven through the REAL
 * `ConversationManager.suspendForApproval`. No hand-built wire shape (T1).
 */
async function suspendConnectRequired(
  convManager: ConversationManager,
  key: string
): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'list boards', 'task-connect')
  const approval = buildConnectRequiredApproval(
    { id: 'tc_1', name: 'monday__list_boards', arguments: { limit: 5 } },
    { mcpServerName: 'monday', provider: 'monday' }
  )
  await convManager.suspendForApproval(conv, approval)
}

async function suspendGenericApproval(
  convManager: ConversationManager,
  key: string
): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'run it', 'task-approve')
  await convManager.suspendForApproval(conv, {
    request_id: 'req-approve',
    tool_name: 'shell_exec',
    parameters: {},
    description: 'Shell command',
    tool_call_id: 'tc_1',
    context_snapshot: [],
  })
}

describe('createSessionRouteHandlers — U5 connect_required projection on the rejoin snapshot', () => {
  it('handleSessionMessages surfaces reason/mcpServerName/provider for a connect_required suspension', async () => {
    const { convManager, handleSessionMessages } = makeHandlersUnderTest()
    await suspendConnectRequired(convManager, 'user-A:rpc:agent-x:chat-1')

    const page = await handleSessionMessages('user-A', 'agent-x', 'chat-1', {})

    expect(page?.state).toBe('awaiting_approval')
    expect(page?.pendingApproval).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
      provider: 'monday',
    })
  })

  it('handleSessionsList surfaces the connect_required discriminator on the summary', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await suspendConnectRequired(convManager, 'user-A:rpc:agent-x:chat-1')

    const list = await handleSessionsList('user-A', {})
    const item = list.items.find(i => i.chatId === 'chat-1')
    expect(item?.pendingApproval).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
      provider: 'monday',
    })
  })

  it('a generic approval projects WITHOUT the connect fields (back-compat)', async () => {
    const { convManager, handleSessionMessages } = makeHandlersUnderTest()
    await suspendGenericApproval(convManager, 'user-A:rpc:agent-x:chat-2')

    const page = await handleSessionMessages('user-A', 'agent-x', 'chat-2', {})
    expect(page?.pendingApproval).toBeDefined()
    expect(page?.pendingApproval).not.toHaveProperty('reason')
    expect(page?.pendingApproval).not.toHaveProperty('mcpServerName')
    expect(page?.pendingApproval).not.toHaveProperty('provider')
  })
})

describe('createSessionRouteHandlers — handleSessionsList (R1-L2)', () => {
  it('treats an empty agent identically to an absent agent (unscoped catalog, not fail-closed)', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await seed(convManager, 'user-A:rpc:agent-x:chat-1')
    await seed(convManager, 'user-A:rpc:agent-y:chat-2')

    const absent = await handleSessionsList('user-A', {})
    const empty = await handleSessionsList('user-A', { agent: '' })

    // Absent agent → unscoped catalog spanning both agents.
    expect(absent.items.map(item => item.chatId).sort()).toEqual(['chat-1', 'chat-2'])
    // Empty agent must resolve to the SAME unscoped result. Before the fix the
    // prefix treated '' as falsy (unscoped) while the store query received ''
    // (agent scope), which fail-closed to an empty catalog — so the two diverged.
    expect(empty).toEqual(absent)
  })
})
