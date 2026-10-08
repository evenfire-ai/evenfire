// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AUTO_REFRESH_POLL_INTERVAL_MS } from '@constants/autoRefresh'
import type { RpcConnectorsResult } from '../../../../../src/types'
import { AgentWorkspace } from '../AgentWorkspace'

// Regression (agent Connectors tab lost OAuth Authorize/Disconnect): the tab
// used to render ONLY the health table, which never had the action. This test
// drives the join between the shared connectors controller and the health table.

// The agent→server mapping (the panel's rows) behaves like a store: a refresh
// that changes it re-renders the panel, the way the access-catalog query does.
const mcpMock = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const mock = {
    selectedAgentMcpServers: [] as { name: string }[],
    refresh: vi.fn(async () => undefined),
    isStale: vi.fn((_maxAgeMs: number) => false),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setServers: (servers: { name: string }[]) => {
      mock.selectedAgentMcpServers = servers
      for (const listener of listeners) listener()
    },
  }
  return mock
})

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
  refresh: vi.fn(async () => undefined),
  isStale: vi.fn((_maxAgeMs: number) => false),
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['trader'] }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ accessCatalog: null }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useMcpServersDataController: () => ({
      agentContextByName: {},
      agentDisplayByName: {},
      selectedAgentMcpServers: useSyncExternalStore(
        mcpMock.subscribe,
        () => mcpMock.selectedAgentMcpServers
      ),
      refresh: mcpMock.refresh,
      isStale: mcpMock.isStale,
    }),
  }
})
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
  useConnectorsController: () => {
    return {
      loading: false,
      error: null,
      agents: connectorsMock.agents,
      pendingKey: connectorsMock.pendingKey,
      actionError: connectorsMock.actionError,
      refresh: connectorsMock.refresh,
      isStale: connectorsMock.isStale,
      reset: vi.fn(),
      authorize: connectorsMock.authorize,
      disconnect: connectorsMock.disconnect,
    }
  },
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

// #991: the panel used to show the sign-in snapshot for the whole session. Its
// rows are mapping-owned (access catalog) and its buttons grant-owned
// (connectors), so ONE scheduler refreshes both while the panel is open.
describe('AgentWorkspace — Connectors panel stays current (#991)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    focusManager.setFocused(undefined)
    navMock.selectedAgentRoute = 'mcp-servers'
    connectorsMock.agents = []
    connectorsMock.refresh.mockImplementation(async () => undefined)
    connectorsMock.isStale.mockImplementation(() => false)
    mcpMock.refresh.mockImplementation(async () => undefined)
    mcpMock.isStale.mockImplementation(() => false)
    mcpMock.selectedAgentMcpServers = []
  })

  it('opening the panel with a stale catalog refreshes both the grants and the mapping', () => {
    mcpMock.isStale.mockImplementation(() => true)
    renderTab()
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(1)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('opening the panel with fresh caches reads them without fetching', () => {
    renderTab()
    expect(connectorsMock.refresh).not.toHaveBeenCalled()
    expect(mcpMock.refresh).not.toHaveBeenCalled()
  })

  it('the poll refreshes both the grants and the mapping every 60s while open', async () => {
    vi.useFakeTimers()
    renderTab()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(1)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(2)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(2)
  })

  it('regaining focus with stale grants refreshes both the grants and the mapping', async () => {
    focusManager.setFocused(false)
    renderTab()
    connectorsMock.isStale.mockImplementation(() => true)
    await act(async () => {
      focusManager.setFocused(true)
    })
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(1)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('a connector attached or detached server-side appears/disappears on the poll, without Refresh', async () => {
    vi.useFakeTimers()
    connectorsMock.agents = CONNECTORS.agents
    mcpMock.selectedAgentMcpServers = [{ name: 'monday' }]
    renderTab()
    expect(screen.queryByTestId('mcp-health-row-clickup')).toBeNull()

    // An admin maps clickup to this agent; the next poll's mapping reload sees it.
    mcpMock.refresh.mockImplementation(async () => {
      mcpMock.setServers([{ name: 'monday' }, { name: 'clickup' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(
      within(screen.getByTestId('mcp-health-row-clickup')).getByRole('button', {
        name: 'Authorize',
      })
    ).toBeTruthy()

    // And unmaps it again.
    mcpMock.refresh.mockImplementation(async () => {
      mcpMock.setServers([{ name: 'monday' }])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(screen.queryByTestId('mcp-health-row-clickup')).toBeNull()
  })

  it('chat mode arms no timer and does not refresh on open, poll, or focus', async () => {
    vi.useFakeTimers()
    connectorsMock.isStale.mockImplementation(() => true)
    mcpMock.isStale.mockImplementation(() => true)
    focusManager.setFocused(false)
    render(<AgentWorkspace scrollContainerRef={{ current: null }} mode="chat" />)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      focusManager.setFocused(true)
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS * 3)
    })
    expect(connectorsMock.refresh).not.toHaveBeenCalled()
    expect(mcpMock.refresh).not.toHaveBeenCalled()
  })

  it('the refresh button reloads both the connector grants and the agent mapping', async () => {
    connectorsMock.agents = CONNECTORS.agents
    mcpMock.selectedAgentMcpServers = [{ name: 'monday' }]
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connectors' }))
    await vi.waitFor(() => expect(connectorsMock.refresh).toHaveBeenCalledTimes(1))
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('the refresh button joins a poll already in flight instead of stacking a second fetch', async () => {
    vi.useFakeTimers()
    let releaseConnectors: () => void = () => undefined
    connectorsMock.refresh.mockImplementation(
      () => new Promise<undefined>(resolve => (releaseConnectors = () => resolve(undefined)))
    )
    renderTab()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(1)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh connectors' }))
    await act(async () => {
      releaseConnectors()
    })
    expect(connectorsMock.refresh).toHaveBeenCalledTimes(1)
    expect(mcpMock.refresh).toHaveBeenCalledTimes(1)
  })
})
