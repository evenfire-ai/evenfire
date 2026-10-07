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
})
