// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderController } from '../domain/__tests__/__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Round 9 selection error ownership', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('reports one failed launch-from-chat switch when the route effect coalesces it', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-1')
    await clerum.chat.create('agent-x', 'chat-2')
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

    clerum.chat.setLastActive.mockRejectedValue(new Error('chat store write failed'))
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.apps)
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        selectLatest: false,
        keepNavItem: true,
      })
    })

    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    await waitFor(() =>
      expect(
        app.result.current.toasts.filter(toast =>
          toast.text.includes('Could not open conversation')
        )
      ).toHaveLength(1)
    )
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(app.result.current.activeChatId).toBe('chat-2')
    expect(app.result.current.statusText).toContain('Could not open conversation')
  })

  it('keeps real history and rejects to its awaiter after an ownerless successor switch', async () => {
    const clerum = installMockClerum()
    for (const chat of ['chat-1', 'chat-2', 'chat-3']) {
      await clerum.chat.create('agent-x', chat)
      await clerum.chat.upsertMessages('agent-x', chat, [
        { id: `${chat}-history`, role: 'user', content: `${chat} real history`, timestamp: 1 },
      ])
    }
    const controller = renderController({ loadMenuData: false })
    unmount = controller.unmount
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await act(async () => controller.result.current.switchToChat('agent-x', 'chat-1'))
    const gate = deferred<void>()
    const entered = deferred<void>()
    const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
    clerum.chat.setLastActive.mockImplementation(async (agent, chat) => {
      if (chat === 'chat-2') {
        entered.resolve()
        await gate.promise
      }
      return setLastActive(agent, chat)
    })
    const error = new Error('stale chat store write failed')
    let switchPromise!: Promise<void>
    act(() => {
      switchPromise = controller.result.current.switchToChat('agent-x', 'chat-2', {
        onCurrentError: error => controller.spies.pushToast(String(error), 'error'),
      })
    })
    const observed = switchPromise.then(
      () => undefined,
      reason => reason
    )
    try {
      await entered.promise
      await act(async () => {
        // The successor intentionally has no error reporter (raw awaited API).
        await controller.result.current.switchToChat('agent-x', 'chat-3')
      })
      expect(controller.result.current.chatMessages).toEqual([
        expect.objectContaining({ id: 'chat-3-history' }),
      ])
      await act(async () => {
        gate.reject(error)
        expect(await observed).toBe(error)
      })
      expect(controller.result.current.activeChatId).toBe('chat-3')
      expect(controller.result.current.chatMessages).toEqual([
        expect.objectContaining({ id: 'chat-3-history' }),
      ])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(controller.spies.pushToast).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await observed
    }
  })

  it('settles and reports a failed pending selection from the selection effect', async () => {
    const clerum = installMockClerum()
    await clerum.chat.create('agent-x', 'requested-chat')
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    unmount = controller.unmount

    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    clerum.chat.setLastActive.mockRejectedValue(new Error('chat store write failed'))

    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', 'requested-chat')
      controller.rerender({ navItem: 'chat' })
    })

    await waitFor(() => {
      expect(controller.result.current.activeChatId).toBe('requested-chat')
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(controller.spies.pushToast).toHaveBeenCalledWith(
        'Could not open conversation: chat store write failed',
        'error'
      )
      expect(controller.spies.pushToast).toHaveBeenCalledTimes(1)
      expect(controller.result.current.chatMessages).toEqual([])
    })
  })
})
