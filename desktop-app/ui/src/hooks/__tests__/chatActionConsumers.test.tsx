// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { ChatThread } from '@components/agents/ChatThread'
import { FleetBoard } from '@components/agents/FleetBoard'
import { renderController } from '../domain/__tests__/__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { useAgentChatActionsValue } from '../useAgentChatActionsValue'
import type { useAppController } from '../useAppController'

const live = vi.hoisted(() => ({ vm: null as any, actions: null as any }))
vi.mock('@contexts/NavigationContext', () => ({ useNavigationContext: () => live.vm }))
vi.mock('@contexts/NotificationsContext', () => ({ useNotificationsContext: () => live.vm }))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => live.actions,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => live.vm,
}))
vi.mock('@contexts/ChatThreadStateContext', () => ({ useChatThreadStateContext: () => live.vm }))
vi.mock('@contexts/ChatListContext', () => ({ useChatListContext: () => live.vm }))
vi.mock('@contexts/McpRuntimeContext', () => ({ useMcpRuntimeContext: () => live.vm }))
vi.mock('@contexts/AgentActivityContext', () => ({ useAgentActivityContext: () => live.vm }))
vi.mock('@hooks/domain/useAgentsDataController', () => ({ useAgentsDataController: () => live.vm }))
vi.mock('@hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: () => ({
    teams: [],
    currentTeamId: 'team-1',
    teamDirectory: {},
    ensureHydrated: async () => undefined,
  }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentMcpServerCountByAgent: {},
    agentMcpServersByAgent: {},
    mcpServerMappingUnavailableMessage: '',
  }),
}))
vi.mock('@components/agents/InFlightAssistantPlaceholder', () => ({
  InFlightAssistantPlaceholder: () => null,
}))
vi.mock('@components/agents/NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('@components/agents/ChatStateBadge', () => ({ ChatStateBadge: () => null }))

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

async function mountActions() {
  const clerum = installMockClerum()
  for (const chat of ['chat-1', 'chat-2']) {
    await clerum.chat.create('agent-x', chat)
    await clerum.chat.upsertMessages('agent-x', chat, [
      { id: `${chat}-history`, role: 'user', content: `${chat} real history`, timestamp: 1 },
    ])
  }
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  const app = renderController({ loadMenuData: false })
  await waitFor(() => expect(app.result.current.chatListLoading).toBe(false))
  const vm = { ...app.result.current, pushToast: app.spies.pushToast }
  const actions = renderHook(() =>
    useAgentChatActionsValue(vm as unknown as ReturnType<typeof useAppController>)
  )
  live.vm = {
    ...vm,
    activeMessages: vm.chatMessages,
    groupedMessages: [],
    semanticModelsByMessageId: new Map(),
    selectedAgent: 'agent-x',
    agentNames: ['agent-x'],
    agentDisplayByName: { 'agent-x': 'Agent X' },
    userAgentNames: ['agent-x'],
    teamAgentNames: [],
    agentLastActiveByAgent: {},
    handleSelectChatAgent: vi.fn(),
  }
  live.actions = actions.result.current
  return { app, clerum }
}

it('observes a ChatThread conversation click through the real stable action', async () => {
  const { app, clerum } = await mountActions()
  clerum.chat.setLastActive.mockRejectedValueOnce(new Error('sidebar switch failed'))
  render(<ChatThread />)
  const button = document.querySelector<HTMLButtonElement>('.agent-dedicated-session-title-btn')!
  expect(button).toBeTruthy()
  const target =
    live.vm.chatList.find((chat: any) => chat.title === button.textContent)?.id ??
    live.vm.chatList[0].id
  fireEvent.click(button)
  await waitFor(() =>
    expect(app.spies.pushToast).toHaveBeenCalledWith(
      'Could not open conversation: sidebar switch failed',
      'error'
    )
  )
  expect(app.spies.pushToast).toHaveBeenCalledTimes(1)
  expect(app.result.current.activeChatId).toBe(target)
  expect(app.result.current.chatMessages).toEqual([])
  expect(app.result.current.chatMessagesLoading).toBe(false)
})

it('observes a FleetBoard New chat click through the real stable create action', async () => {
  const { app, clerum } = await mountActions()
  clerum.chat.create.mockRejectedValueOnce(new Error('fleet create failed'))
  render(<FleetBoard />)
  fireEvent.click(screen.getByRole('button', { name: /More actions for/ }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
  await waitFor(() =>
    expect(app.spies.pushToast).toHaveBeenCalledWith(
      'Could not create conversation: fleet create failed',
      'error'
    )
  )
  expect(app.spies.pushToast).toHaveBeenCalledTimes(1)
  expect(app.result.current.activeChatId).toBeNull()
  expect(app.result.current.chatMessages).toEqual([])
  expect(app.result.current.chatMessagesLoading).toBe(false)
})
