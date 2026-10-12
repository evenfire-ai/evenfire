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

it('starts new scoped history instead of joining the old-team pending switch', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-b')
  await clerum.chat.upsertMessages('agent-x', 'chat-b', [
    { id: 'real-history', role: 'user', content: 'real chat-b history', timestamp: 1 },
  ])
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const gate = deferred<void>()
  const entered = deferred<void>()
  const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
  })
  clerum.chat.setLastActive.mockImplementation(setLastActive)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-b', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'chat-b', {
      onCurrentError: () => undefined,
    })
  })
  const observed = request.catch(error => error)
  await entered.promise
  act(() =>
    controller.rerender({
      navItem: DESKTOP_ROUTES.chat,
      currentTeamId: 'team-2',
      chatAuthorityTeamId: 'team-2',
    })
  )
  const error = new Error('old-team switch failed')
  await act(async () => {
    gate.reject(error)
    expect(await observed).toBe(error)
  })
  await waitFor(() => {
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    expect(controller.result.current.activeChatId).toBe('chat-b')
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'real-history' }),
    ])
  })
})
