// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

it.each(['notification', 'explicit clear', 'latest', 'suppressed target'] as const)(
  '%s owns its declared selection mode without conflating no-chat intent',
  async producer => {
    const clerum = installMockClerum()
    await clerum.chat.create('agent-x', 'visible')
    await clerum.chat.upsertMessages('agent-x', 'visible', [
      { id: 'actual-history', role: 'user', content: 'visible real history', timestamp: 1 },
    ])
    const controller = renderController({ navItem: DESKTOP_ROUTES.chat, loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    const gate = deferred<void>()
    clerum.chat.setLastActive.mockImplementationOnce(() => gate.promise)
    let request!: Promise<void>
    act(() => {
      request = controller.result.current.switchToChat('agent-x', 'visible')
    })
    expect(controller.result.current.chatMessagesLoading).toBe(true)
    act(() => {
      if (producer === 'latest') {
        controller.result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
      } else if (producer === 'suppressed target') {
        // Supported public API combination: suppressing a named target records
        // none but is not the no-chat notification's view-preserving intent.
        controller.result.current.setPendingChatSelection('agent-x', 'other', {
          suppressAutoSelect: true,
        })
      } else {
        controller.result.current.setPendingChatSelection('agent-x', null)
        if (producer === 'explicit clear') controller.result.current.clearActiveChat()
      }
    })
    expect(controller.result.current.chatMessagesLoading).toBe(producer === 'notification')
    await act(async () => {
      gate.resolve()
      await request
    })
    expect(controller.result.current.activeChatId).toBe(
      producer === 'explicit clear' ? null : 'visible'
    )
    expect(controller.result.current.chatMessages).toEqual(
      producer === 'notification' ? [expect.objectContaining({ id: 'actual-history' })] : []
    )
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    expect(controller.spies.pushToast).not.toHaveBeenCalled()
  }
)
