// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { NavItem } from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

/**
 * The team teardown only forgets requests for a concrete chat. A `latest` or
 * `none` request names no chat of the previous team, so the selection re-run
 * for the new team still has to honour it.
 */

async function seedNewTeamChat(clerum: MockClerum) {
  clerum.chat.getIndex.mockImplementation((agent: string) => clerum.readIndex(agent))
  clerum.chat.setLastActive.mockImplementation((agent: string, chat: string) =>
    clerum.persistLastActive(agent, chat)
  )
  await clerum.chat.create('agent-x', 'team-2-chat')
  await clerum.chat.upsertMessages('agent-x', 'team-2-chat', [
    { id: 'team-2-chat-message', role: 'user', content: 'team 2 history', timestamp: 1 },
  ])
}

async function switchTeam(controller: ReturnType<typeof renderController>, navItem: NavItem) {
  await act(async () => {
    await controller.result.current.teardownTeamActivity()
  })
  act(() =>
    controller.rerender({
      navItem,
      currentTeamId: 'team-2',
      chatAuthorityTeamId: 'team-2',
    })
  )
  await waitFor(() => {
    expect(controller.result.current.chatListLoading).toBe(false)
    expect(controller.result.current.chatMessagesLoading).toBe(false)
  })
}

it('opens the latest chat of the new team for a `latest` request made before the switch', async () => {
  const clerum = installMockClerum()
  await seedNewTeamChat(clerum)
  // Outside the chat route the selection never auto-opens a chat by itself,
  // so only the surviving request can open one here.
  const controller = renderController({ loadMenuData: false, navItem: DESKTOP_ROUTES.agents })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  expect(controller.result.current.activeChatId).toBeNull()

  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
  })
  await switchTeam(controller, DESKTOP_ROUTES.agents)

  expect(controller.result.current.activeChatId).toBe('team-2-chat')
  expect(controller.result.current.chatMessages).toEqual([
    expect.objectContaining({ id: 'team-2-chat-message' }),
  ])
})

it('keeps the conversation blank in chat for a `none` request made before the switch', async () => {
  const clerum = installMockClerum()
  await seedNewTeamChat(clerum)
  const controller = renderController({ loadMenuData: false, navItem: DESKTOP_ROUTES.chat })
  // On the chat route the selection auto-opens the latest chat on its own, so
  // a lost `none` request would show it after the switch.
  await waitFor(() => expect(controller.result.current.activeChatId).toBe('team-2-chat'))
  await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))

  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', null, { suppressAutoSelect: true })
    controller.result.current.clearActiveChat()
  })
  expect(controller.result.current.activeChatId).toBeNull()
  await switchTeam(controller, DESKTOP_ROUTES.chat)

  expect(controller.result.current.activeChatId).toBeNull()
  expect(controller.result.current.chatMessages).toEqual([])
})
