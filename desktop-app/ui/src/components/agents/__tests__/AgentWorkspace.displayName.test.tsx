// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspace } from '../AgentWorkspace'

// UT-11 (spec §5, F3 desktop-app) — Context display with the single sanctioned
// fallback `contextDisplayById[id] ?? id`:
//  - WITH display: a context whose displayName ("Prod Ctx") differs from its id
//    renders the display.
//  - WITHOUT display: a context with no displayName renders its id
//    (metadata.name) — the only fallback.

const contextsMock = vi.hoisted(() => ({
  contextIds: [] as string[],
  contextDisplayById: {} as Record<string, string>,
}))

const mcpMock = vi.hoisted(() => ({
  agentDisplayByName: {} as Record<string, string>,
}))

const navMock = vi.hoisted(() => ({
  selectedAgent: 'product-agent' as string | null,
  selectedAgentRoute: 'contexts' as string,
}))

const agentsMock = vi.hoisted(() => ({
  agentNames: ['product-agent'] as string[],
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: agentsMock.agentNames }),
}))

vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({
    contextIds: contextsMock.contextIds,
    contextDisplayById: contextsMock.contextDisplayById,
    loading: false,
    error: null,
  }),
}))

vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: {},
    agentDisplayByName: mcpMock.agentDisplayByName,
    selectedAgentMcpServers: [],
  }),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: navMock.selectedAgent,
    selectedAgentRoute: navMock.selectedAgentRoute,
    handleBackToAgents: vi.fn(),
    handleOpenAgentWorkspace: vi.fn(),
    handleSelectChatAgent: vi.fn(),
    handleOpenContextDetails: vi.fn(),
  }),
}))

vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({ sessionStateByChatId: {}, activeChatId: null }),
}))

vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null }),
}))

vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))

// Chat-mode children pull in a web of chat/composer contexts that are irrelevant
// to the title-selector label under test; stub them so the selector renders in
// isolation.
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({ ChatThread: () => null }))

describe('AgentWorkspace context rows — visible name (UT-11)', () => {
  afterEach(() => {
    cleanup()
    contextsMock.contextIds = []
    contextsMock.contextDisplayById = {}
    mcpMock.agentDisplayByName = {}
    navMock.selectedAgent = 'product-agent'
    navMock.selectedAgentRoute = 'contexts'
    vi.clearAllMocks()
  })

  it('renders the context display when present and the id when absent', () => {
    contextsMock.contextIds = ['ctx-with', 'ctx-plain']
    contextsMock.contextDisplayById = { 'ctx-with': 'Prod Ctx' }

    render(<AgentWorkspace scrollContainerRef={{ current: null }} />)

    // Branch WITH display: renders "Prod Ctx", not the id.
    expect(screen.getByText('Prod Ctx')).toBeTruthy()
    expect(screen.queryByText('ctx-with')).toBeNull()
    // Branch WITHOUT display: renders the id (metadata.name) — single fallback.
    expect(screen.getByText('ctx-plain')).toBeTruthy()
  })

  it('falls back to the id when the context display is blank/whitespace-only', () => {
    // An out-of-band write (e.g. kubectl bypassing control-api validation) can
    // leave a whitespace-only spec.displayName. The row must render the stable
    // id, never a blank context label (same class as R4-M1 GfsAgentAccessSection).
    contextsMock.contextIds = ['ctx-blank']
    contextsMock.contextDisplayById = { 'ctx-blank': '   ' }

    render(<AgentWorkspace scrollContainerRef={{ current: null }} />)

    // Observable text is the id, not the whitespace-only display.
    expect(screen.getByText('ctx-blank')).toBeTruthy()
  })
})

// R1-M3 (desktop-app): the workspace hero title must show the agent DISPLAY name
// (spec.host, arriving as agentDisplayByName[name]) — not the raw identifier
// (metadata.name) the tables map to a display elsewhere. Single sanctioned
// fallback `agentDisplayByName[name] ?? name` (Decision #6): the id shows only
// when no display exists. The hero renders on the details route.
describe('AgentWorkspace hero + breadcrumb — visible agent name (R1-M3)', () => {
  afterEach(() => {
    cleanup()
    mcpMock.agentDisplayByName = {}
    navMock.selectedAgent = 'product-agent'
    navMock.selectedAgentRoute = 'contexts'
    agentsMock.agentNames = ['product-agent']
    vi.clearAllMocks()
  })

  it('renders the agent display name in the hero AND the breadcrumb when a display differs from the id', () => {
    navMock.selectedAgent = 'alpha'
    navMock.selectedAgentRoute = 'details'
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
    navMock.selectedAgentRoute = 'details'
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
    navMock.selectedAgentRoute = 'contexts'
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
