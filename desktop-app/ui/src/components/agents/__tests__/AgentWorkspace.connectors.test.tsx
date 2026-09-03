// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RpcConnectorsResult } from '../../../../../src/types'
import { AgentWorkspace } from '../AgentWorkspace'

// Regression (agent Connectors tab lost OAuth Authorize/Disconnect): the tab
// used to render ONLY the health table, which never had the action. This test
// drives the join between the shared connectors controller and the health table.

const mcpMock = vi.hoisted(() => ({
  selectedAgentMcpServers: [] as { name: string }[],
}))

const navMock = vi.hoisted(() => ({
  selectedAgent: 'trader' as string | null,
  selectedAgentRoute: 'mcp-servers' as string,
}))

// Controlled connectors controller. Spies are asserted for the exact action
// payload; `agents` is typed off the RpcConnectorsResult contract (T1 — derived
// from the producer's shape, not an invented payload).
const connectorsMock = vi.hoisted(() => ({
  agents: [] as RpcConnectorsResult['agents'],
  pendingKey: null as string | null,
  actionError: null as string | null,
  authorize: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['trader'] }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ accessCatalog: null }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: {},
    agentDisplayByName: {},
    selectedAgentMcpServers: mcpMock.selectedAgentMcpServers,
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
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({ scrollChatToBottom: vi.fn() }),
}))
vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({ ChatThread: () => null }))

// Keep the real pure helpers (isActionableConnector), stub only the hook so it
// serves the controlled payload without a QueryClientProvider.
vi.mock('@hooks/domain/useConnectorsController', async importActual => ({
  ...(await importActual<typeof import('@hooks/domain/useConnectorsController')>()),
  useConnectorsController: () => ({
    loading: false,
    error: null,
    agents: connectorsMock.agents,
    pendingKey: connectorsMock.pendingKey,
    actionError: connectorsMock.actionError,
    refresh: vi.fn(),
    reset: vi.fn(),
    authorize: connectorsMock.authorize,
    disconnect: connectorsMock.disconnect,
  }),
}))

// One agent ('trader') with an authorized oauth connector, a requires_setup
// oauth connector, and a no_oauth (static) connector. Typed off the contract.
const CONNECTORS: RpcConnectorsResult = {
  userId: 'user-1',
  agents: [
    {
      name: 'trader',
      contextRef: 'ctx-1',
      connectors: [
        {
          name: 'monday',
          provider: 'monday',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'authorized',
        },
        {
          name: 'clickup',
          provider: 'clickup',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'requires_setup',
        },
        { name: 'filesystem', authKind: 'static', status: 'no_oauth' },
      ],
    },
  ],
}

function renderTab() {
  return render(<AgentWorkspace scrollContainerRef={{ current: null }} />)
}

const healthRow = (name: string) => screen.getByTestId(`mcp-health-row-${name}`)

describe('AgentWorkspace — Connectors tab OAuth actions', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    navMock.selectedAgent = 'trader'
    navMock.selectedAgentRoute = 'mcp-servers'
    connectorsMock.agents = []
    connectorsMock.pendingKey = null
    connectorsMock.actionError = null
    mcpMock.selectedAgentMcpServers = []
  })

  it('renders an Authorize button for a requires_setup connector and calls authorize with the agent-scoped action', () => {
    connectorsMock.agents = CONNECTORS.agents
    mcpMock.selectedAgentMcpServers = [
      { name: 'monday' },
      { name: 'clickup' },
      { name: 'filesystem' },
    ]

    renderTab()

    const clickup = healthRow('clickup')
    const authorizeBtn = within(clickup).getByRole('button', { name: 'Authorize' })
    fireEvent.click(authorizeBtn)

    expect(connectorsMock.authorize).toHaveBeenCalledTimes(1)
    expect(connectorsMock.authorize).toHaveBeenCalledWith({
      agentName: 'trader',
      contextRef: 'ctx-1',
      connector: expect.objectContaining({
        name: 'clickup',
        status: 'requires_setup',
        authKind: 'oauth-user',
      }),
    })
    expect(connectorsMock.disconnect).not.toHaveBeenCalled()
  })

  it('renders a Disconnect button for an authorized connector and calls disconnect with the agent-scoped action', () => {
    connectorsMock.agents = CONNECTORS.agents
    mcpMock.selectedAgentMcpServers = [
      { name: 'monday' },
      { name: 'clickup' },
      { name: 'filesystem' },
    ]

    renderTab()

    const monday = healthRow('monday')
    const disconnectBtn = within(monday).getByRole('button', { name: 'Disconnect' })
    fireEvent.click(disconnectBtn)

    expect(connectorsMock.disconnect).toHaveBeenCalledTimes(1)
    expect(connectorsMock.disconnect).toHaveBeenCalledWith({
      agentName: 'trader',
      contextRef: 'ctx-1',
      connector: expect.objectContaining({
        name: 'monday',
        status: 'authorized',
        authKind: 'oauth-user',
      }),
    })
  })

  it('surfaces a controller write failure (actionError) in an error banner (R1-B1 parity with McpServersPage)', () => {
    // The controller never rejects; it records any authorize/disconnect write
    // failure in `actionError`. Both mounts of it (McpServersPage AND this agent
    // panel) must render that error, or a failed action is silent here.
    connectorsMock.agents = CONNECTORS.agents
    connectorsMock.actionError = 'Couldn\'t disconnect "monday". write boom'
    mcpMock.selectedAgentMcpServers = [{ name: 'monday' }]

    renderTab()

    const panel = screen.getByRole('region', { name: 'Agent connectors' })
    expect(within(panel).getByText('Couldn\'t disconnect "monday". write boom')).toBeTruthy()
  })

  it('renders no OAuth action button for a no_oauth connector', () => {
    connectorsMock.agents = CONNECTORS.agents
    mcpMock.selectedAgentMcpServers = [
      { name: 'monday' },
      { name: 'clickup' },
      { name: 'filesystem' },
    ]

    renderTab()

    const filesystem = healthRow('filesystem')
    const actionButtons = within(filesystem)
      .queryAllByRole('button')
      .map(b => b.textContent?.trim())
      .filter(label => label === 'Authorize' || label === 'Disconnect')
    expect(actionButtons).toEqual([])
  })
})
