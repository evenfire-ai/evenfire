// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { AccessCatalog } from '../../../../../src/types'
import { AgentWorkspace } from '../AgentWorkspace'
import { accessCatalogFromWire } from './__fixtures__/accessCatalog'

const mcpMock = vi.hoisted(() => ({
  agentContextByName: {} as AccessCatalog['agentContextByName'],
}))
const chatThreadProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))

const navMock = vi.hoisted(() => ({
  selectedAgent: 'agent-x' as string | null,
  selectedAgentRoute: 'members' as string,
}))

const agentsMock = vi.hoisted(() => ({
  agentNames: ['agent-x'] as string[],
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: agentsMock.agentNames }),
}))

vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ accessCatalog: null }),
}))

vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: mcpMock.agentContextByName,
    agentDisplayByName: {},
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

// AgentWorkspace now mounts useConnectorsController (Connectors tab OAuth
// actions). Its useQuery needs a QueryClientProvider these render() calls don't
// set up; stub the hook while keeping the real pure helpers (isActionableConnector).
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

vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({
  ChatThread: (props: Record<string, unknown>) => {
    chatThreadProps.last = props
    return null
  },
}))

// The chat's Connect buttons live under ChatThread and need the agent Host's
// Context; AgentWorkspace owns the access-catalog read, so it must hand the map down.
describe('AgentWorkspace chat — agent Context reaches the chat Connect', () => {
  afterEach(() => {
    cleanup()
    mcpMock.agentContextByName = {}
    chatThreadProps.last = null
    vi.clearAllMocks()
  })

  it('passes the access catalog agent->context map to ChatThread', async () => {
    const catalog = await accessCatalogFromWire([
      { name: 'agent-x', contextRef: 'ctx-sales' },
      { name: 'agent-y', contextRef: null },
    ])
    mcpMock.agentContextByName = catalog.agentContextByName

    render(<AgentWorkspace mode="chat" scrollContainerRef={{ current: null }} />)

    expect(chatThreadProps.last?.agentContextByName).toEqual({
      'agent-x': 'ctx-sales',
      'agent-y': null,
    })
  })
})
