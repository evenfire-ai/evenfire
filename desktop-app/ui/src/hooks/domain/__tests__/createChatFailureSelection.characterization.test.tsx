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

describe('New chat creation failure during a specific selection', () => {
  it('restores the requested conversation and preserves the create error', async () => {
    const targetChatId = 'notification-target'
    await clerum.chat.create('agent-x', targetChatId)
    await clerum.chat.upsertMessages('agent-x', targetChatId, [
      {
        id: 'target-message',
        role: 'user',
        content: 'requested conversation history',
        timestamp: Date.now(),
      },
    ])
    const targetIndex = await clerum.readIndex('agent-x')

    const controller = renderController({ navItem: 'agents' })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const indexCallCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', targetChatId)
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )
    expect(controller.result.current.activeChatId).toBe(targetChatId)
    expect(controller.result.current.chatMessagesLoading).toBe(true)
    expect(controller.result.current.chatMessages).toEqual([])

    const createError = new Error('local chat creation failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    let observedError: unknown
    await act(async () => {
      await controller.result.current.handleCreateChat().catch(error => {
        observedError = error
      })
    })
    expect(observedError).toBe(createError)

    await act(async () => {
      heldIndex.resolve(targetIndex)
    })
    await waitFor(() => {
      expect(controller.result.current.activeChatId).toBe(targetChatId)
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'target-message',
            content: 'requested conversation history',
          }),
        ])
      )
    })
    controller.unmount()
  })

  it('restores a direct chat switch interrupted by a failed New chat', async () => {
    const targetChatId = 'chat-b'
    await clerum.chat.create('agent-x', targetChatId)
    await clerum.chat.upsertMessages('agent-x', targetChatId, [
      {
        id: 'chat-b-message',
        role: 'user',
        content: 'chat B history',
        timestamp: Date.now(),
      },
    ])
    const originalSetLastActive = clerum.chat.setLastActive.getMockImplementation()
    if (!originalSetLastActive) throw new Error('Expected the setLastActive test mock')
    const enteredSwitch = deferred<void>()
    const releaseSwitch = deferred<void>()
    let held = false
    clerum.chat.setLastActive.mockImplementation(async (agentRef, chatId) => {
      if (agentRef === 'agent-x' && chatId === targetChatId && !held) {
        held = true
        enteredSwitch.resolve()
        await releaseSwitch.promise
      }
      return originalSetLastActive(agentRef, chatId)
    })

    const controller = renderController()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    let switchPromise!: Promise<void>
    act(() => {
      switchPromise = controller.result.current.handleSelectChat(targetChatId)
    })
    await enteredSwitch.promise
    expect(controller.result.current.activeChatId).toBe(targetChatId)
    expect(controller.result.current.chatMessagesLoading).toBe(true)

    const createError = new Error('local chat creation failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    let observedError: unknown
    await act(async () => {
      await controller.result.current.handleCreateChat().catch(error => {
        observedError = error
      })
    })
    expect(observedError).toBe(createError)

    await waitFor(() => {
      expect(controller.result.current.activeChatId).toBe(targetChatId)
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'chat-b-message', content: 'chat B history' }),
        ])
      )
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    })

    await act(async () => {
      releaseSwitch.resolve()
      await switchPromise
    })
    expect(controller.result.current.activeChatId).toBe(targetChatId)
    expect(controller.result.current.chatMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
    )
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    controller.unmount()
  })

  it('restores a consumed specific selection interrupted by a failed New chat', async () => {
    const targetChatId = 'notification-target'
    await clerum.chat.create('agent-x', targetChatId)
    await clerum.chat.upsertMessages('agent-x', targetChatId, [
      {
        id: 'target-message',
        role: 'user',
        content: 'requested conversation history',
        timestamp: Date.now(),
      },
    ])
    const targetIndex = await clerum.readIndex('agent-x')
    const controller = renderController({ navItem: 'agents' })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const indexCallCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
    const originalSetLastActive = clerum.chat.setLastActive.getMockImplementation()
    if (!originalSetLastActive) throw new Error('Expected the setLastActive test mock')
    const enteredSwitch = deferred<void>()
    const releaseSwitch = deferred<void>()
    let held = false
    clerum.chat.setLastActive.mockImplementation(async (agentRef, chatId) => {
      if (agentRef === 'agent-x' && chatId === targetChatId && !held) {
        held = true
        enteredSwitch.resolve()
        await releaseSwitch.promise
      }
      return originalSetLastActive(agentRef, chatId)
    })

    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', targetChatId)
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )
    await act(async () => {
      heldIndex.resolve(targetIndex)
    })
    await enteredSwitch.promise
    expect(controller.result.current.activeChatId).toBe(targetChatId)
    expect(controller.result.current.chatMessagesLoading).toBe(true)

    const createError = new Error('local chat creation failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    let observedError: unknown
    await act(async () => {
      await controller.result.current.handleCreateChat().catch(error => {
        observedError = error
      })
    })
    expect(observedError).toBe(createError)

    await waitFor(() => {
      expect(controller.result.current.activeChatId).toBe(targetChatId)
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'target-message',
            content: 'requested conversation history',
          }),
        ])
      )
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    })

    await act(async () => {
      releaseSwitch.resolve()
    })
    expect(controller.result.current.activeChatId).toBe(targetChatId)
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    controller.unmount()
  })
})
