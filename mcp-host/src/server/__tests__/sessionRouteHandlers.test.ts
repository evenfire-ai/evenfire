import { describe, expect, it } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
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
