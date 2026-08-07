// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['product-agent'] }),
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
    selectedAgentMcpServers: [],
  }),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: 'product-agent',
    selectedAgentRoute: 'contexts',
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

describe('AgentWorkspace context rows — visible name (UT-11)', () => {
  afterEach(() => {
    cleanup()
    contextsMock.contextIds = []
    contextsMock.contextDisplayById = {}
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
})
