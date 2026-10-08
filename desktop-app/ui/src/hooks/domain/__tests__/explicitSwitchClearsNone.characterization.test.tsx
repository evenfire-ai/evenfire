// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  clerum = installMockClerum()
  clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
})

afterEach(() => {
  uninstallMockClerum()
})

describe('explicit chat switch clears a stale blank selection', () => {
  it('keeps the chosen conversation selected when the chat route loads', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chosen conversation', timestamp: 1 },
    ])
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    act(() => {
      controller.result.current.setPendingChatSelection('agent-x', null, {
        suppressAutoSelect: true,
      })
    })
    await act(async () => {
      await controller.result.current.switchToChat('agent-x', 'chat-b')
    })
    expect(controller.result.current.activeChatId).toBe('chat-b')

    controller.rerender({ navItem: 'chat' })
    await waitFor(() => {
      expect(controller.result.current.chatListLoading).toBe(false)
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
      )
    })
    controller.unmount()
  })
})
