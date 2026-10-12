// @vitest-environment jsdom
/**
 * R1-M11: the `window.clerum.chat` fixture must persist exactly like the real
 * `ChatStore` behind the IPC bridge. A hand-rolled merge that drifts from it
 * certifies suites against a store production never runs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatAuthorityScope } from '../../../../../src/types'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

const AGENT = 'agent-x'
const CHAT = 'chat-1'
const SCOPE: ChatAuthorityScope = { environmentKey: 'env-test', userId: 'user-1', teamId: null }

async function persistedIds(clerum: MockClerum): Promise<unknown[]> {
  return (await clerum.persistedMessages(AGENT, CHAT)).map(message => message.id)
}

describe('mockClerum chat persistence', () => {
  afterEach(() => {
    uninstallMockClerum()
  })

  it('reconciles a turnless local message with its server turn like ChatStore', async () => {
    const clerum = installMockClerum()
    await clerum.chat.create(AGENT, CHAT)
    await clerum.chat.appendMessages(AGENT, CHAT, [
      { id: 'local-1', role: 'user', content: 'hello', timestamp: 1 },
    ])
    await clerum.chat.upsertMessages(AGENT, CHAT, [
      { id: 'srv-1', role: 'user', content: 'hello', timestamp: 2, serverTurnNumber: 1 },
    ])

    expect(await persistedIds(clerum)).toEqual(['srv-1'])
    // Witness: the bridge's own read returns the real store's result.
    const loaded = (await clerum.chat.loadMessages(AGENT, CHAT)) as Array<{ id: string }>
    expect(loaded.map(message => message.id)).toEqual(['srv-1'])
  })

  it('drops a late upsert into a chat deleted in the current scope like ChatStore', async () => {
    const clerum = installMockClerum()
    await clerum.chat.create(AGENT, CHAT)
    await clerum.chat.appendMessages(AGENT, CHAT, [
      { id: 'before', role: 'user', content: 'kept until delete', timestamp: 1 },
    ])
    // Witness: the chat held a message before the delete.
    expect(await persistedIds(clerum)).toEqual(['before'])

    const fence = await clerum.chat.captureDeleteFence(SCOPE)
    await clerum.chat.delete(AGENT, CHAT, fence)
    await clerum.chat.upsertMessages(AGENT, CHAT, [
      { id: 'late', role: 'assistant', content: 'late reply', timestamp: 3 },
    ])

    expect(await persistedIds(clerum)).toEqual([])
  })
})
