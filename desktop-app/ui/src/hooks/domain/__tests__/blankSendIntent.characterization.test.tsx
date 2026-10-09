// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred, serverSessionMessages, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

describe('blank-send selection intent', () => {
  it('keeps the send-created conversation selected over a future-dated catalog entry', async () => {
    const releaseIndexFailure = deferred<void>()
    clerum.chat.getIndex
      .mockImplementationOnce(async () => {
        await releaseIndexFailure.promise
        throw new Error('Not authenticated during store rebind')
      })
      .mockImplementation(agentRef => clerum.readIndex(agentRef))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([
        {
          agent: 'agent-x',
          chatId: 'prior-server',
          turnCount: 1,
          messageCount: 2,
          lastActivityAt: '2099-05-03T00:00:00Z',
        },
      ])
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-x', 'prior-server')
    )
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'accepted reply' })

    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const created = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    const releaseCreate = deferred<void>()
    let holdCreate = true
    clerum.chat.create.mockImplementation(async (agentRef, chatId) => {
      const meta = await createChat(agentRef, chatId)
      if (holdCreate) {
        holdCreate = false
        created.resolve(meta)
        await releaseCreate.promise
      }
      return meta
    })

    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    let sendPromise: Promise<void> | undefined
    let createdChat: Awaited<ReturnType<typeof clerum.chat.create>> | undefined
    try {
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(1))
      await act(async () => {
        sendPromise = controller.result.current.handleSendAgentMessage('newer blank send')
        createdChat = await created.promise
      })
      if (!createdChat) throw new Error('Expected the real ChatStore create producer to resolve')

      await act(async () => {
        releaseIndexFailure.resolve()
      })
      await waitFor(() =>
        expect(controller.result.current.chatList.map(chat => chat.id)).toContain('prior-server')
      )
      expect(controller.result.current.activeChatId).toBeNull()

      await act(async () => {
        releaseCreate.resolve()
        await sendPromise
      })

      const request = clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1] as
        | { threadId?: string }
        | undefined
      expect(request?.threadId).toBe(createdChat.id)
      expect(await clerum.persistedMessages('agent-x', createdChat.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'newer blank send' }),
          expect.objectContaining({ role: 'assistant', content: 'accepted reply' }),
        ])
      )
      expect(controller.result.current.activeChatId).toBe(createdChat.id)
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'newer blank send' }),
          expect.objectContaining({ content: 'accepted reply' }),
        ])
      )
    } finally {
      releaseIndexFailure.resolve()
      releaseCreate.resolve()
      await act(async () => {
        await sendPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })
})
