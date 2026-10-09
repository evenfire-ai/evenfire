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

  it('does not report a rejected switch after a newer conversation owns the view', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-1')
    await clerum.chat.create('agent-x', 'chat-2')
    await clerum.chat.create('agent-x', 'chat-3')
    const originalSetLastActive = clerum.chat.setLastActive.getMockImplementation()
    if (!originalSetLastActive) throw new Error('Expected the setLastActive test mock')
    const entered = deferred<void>()
    const release = deferred<void>()
    let held = false
    clerum.chat.setLastActive.mockImplementation(async (agentRef, chatId) => {
      if (agentRef === 'agent-x' && chatId === 'chat-2' && !held) {
        held = true
        entered.resolve()
        await release.promise
        throw new Error('stale chat store write failed')
      }
      return originalSetLastActive(agentRef, chatId)
    })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false })
    })
    await entered.promise
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-3'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

    await act(async () => {
      release.resolve()
    })
    await waitFor(() =>
      expect(
        app.result.current.toasts.filter(toast =>
          toast.text.includes('stale chat store write failed')
        )
      ).toHaveLength(0)
    )
    expect(app.result.current.activeChatId).toBe('chat-3')
    expect(app.result.current.statusText).not.toContain('stale chat store write failed')
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
    })
  })
})
