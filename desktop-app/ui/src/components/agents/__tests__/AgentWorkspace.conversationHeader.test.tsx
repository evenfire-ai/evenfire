// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedChatDelete } from '@contexts/AgentChatActionsContext'
import type { ChatListContextValue } from '@contexts/ChatListContext'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { AgentWorkspace } from '../AgentWorkspace'

// The chat header inside an open conversation: the agent is what the user goes
// back to, the current crumb names the conversation, and its menu acts on that
// conversation (rename, delete) or opens the Agents section.

const mcpMock = vi.hoisted(() => ({
  agentDisplayByName: {} as Record<string, string>,
}))

const navMock = vi.hoisted(() => ({
  selectedAgent: 'alpha' as string | null,
  handleOpenAgentWorkspace: vi.fn(),
  handleNavSelect: vi.fn(),
  handleSelectChatAgent: vi.fn(),
}))

// Typed off the chat-list contract: an entry the lists cannot hold does not
// compile.
const chatMock = vi.hoisted(() => ({
  activeChatId: 'chat-1' as string | null,
  chatList: [] as ChatListContextValue['chatList'],
  latestChatSessions: [] as ChatListContextValue['latestChatSessions'],
}))

const actionsMock = vi.hoisted(() => ({
  scrollChatToBottom: vi.fn(),
  captureChatDeleteFence: vi.fn(),
  handleRenameChatForAgent: vi.fn(async () => undefined),
  handleDeleteChatForAgent: vi.fn(async () => undefined),
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['alpha'] }),
}))

vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ accessCatalog: null }),
}))

vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: {},
    agentDisplayByName: mcpMock.agentDisplayByName,
    selectedAgentMcpServers: [],
  }),
}))

vi.mock('@hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: () => ({
    teams: [],
    currentTeamId: '',
    teamMembers: [],
    teamDirectory: {},
    ensureHydrated: vi.fn(async () => undefined),
  }),
}))

vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({ me: null }),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    navItem: 'chat',
    selectedAgent: navMock.selectedAgent,
    selectedAgentRoute: 'members',
    handleBackToAgents: vi.fn(),
    handleOpenAgentWorkspace: navMock.handleOpenAgentWorkspace,
    handleNavSelect: navMock.handleNavSelect,
    handleSelectChatAgent: navMock.handleSelectChatAgent,
  }),
}))

vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    sessionStateByChatId: {},
    activeChatId: chatMock.activeChatId,
    chatList: chatMock.chatList,
    latestChatSessions: chatMock.latestChatSessions,
  }),
}))

vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null }),
}))

vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsMock,
}))

// useConnectorsController needs a QueryClientProvider these render() calls don't
// set up; stub the hook while keeping the real pure helpers.
vi.mock('@hooks/domain/useConnectorsController', async importActual => ({
  ...(await importActual<typeof import('@hooks/domain/useConnectorsController')>()),
  useConnectorsController: () => ({
    loading: false,
    error: null,
    agents: [],
    pendingKey: null,
    refresh: vi.fn(),
    reset: vi.fn(),
    authorize: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  }),
}))

// Chat-mode children pull in a web of chat/composer contexts that are irrelevant
// to the breadcrumb under test.
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({ ChatThread: () => null }))
// The context-window indicator under the breadcrumb is not part of the header.
vi.mock('../ContextWindowIndicator', () => ({ ContextWindowIndicator: () => null }))

function listedEntry(id: string, title: string): ChatListContextValue['chatList'][number] {
  return { id, title, createdAt: '', updatedAt: '', messageCount: 0 }
}

// The fence is the main process's (`chat:captureDeleteFence`), typed off its
// contract. The header only forwards it, so the tests assert the very same
// object reaches the delete and never read inside it.
const deletion: QueuedChatDelete = {
  agentRef: 'alpha',
  fence: {
    version: 1,
    authorityScope: {
      environmentKey: 'fixture-environment',
      userId: 'fixture-user',
      teamId: 'fixture-team',
    },
    bindingGeneration: 1,
    sessionGeneration: 1,
  },
  hostAuthorityEpoch: 1,
}

// A fresh element per call: re-rendering with the very same element is a no-op.
const chatRoute = () => <AgentWorkspace mode="chat" scrollContainerRef={{ current: null }} />
const renderChat = () => render(chatRoute())
const breadcrumb = () => screen.getByRole('navigation', { name: 'Chat breadcrumb' })
const actionsTrigger = (title: string) =>
  screen.getByRole('button', { name: `Conversation actions for ${title}` })
const renameInput = () =>
  screen.getByRole('textbox', { name: 'Rename conversation' }) as HTMLInputElement
const openMenu = (title: string) => fireEvent.click(actionsTrigger(title))
const startRename = (title: string) => {
  openMenu(title)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
}
// The chat header is translated while the thread scrolls, which makes it the
// containing block of a `position: fixed` dialog: one rendered inside it could
// never cover the app. The confirmation portals past it.
const escapesChatHeader = (dialog: HTMLElement) => dialog.closest('.agent-chat-nav-stack') === null

describe('AgentWorkspace chat — conversation header', () => {
  beforeEach(() => {
    mcpMock.agentDisplayByName = { alpha: 'Alpha Host' }
    navMock.selectedAgent = 'alpha'
    chatMock.activeChatId = 'chat-1'
    chatMock.chatList = [listedEntry('chat-1', 'Pricing review')]
    chatMock.latestChatSessions = []
    actionsMock.captureChatDeleteFence.mockImplementation(async () => deletion)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('leads with the agent and names the conversation as the current crumb', () => {
    renderChat()

    const trail = within(breadcrumb())
    expect(trail.getByRole('button', { name: 'Alpha Host' })).toBeTruthy()
    expect(trail.getByText('Pricing review')).toBeTruthy()
    expect(trail.queryByRole('button', { name: 'Chat' })).toBeNull()
    // The title is the current page; the agent is a link back.
    expect(breadcrumb().querySelector('[aria-current="page"]')?.textContent).toBe('Pricing review')
    expect(trail.queryByRole('button', { name: 'Alpha Host' })?.hasAttribute('aria-current')).toBe(
      false
    )
  })

  it('shows the identifier when the agent has no display name', () => {
    mcpMock.agentDisplayByName = {}

    renderChat()

    expect(within(breadcrumb()).getByRole('button', { name: 'alpha' })).toBeTruthy()
  })

  it('goes back to a fresh conversation with the same agent', () => {
    renderChat()

    fireEvent.click(within(breadcrumb()).getByRole('button', { name: 'Alpha Host' }))

    expect(navMock.handleSelectChatAgent).toHaveBeenCalledTimes(1)
    expect(navMock.handleSelectChatAgent).toHaveBeenCalledWith('alpha', { selectLatest: false })
  })

  it('takes the title from the cross-agent list until the chat list describes the conversation', () => {
    chatMock.chatList = []
    chatMock.latestChatSessions = [
      { ...listedEntry('chat-1', 'Pricing review'), agentRef: 'alpha' },
    ]

    const view = renderChat()
    expect(within(breadcrumb()).getByText('Pricing review')).toBeTruthy()

    // Another agent's session with the same id is not this conversation.
    chatMock.latestChatSessions = [{ ...listedEntry('chat-1', 'Pricing review'), agentRef: 'beta' }]
    view.rerender(chatRoute())
    expect(within(breadcrumb()).getByText('Conversation')).toBeTruthy()
  })

  it('offers the conversation actions instead of the agent’s sections', () => {
    renderChat()

    openMenu('Pricing review')

    const menu = within(screen.getByRole('menu'))
    expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toStrictEqual([
      'Rename',
      'Agent details',
      'Delete conversation',
    ])
    for (const section of ['Connectors', 'Members', 'Agent Files', 'Activity']) {
      expect(menu.queryByRole('menuitem', { name: section })).toBeNull()
    }
  })

  it('sends Agent details to the Agents section, not into one agent', () => {
    renderChat()
    openMenu('Pricing review')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent details' }))

    expect(navMock.handleNavSelect).toHaveBeenCalledTimes(1)
    expect(navMock.handleNavSelect).toHaveBeenCalledWith(DESKTOP_ROUTES.agents)
    expect(navMock.handleOpenAgentWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renames the title in place, the way the sidebar does', () => {
    renderChat()
    startRename('Pricing review')

    // The title becomes the editor: same place, current title selected.
    const input = renameInput()
    expect(input.value).toBe('Pricing review')
    expect(document.activeElement).toBe(input)
    expect(input.selectionEnd).toBe('Pricing review'.length)
    expect(within(breadcrumb()).queryByText('Pricing review')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.change(input, { target: { value: 'Roadmap' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(actionsMock.handleRenameChatForAgent).toHaveBeenCalledWith('alpha', 'chat-1', 'Roadmap')
    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).toBeNull()
  })

  it('saves an in-place rename when the editor loses focus', () => {
    renderChat()
    startRename('Pricing review')
    fireEvent.change(renameInput(), { target: { value: '  Roadmap  ' } })

    fireEvent.blur(renameInput())

    expect(actionsMock.handleRenameChatForAgent).toHaveBeenCalledWith('alpha', 'chat-1', 'Roadmap')
    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).toBeNull()
  })

  it('cancels an in-place rename from Escape without saving', () => {
    renderChat()
    startRename('Pricing review')
    fireEvent.change(renameInput(), { target: { value: 'Roadmap' } })

    fireEvent.keyDown(renameInput(), { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).toBeNull()
    expect(within(breadcrumb()).getByText('Pricing review')).toBeTruthy()
    expect(actionsMock.handleRenameChatForAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['unchanged', 'Pricing review'],
    ['blank', '   '],
  ])('does not rename when the edited title is %s', (_case, value) => {
    renderChat()
    startRename('Pricing review')
    fireEvent.change(renameInput(), { target: { value } })

    fireEvent.keyDown(renameInput(), { key: 'Enter' })

    expect(actionsMock.handleRenameChatForAgent).not.toHaveBeenCalled()
    expect(within(breadcrumb()).getByText('Pricing review')).toBeTruthy()
  })

  it('asks before deleting, and cancels without deleting', async () => {
    renderChat()
    openMenu('Pricing review')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }))

    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation?' })
    expect(dialog.textContent).toContain('Pricing review')
    expect(escapesChatHeader(dialog)).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actionsMock.captureChatDeleteFence).toHaveBeenCalledWith('alpha')
    expect(actionsMock.handleDeleteChatForAgent).not.toHaveBeenCalled()
  })

  it('deletes the open conversation with the captured fence once confirmed', async () => {
    renderChat()
    openMenu('Pricing review')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }))

    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete conversation?' })).getByRole(
        'button',
        { name: 'Delete' }
      )
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(actionsMock.handleDeleteChatForAgent).toHaveBeenCalledTimes(1)
    expect(actionsMock.handleDeleteChatForAgent).toHaveBeenCalledWith('alpha', 'chat-1', deletion)
  })

  it('asks nothing when the delete fence cannot be captured', async () => {
    actionsMock.captureChatDeleteFence.mockRejectedValueOnce(new Error('access changed'))
    renderChat()
    openMenu('Pricing review')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }))

    await waitFor(() => expect(actionsMock.captureChatDeleteFence).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actionsMock.handleDeleteChatForAgent).not.toHaveBeenCalled()
  })

  it('closes the menu from Escape and returns focus to its trigger', () => {
    renderChat()
    const trigger = actionsTrigger('Pricing review')
    trigger.focus()
    fireEvent.click(trigger)

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('drops an open editor and confirmation when the conversation changes', async () => {
    const view = renderChat()
    startRename('Pricing review')
    fireEvent.change(renameInput(), { target: { value: 'Roadmap' } })

    chatMock.activeChatId = 'chat-2'
    chatMock.chatList = [listedEntry('chat-2', 'Launch plan')]
    view.rerender(chatRoute())

    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).toBeNull()
    expect(actionsMock.handleRenameChatForAgent).not.toHaveBeenCalled()
    expect(within(breadcrumb()).getByText('Launch plan')).toBeTruthy()
  })

  it('keeps the plain Chat root on the new-chat landing', () => {
    chatMock.activeChatId = null
    chatMock.chatList = []

    renderChat()

    const trail = within(breadcrumb())
    expect(trail.getByRole('button', { name: 'Chat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Conversation actions for/ })).toBeNull()
  })
})
