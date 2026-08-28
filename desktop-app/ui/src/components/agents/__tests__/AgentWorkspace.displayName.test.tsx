// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspace } from '../AgentWorkspace'

const mcpMock = vi.hoisted(() => ({
  agentDisplayByName: {} as Record<string, string>,
}))

const navMock = vi.hoisted(() => ({
  selectedAgent: 'product-agent' as string | null,
  selectedAgentRoute: 'members' as string,
}))

const agentsMock = vi.hoisted(() => ({
  agentNames: ['product-agent'] as string[],
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: agentsMock.agentNames }),
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
    selectedAgent: navMock.selectedAgent,
    selectedAgentRoute: navMock.selectedAgentRoute,
    handleBackToAgents: vi.fn(),
    handleOpenAgentWorkspace: vi.fn(),
    handleSelectChatAgent: vi.fn(),
  }),
}))

vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({ sessionStateByChatId: {}, activeChatId: null }),
}))

vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null }),
}))

// dev added a required AgentChatActions provider to AgentWorkspace (scroll
// control). AgentWorkspace only reads scrollChatToBottom from it; stub just that
// so the display-name assertions below render without the full provider tree.
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({ scrollChatToBottom: vi.fn() }),
}))

vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))

// Chat-mode children pull in a web of chat/composer contexts that are irrelevant
// to the title-selector label under test; stub them so the selector renders in
// isolation.
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({ ChatThread: () => null }))

// R1-M3 (desktop-app): the workspace hero title must show the agent DISPLAY name
// (spec.host, arriving as agentDisplayByName[name]) — not the raw identifier
// (metadata.name) the tables map to a display elsewhere. Single sanctioned
// fallback `agentDisplayByName[name] ?? name` (Decision #6): the id shows only
// when no display exists. The hero renders on any resource route (here Members).
describe('AgentWorkspace hero + breadcrumb — visible agent name (R1-M3)', () => {
  afterEach(() => {
    cleanup()
    mcpMock.agentDisplayByName = {}
    navMock.selectedAgent = 'product-agent'
    navMock.selectedAgentRoute = 'members'
    agentsMock.agentNames = ['product-agent']
    vi.clearAllMocks()
  })

  it('renders the agent display name in the hero AND the breadcrumb when a display differs from the id', () => {
    navMock.selectedAgent = 'alpha'
    navMock.selectedAgentRoute = 'members'
    mcpMock.agentDisplayByName = { alpha: 'Alpha Host' }

    render(<AgentWorkspace scrollContainerRef={{ current: null }} />)

    // Hero title uses .agent-details-name; it must carry the display, not the id.
    const hero = document.querySelector('.agent-details-name')
    expect(hero?.textContent).toBe('Alpha Host')
    // The raw identifier must not be the visible hero title.
    expect(hero?.textContent).not.toBe('alpha')

    // Agents-mode breadcrumb renders the agent item as a clickable button whose
    // visible label must be the display, not the id.
    expect(screen.getByRole('button', { name: 'Alpha Host' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
  })

  it('falls back to the identifier in the hero AND the breadcrumb when no display exists', () => {
    navMock.selectedAgent = 'alpha'
    navMock.selectedAgentRoute = 'members'
    mcpMock.agentDisplayByName = {}

    render(<AgentWorkspace scrollContainerRef={{ current: null }} />)

    const hero = document.querySelector('.agent-details-name')
    expect(hero?.textContent).toBe('alpha')
    expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy()
  })
})

// R1-M3 (class extension): the chat-mode title-row agent selector must also show
// the DISPLAY name — both in the collapsed trigger (selectedLabel) and in each
// dropdown option row (option.label). The identifier still drives selection
// (selectedId / option.id), so switching remains keyed on the id.
describe('AgentWorkspace title selector — visible agent name (R1-M3)', () => {
  afterEach(() => {
    cleanup()
    mcpMock.agentDisplayByName = {}
    navMock.selectedAgent = 'product-agent'
    navMock.selectedAgentRoute = 'members'
    agentsMock.agentNames = ['product-agent']
    vi.clearAllMocks()
  })

  it('shows the display in the collapsed trigger and in the dropdown option row', () => {
    navMock.selectedAgent = 'alpha'
    agentsMock.agentNames = ['alpha']
    mcpMock.agentDisplayByName = { alpha: 'Alpha Host' }

    // Chat mode with no active chat renders the greeting title-row selector.
    render(<AgentWorkspace mode="chat" scrollContainerRef={{ current: null }} />)

    // Collapsed trigger label = the display.
    const triggerLabel = document.querySelector('.agent-title-selector-trigger-label')
    expect(triggerLabel?.textContent).toBe('Alpha Host')

    // Open the dropdown and assert the option row renders the display, not the id.
    fireEvent.click(screen.getByRole('button', { name: 'Switch chat agent' }))
    const optionRow = document.querySelector('.agent-title-selector-row-label')
    expect(optionRow?.textContent).toBe('Alpha Host')
    // The 3-dots aria-label is derived from the visible label too.
    expect(screen.getByRole('menuitem', { name: 'Open Alpha Host sections' })).toBeTruthy()
  })

  it('falls back to the identifier in the trigger when no display exists', () => {
    navMock.selectedAgent = 'alpha'
    agentsMock.agentNames = ['alpha']
    mcpMock.agentDisplayByName = {}

    render(<AgentWorkspace mode="chat" scrollContainerRef={{ current: null }} />)

    const triggerLabel = document.querySelector('.agent-title-selector-trigger-label')
    expect(triggerLabel?.textContent).toBe('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Switch chat agent' }))
    const optionRow = document.querySelector('.agent-title-selector-row-label')
    expect(optionRow?.textContent).toBe('alpha')
  })
})
