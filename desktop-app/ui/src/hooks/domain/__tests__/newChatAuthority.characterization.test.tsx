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
  vi.useRealTimers()
  uninstallMockClerum()
})

describe('New chat selection authority', () => {
  it('keeps the transcript blank after an older specific-selection index resolves', async () => {
    const priorChatId = 'prior-chat'
    await clerum.chat.create('agent-x', priorChatId)
    await clerum.chat.upsertMessages('agent-x', priorChatId, [
      {
        id: 'prior-message',
        role: 'user',
        content: 'previous conversation must stay hidden',
        timestamp: Date.now(),
      },
    ])
    const priorChatIndex = await clerum.readIndex('agent-x')
    const controller = renderController({ navItem: 'agents' })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const indexCallCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', priorChatId)
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )
    expect(controller.result.current.activeChatId).toBe(priorChatId)
    expect(controller.result.current.chatMessagesLoading).toBe(true)

    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', null, {
        suppressAutoSelect: true,
      })
      controller.result.current.clearActiveChat()
      heldIndex.resolve(priorChatIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    expect(controller.result.current.activeChatId).toBeNull()
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    expect(controller.result.current.agentError).toBeNull()
    controller.unmount()
  })
})
