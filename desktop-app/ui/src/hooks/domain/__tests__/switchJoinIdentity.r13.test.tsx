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

it.each(['chat-1', 'chat-2'])(
  'does not reuse a fulfilled execution for a new specific intent to %s',
  async destination => {
    const clerum = installMockClerum()
    clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
    clerum.chat.setLastActive.mockImplementation((agent, chat) =>
      clerum.persistLastActive(agent, chat)
    )
    for (const id of ['chat-1', 'chat-2']) {
      await clerum.chat.create('agent-x', id)
      await clerum.chat.upsertMessages('agent-x', id, [
        { id: `${id}-history`, role: 'user', content: `${id} actual history`, timestamp: 1 },
      ])
    }
    const controller = renderController({ loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await act(async () => controller.result.current.switchToChat('agent-x', 'chat-1'))
    act(() => {
      controller.result.current.setPendingChatSelection('agent-x', destination, {
        deferSwitch: true,
      })
      controller.rerender({ navItem: DESKTOP_ROUTES.apps })
    })
    await waitFor(() => {
      expect(controller.result.current.chatMessages).toEqual([
        expect.objectContaining({ id: `${destination}-history` }),
      ])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    })
    expect(controller.result.current.activeChatId).toBe(destination)
    expect(clerum.chat.setLastActive.mock.calls.map(([, id]) => id)).toEqual([
      'chat-1',
      destination,
    ])
    expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe(destination)
    expect(controller.spies.pushToast).not.toHaveBeenCalled()
  }
)

it('does not join another agent execution even when real pending producers reuse its chat id', async () => {
  const clerum = installMockClerum()
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  for (const agent of ['agent-x', 'agent-y']) {
    await clerum.chat.create(agent, 'shared-chat')
    await clerum.chat.upsertMessages(agent, 'shared-chat', [
      { id: `${agent}-history`, role: 'user', content: `${agent} history`, timestamp: 1 },
    ])
  }
  const controller = renderController({ loadMenuData: false, agentNames: ['agent-x', 'agent-y'] })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const opening = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(() => opening.promise)
  let request!: Promise<void>
  act(() => {
    // The pending-selection producer records the destination before React
    // commits selectedAgent; a public imperative action may still use agent-x.
    controller.result.current.setPendingChatSelection('agent-y', 'shared-chat', {
      deferSwitch: true,
    })
    request = controller.result.current.switchToChat('agent-x', 'shared-chat', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
    controller.rerender({ selectedAgent: 'agent-y', navItem: DESKTOP_ROUTES.apps })
  })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  await waitFor(() =>
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'agent-y-history', content: 'agent-y history' }),
    ])
  )
  await act(async () => {
    opening.resolve()
    expect(await request).toBeUndefined()
  })
  expect(controller.result.current.activeChatId).toBe('shared-chat')
  expect(controller.result.current.chatMessages).toEqual([
    expect.objectContaining({ id: 'agent-y-history', content: 'agent-y history' }),
  ])
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  expect(clerum.chat.setLastActive.mock.calls.map(([agent]) => agent)).toEqual([
    'agent-x',
    'agent-y',
  ])
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
})
