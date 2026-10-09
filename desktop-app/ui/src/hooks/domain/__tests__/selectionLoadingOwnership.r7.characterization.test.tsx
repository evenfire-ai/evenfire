// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

function holdLastActive(chatId: string) {
  const original = clerum.chat.setLastActive.getMockImplementation()
  if (!original) throw new Error('Expected the setLastActive test implementation')
  const entered = deferred<void>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let held = false
  clerum.chat.setLastActive.mockImplementation(async (agentRef, selectedChatId) => {
    if (agentRef === 'agent-x' && selectedChatId === chatId && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    await original(agentRef, selectedChatId)
    if (held && selectedChatId === chatId) returned.resolve()
  })
  return { entered, release, returned }
}

function holdLocalMessages(chatId: string) {
  const original = clerum.chat.loadMessages.getMockImplementation()
  if (!original) throw new Error('Expected the ChatStore-backed loadMessages test implementation')
  const entered = deferred<void>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let held = false
  clerum.chat.loadMessages.mockImplementation(async (agentRef, selectedChatId, ...args) => {
    if (agentRef === 'agent-x' && selectedChatId === chatId && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    const messages = await original(agentRef, selectedChatId, ...args)
    if (held && selectedChatId === chatId) returned.resolve()
    return messages
  })
  return { entered, release, returned }
}

describe('Round 7 selection loading ownership', () => {
  it('preserves visible chat history loading when a no-chat intent does not change the view', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.upsertMessages('agent-x', 'chat-a', [
      { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 1 },
    ])
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const heldSwitch = holdLastActive('chat-a')
    const controller = renderController({ navItem: 'chat', loadMenuData: false })

    try {
      await act(async () => {
        await heldSwitch.entered.promise
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      act(() => controller.result.current.setPendingChatSelection('agent-x', null))

      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      const loadingWhileHeld = controller.result.current.chatMessagesLoading

      await act(async () => {
        heldSwitch.release.resolve()
        await heldSwitch.returned.promise
      })
      await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
      expect({
        activeChatId: controller.result.current.activeChatId,
        loadingWhileHeld,
        messages: controller.result.current.chatMessages,
        loadingAfter: controller.result.current.chatMessagesLoading,
      }).toEqual({
        activeChatId: 'chat-a',
        loadingWhileHeld: true,
        messages: expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })]),
        loadingAfter: false,
      })
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await heldSwitch.returned.promise
      })
      controller.unmount()
    }
  })

  it('keeps the requested chat selected while its local history is slow', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.upsertMessages('agent-x', 'chat-a', [
      { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 1 },
    ])
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    const heldHistory = holdLocalMessages('chat-b')
    let historyEntered = false
    let switchPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      await act(async () => {
        await controller.result.current.switchToChat('agent-x', 'chat-a')
      })
      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-a')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })])
        )
      })

      act(() => {
        switchPromise = controller.result.current.handleSelectChat('chat-b')
      })
      await act(async () => {
        await heldHistory.entered.promise
        historyEntered = true
      })
      expect({
        activeChatId: controller.result.current.activeChatId,
        messages: controller.result.current.chatMessages,
        loading: controller.result.current.chatMessagesLoading,
      }).toEqual({ activeChatId: 'chat-b', messages: [], loading: true })

      await act(async () => {
        heldHistory.release.resolve()
        await heldHistory.returned.promise
        await switchPromise
      })
      expect({
        activeChatId: controller.result.current.activeChatId,
        messages: controller.result.current.chatMessages,
        loading: controller.result.current.chatMessagesLoading,
      }).toEqual({
        activeChatId: 'chat-b',
        messages: expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })]),
        loading: false,
      })
    } finally {
      heldHistory.release.resolve()
      await act(async () => {
        if (historyEntered) await heldHistory.returned.promise
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })
  it('loads a newer specific chat when it supersedes a held implicit switch', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    await clerum.chat.create('agent-x', 'chat-a')
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const heldSwitch = holdLastActive('chat-a')
    const heldHistory = holdLocalMessages('chat-b')
    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    let localHistoryEntered = false
    let requestedSwitch!: Promise<void>

    try {
      await act(async () => {
        await heldSwitch.entered.promise
      })
      act(() => {
        requestedSwitch = controller.result.current.handleSelectChat('chat-b')
      })
      await act(async () => {
        await heldHistory.entered.promise
        localHistoryEntered = true
      })

      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      await act(async () => {
        heldSwitch.release.resolve()
        await heldSwitch.returned.promise
      })
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      await act(async () => {
        heldHistory.release.resolve()
        await heldHistory.returned.promise
        await requestedSwitch
      })

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
      )
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      heldHistory.release.resolve()
      await act(async () => {
        await heldSwitch.returned.promise
        if (localHistoryEntered) await heldHistory.returned.promise
        await requestedSwitch?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('keeps a valid history load when a newer target is Host-blocked', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.upsertMessages('agent-x', 'chat-a', [
      { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 1 },
    ])
    await clerum.chat.create('agent-y', 'chat-b')
    const heldSwitch = holdLastActive('chat-a')
    let hostBlocked = false
    const controller = renderController(
      {
        isHostAccessBlocked: agentRef => agentRef === 'agent-y' && hostBlocked,
        loadMenuData: false,
      },
      {}
    )
    let switchPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        switchPromise = controller.result.current.switchToChat('agent-x', 'chat-a')
      })
      await act(async () => {
        await heldSwitch.entered.promise
      })
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      hostBlocked = true
      await act(async () => {
        await controller.result.current.switchToChat('agent-y', 'chat-b')
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      const loadingWhileHeld = controller.result.current.chatMessagesLoading

      await act(async () => {
        heldSwitch.release.resolve()
        await switchPromise
      })
      expect({
        activeChatId: controller.result.current.activeChatId,
        loadingWhileHeld,
        messages: controller.result.current.chatMessages,
        loadingAfter: controller.result.current.chatMessagesLoading,
      }).toEqual({
        activeChatId: 'chat-a',
        loadingWhileHeld: true,
        messages: expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })]),
        loadingAfter: false,
      })
      expect(
        clerum.chat.loadMessages.mock.calls.some(
          ([agentRef, chatId]) => agentRef === 'agent-y' && chatId === 'chat-b'
        )
      ).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('keeps a valid history load when a newer target has been deleted', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.upsertMessages('agent-x', 'chat-a', [
      { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 1 },
    ])
    await clerum.chat.create('agent-x', 'chat-b')
    const heldSwitch = holdLastActive('chat-a')
    const controller = renderController({ loadMenuData: false })
    let switchPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        switchPromise = controller.result.current.handleSelectChat('chat-a')
      })
      await act(async () => {
        await heldSwitch.entered.promise
      })
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      await act(async () => {
        const deletion = await controller.result.current.captureChatDeleteFence('agent-x')
        await controller.result.current.handleDeleteChat('chat-b', deletion)
        await controller.result.current.switchToChat('agent-x', 'chat-b')
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      const loadingWhileHeld = controller.result.current.chatMessagesLoading

      await act(async () => {
        heldSwitch.release.resolve()
        await switchPromise
      })
      expect({
        activeChatId: controller.result.current.activeChatId,
        loadingWhileHeld,
        messages: controller.result.current.chatMessages,
        loadingAfter: controller.result.current.chatMessagesLoading,
      }).toEqual({
        activeChatId: 'chat-a',
        loadingWhileHeld: true,
        messages: expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })]),
        loadingAfter: false,
      })
      expect(
        clerum.chat.loadMessages.mock.calls.some(
          ([agentRef, chatId]) => agentRef === 'agent-x' && chatId === 'chat-b'
        )
      ).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('restores a same-tick chat switch when New chat creation fails', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    const heldSwitch = holdLastActive('chat-b')
    const controller = renderController({ loadMenuData: false })
    const createError = new Error('local chat creation failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    let switchPromise!: Promise<void>
    let createPromise!: Promise<void>
    let observedError: unknown

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        switchPromise = controller.result.current.handleSelectChat('chat-b')
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })
      await act(async () => {
        await heldSwitch.entered.promise
      })
      await act(async () => {
        await createPromise
      })
      expect(observedError).toBe(createError)

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      await act(async () => {
        heldSwitch.release.resolve()
        await switchPromise
      })
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('does not restore a pending chat after the selected agent is cleared', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    const createError = new Error('local chat creation failed')
    const createGate = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    let observedError: unknown
    let createPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        controller.result.current.setPendingChatSelection('agent-x', 'chat-b')
        clerum.chat.create.mockReturnValueOnce(createGate.promise)
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })

      controller.rerender({ selectedAgent: null })
      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBeNull()
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      await act(async () => {
        createGate.reject(createError)
        await createPromise
      })
      expect(observedError).toBe(createError)
      expect(controller.result.current.activeChatId).toBeNull()
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      controller.unmount()
    }
  })

  it('does not restore a pending chat over a newer route list selection', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    await new Promise(resolve => setTimeout(resolve, 5))
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.upsertMessages('agent-x', 'chat-a', [
      { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 3 },
    ])
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    const createError = new Error('local chat creation failed')
    const createGate = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    let observedError: unknown
    let createPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        controller.result.current.setPendingChatSelection('agent-x', 'chat-b')
        clerum.chat.create.mockReturnValueOnce(createGate.promise)
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })
      await act(async () => {
        controller.rerender({ navItem: 'chat' })
      })
      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-a')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      await act(async () => {
        createGate.reject(createError)
        await createPromise
      })
      expect(observedError).toBe(createError)
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'chat-a-message' })])
      )
      expect(controller.result.current.chatMessages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
      )
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      createGate.reject(createError)
      controller.unmount()
    }
  })

  it('does not restore a team-scoped pending chat after a team change', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'team-one-message', role: 'user', content: 'team one history', timestamp: 2 },
    ])
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    const createError = new Error('local chat creation failed')
    const createGate = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    let observedError: unknown
    let createPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        controller.result.current.setPendingChatSelection('agent-x', 'chat-b')
        clerum.chat.create.mockReturnValueOnce(createGate.promise)
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })
      await act(async () => {
        controller.rerender({
          currentTeamId: 'team-2',
          chatAuthorityTeamId: 'team-2',
          currentTeamName: 'Team 2',
        })
      })
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

      await act(async () => {
        createGate.reject(createError)
        await createPromise
      })
      expect(observedError).toBe(createError)
      expect(controller.result.current.activeChatId).toBeNull()
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      createGate.reject(createError)
      controller.unmount()
    }
  })

  it.each(['latest', 'implicit'] as const)(
    'restores the newest existing chat after a failed create during an unconsumed %s load',
    async mode => {
      await clerum.chat.create('agent-x', 'chat-older')
      await new Promise(resolve => setTimeout(resolve, 5))
      await clerum.chat.create('agent-x', 'chat-newest')
      await clerum.chat.upsertMessages('agent-x', 'chat-newest', [
        { id: 'newest-message', role: 'user', content: 'newest history', timestamp: 3 },
      ])
      clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
      const controller = renderController({ navItem: 'agents', loadMenuData: false })
      const createError = new Error('local chat creation failed')
      let observedError: unknown
      let createPromise!: Promise<void>
      const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
      let routeIndexReads = 0

      try {
        await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
        clerum.chat.getIndex.mockImplementation(agentRef => {
          routeIndexReads += 1
          if (routeIndexReads === 1) return heldIndex.promise
          return clerum.readIndex(agentRef)
        })
        if (mode === 'latest') {
          act(() =>
            controller.result.current.setPendingChatSelection('agent-x', null, {
              selectLatest: true,
            })
          )
        }
        await act(async () => {
          controller.rerender({ navItem: 'chat' })
        })
        await waitFor(() => expect(routeIndexReads).toBe(1))

        clerum.chat.create.mockRejectedValueOnce(createError)
        act(() => {
          createPromise = controller.result.current.handleCreateChat().catch(error => {
            observedError = error
          })
        })
        await act(async () => {
          await createPromise
        })
        expect(observedError).toBe(createError)

        await waitFor(() => {
          expect(controller.result.current.activeChatId).toBe('chat-newest')
          expect(controller.result.current.chatMessages).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'newest-message' })])
          )
          expect(controller.result.current.chatMessagesLoading).toBe(false)
        })

        await act(async () => {
          heldIndex.resolve(await clerum.readIndex('agent-x'))
        })
        expect(controller.result.current.activeChatId).toBe('chat-newest')
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      } finally {
        heldIndex.resolve(await clerum.readIndex('agent-x'))
        controller.unmount()
      }
    }
  )

  it('keeps the chat blank after a failed create when no latest chat exists', async () => {
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    const createError = new Error('local chat creation failed')
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    let routeIndexReads = 0
    let observedError: unknown
    let createPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      clerum.chat.getIndex.mockImplementation(agentRef => {
        routeIndexReads += 1
        if (routeIndexReads === 1) return heldIndex.promise
        return clerum.readIndex(agentRef)
      })
      await act(async () => {
        controller.rerender({ navItem: 'chat' })
      })
      await waitFor(() => expect(routeIndexReads).toBe(1))

      clerum.chat.create.mockRejectedValueOnce(createError)
      act(() => {
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })
      await act(async () => {
        await createPromise
      })
      expect(observedError).toBe(createError)

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBeNull()
        expect(controller.result.current.chatMessages).toEqual([])
        expect(controller.result.current.chatMessagesLoading).toBe(false)
        expect(controller.result.current.chatListLoading).toBe(false)
      })

      await act(async () => {
        heldIndex.resolve(await clerum.readIndex('agent-x'))
      })
      expect(controller.result.current.activeChatId).toBeNull()
      expect(controller.result.current.chatMessages).toEqual([])
    } finally {
      heldIndex.resolve(await clerum.readIndex('agent-x'))
      controller.unmount()
    }
  })
})
