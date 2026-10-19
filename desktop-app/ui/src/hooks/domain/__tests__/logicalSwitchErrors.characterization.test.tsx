// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('logical switch error ownership', () => {
  it.each([
    ['failure', 'failure', 2],
    ['success', 'failure', 1],
    ['failure', 'success', 1],
  ] as const)(
    'reports independent imperative %s followed by effect %s',
    async (first, second, reports) => {
      const clerum = installMockClerum()
      await clerum.chat.create('agent-x', 'chat-old')
      await clerum.chat.create('agent-x', 'chat-newest')
      await clerum.chat.upsertMessages('agent-x', 'chat-newest', [
        { id: 'newest-history', role: 'user', content: 'newest actual history', timestamp: 10 },
      ])
      clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
      const controller = renderController({ navItem: DESKTOP_ROUTES.chat, loadMenuData: false })
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
      const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
      clerum.chat.setLastActive.mockImplementation((agent, chat) =>
        (chat === 'chat-old' ? first : second) === 'failure'
          ? Promise.reject(new Error(`${chat} failed`))
          : setLastActive(agent, chat)
      )
      act(() => controller.result.current.setPendingChatSelection('agent-x', 'chat-old'))
      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-old')
        expect(controller.result.current.chatMessagesLoading).toBe(false)
        expect(controller.spies.pushToast).toHaveBeenCalledTimes(first === 'failure' ? 1 : 0)
      })
      act(() => controller.rerender({ navItem: DESKTOP_ROUTES.agents }))
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => controller.rerender({ navItem: DESKTOP_ROUTES.chat }))
      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-newest')
        expect(controller.result.current.chatMessagesLoading).toBe(false)
        expect(controller.spies.pushToast).toHaveBeenCalledTimes(reports)
        expect(controller.result.current.chatMessages).toEqual(
          second === 'success' ? [expect.objectContaining({ id: 'newest-history' })] : []
        )
      })
    }
  )
})
