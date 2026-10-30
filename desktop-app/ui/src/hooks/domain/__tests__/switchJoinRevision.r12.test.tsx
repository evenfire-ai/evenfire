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

it('does not join an old revision still in flight when a newer same-chat intent owns loading', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-2')
  await clerum.chat.upsertMessages('agent-x', 'chat-2', [
    { id: 'actual-chat-2', role: 'user', content: 'current intent history', timestamp: 1 },
  ])
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const old = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(() => old.promise)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'chat-2', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
  })
  const observed = request.catch(cause => cause)
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    controller.rerender({ navItem: DESKTOP_ROUTES.chat })
  })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const error = new Error('old revision failed')
  await act(async () => {
    old.reject(error)
    expect(await observed).toBe(error)
  })
  await waitFor(() => {
    expect(controller.result.current.activeChatId).toBe('chat-2')
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'actual-chat-2', content: 'current intent history' }),
    ])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
  })
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(2)
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
})
