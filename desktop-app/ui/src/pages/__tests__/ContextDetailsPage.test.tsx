// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AppService } from '../../../../src/appService'
import type {
  AccessCatalog,
  RpcAgentConnectors,
  SessionMe,
  TeamDirectoryEntry,
  TeamMember,
  TeamSummary,
} from '../../../../src/types'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { NavigationContext } from '../../contexts/NavigationContext'
import type { NavigationContextValue } from '../../contexts/NavigationContext'
import { useConnectorsController } from '../../hooks/domain/useConnectorsController'
import { useContextsDataController } from '../../hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '../../hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '../../hooks/domain/useTeamsDataController'
import type { ContextMcpServerDetail } from '../../uiTypes'
import { ContextDetailsPage } from '../ContextDetailsPage'

vi.mock('../../hooks/domain/useContextsDataController', () => ({
  useContextsDataController: vi.fn(),
}))

vi.mock('../../hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: vi.fn(),
}))

vi.mock('../../hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: vi.fn(),
}))

// Stub only the hook; keep the pure helpers (isSharedConnector /
// isActionableConnector, which the page and connectorPresentation import) real.
vi.mock('../../hooks/domain/useConnectorsController', async importOriginal => {
  const actual = await importOriginal<typeof import('../../hooks/domain/useConnectorsController')>()
  return { ...actual, useConnectorsController: vi.fn() }
})

// AppService (imported only to derive a real AccessCatalog fixture from the
// producer — see deriveAccessCatalog) transitively imports electron at module
// load; stub it so the import resolves under jsdom.
vi.mock('electron', () => ({
  app: {
    isReady: () => false,
    getPath: () => '/tmp/clerum-desktop-test',
    getName: () => 'test',
    on: () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: { openExternal: () => {} },
}))

const useContextsDataControllerMock = vi.mocked(useContextsDataController)
const useMcpServersDataControllerMock = vi.mocked(useMcpServersDataController)
const useTeamsDataControllerMock = vi.mocked(useTeamsDataController)
const useConnectorsControllerMock = vi.mocked(useConnectorsController)

const ME: SessionMe = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo User',
  picture: null,
  teamId: 'team-1',
  teamName: 'Core Team',
  role: null,
}

const TEAMS: TeamSummary[] = [{ id: 'team-1', name: 'Core Team', role: 'admin' }]

const TEAM_MEMBERS: TeamMember[] = [
  { id: 'member-1', email: 'alice@example.com', name: 'Alice', role: 'member', status: 'active' },
]

const ACCESS_CATALOG: AccessCatalog = {
  userId: 'user-1',
  teamId: 'team-1',
  contextIds: ['ctx-alpha', 'ctx-beta'],
  userContextIds: ['ctx-alpha'],
  teamContextIds: ['ctx-alpha'],
  agentNames: ['alpha', 'beta', 'gamma', 'delta'],
  userAgentNames: ['alpha', 'gamma'],
  teamAgentNames: ['beta', 'gamma'],
  mcpServersByAgent: {},
  agentProviderByName: {},
  agentContextByName: {
    alpha: 'ctx-alpha',
    beta: 'ctx-beta',
    gamma: 'ctx-alpha',
    delta: 'ctx-gamma',
  },
}

type DataOverrides = {
  accessCatalog?: AccessCatalog | null
  auth?: Partial<AuthContextValue>
  contexts?: Partial<ReturnType<typeof useContextsDataController>>
  mcpServers?: Partial<ReturnType<typeof useMcpServersDataController>>
  teams?: Partial<ReturnType<typeof useTeamsDataController>>
  connectors?: Partial<ReturnType<typeof useConnectorsController>>
}

const makeAuthValue = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  booting: false,
  busy: false,
  statusText: 'Ready.',
  statusTone: 'info',
  isAuthenticated: true,
  me: ME,
  email: ME.email,
  password: '',
  desktopSetupAuthorizationToken: '',
  desktopSetupStarted: false,
  desktopEnvironmentSetupComplete: false,
  runtimeConfigSetupName: '',
  runtimeConfigSetupExternalRestApiBaseUrl: '',
  runtimeConfigSetupRpcProxyBaseUrl: '',
  authTransitioning: false,
  runtimeConfigState: null,
  desktopReleaseStatus: null,
  pendingDesktopEnvironmentSetup: null,
  backendSwitchHint: null,
  runtimeConfigMissing: false,
  showRuntimeConfigSelector: false,
  dependencyHealth: null,
  hasDependencyOutage: false,
  setBooting: vi.fn(),
  setEmail: vi.fn(),
  setPassword: vi.fn(),
  setDesktopSetupAuthorizationToken: vi.fn(),
  setDesktopEnvironmentSetupComplete: vi.fn(),
  setPendingDesktopEnvironmentSetup: vi.fn(),
  setRuntimeConfigSetupName: vi.fn(),
  setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
  setRuntimeConfigSetupRpcProxyBaseUrl: vi.fn(),
  setStatus: vi.fn(),
  loadSession: vi.fn(),
  handlePasswordLogin: vi.fn(),
  handleSwitchLoginBackend: vi.fn(),
  handleStartDesktopSetup: vi.fn(),
  handleCompleteDesktopSetup: vi.fn(),
  handleSaveRuntimeConfig: vi.fn(),
  handleDeleteRuntimeConfig: vi.fn(),
  handleSelectRuntimeConfig: vi.fn(),
  handleClearRuntimeConfigSelection: vi.fn(),
  handleCancelDesktopEnvironmentSetup: vi.fn(),
  handleConfirmDesktopEnvironmentSetup: vi.fn(),
  handleOpenDesktopRelease: vi.fn(),
  handleLogout: vi.fn(),
  ...overrides,
})

const makeContextsDataValue = (
  accessCatalog: AccessCatalog | null,
  overrides: Partial<ReturnType<typeof useContextsDataController>> = {}
): ReturnType<typeof useContextsDataController> => ({
  loading: false,
  error: null,
  accessCatalog,
  contextIds: accessCatalog?.contextIds ?? [],
  userContextIds: accessCatalog?.userContextIds ?? [],
  teamContextIds: accessCatalog?.teamContextIds ?? [],
  contextDisplayById: accessCatalog?.contextDisplayById ?? {},
  sharedFilesByContext: {},
  sharedFileDirectoriesByContext: {},
  refresh: vi.fn(),
  refreshSharedFiles: vi.fn(),
  loadSharedFilesDirectory: vi.fn(),
  refreshWithCatalog: vi.fn(),
  reset: vi.fn(),
  ...overrides,
})

const makeMcpServersDataValue = (
  accessCatalog: AccessCatalog | null,
  overrides: Partial<ReturnType<typeof useMcpServersDataController>> = {}
): ReturnType<typeof useMcpServersDataController> => ({
  loading: false,
  error: null,
  accessCatalog,
  agentNames: accessCatalog?.agentNames ?? [],
  agentDisplayByName: accessCatalog?.agentDisplayByName ?? {},
  agentContextByName: accessCatalog?.agentContextByName ?? {},
  mcpServersByAgent: accessCatalog?.mcpServersByAgent ?? {},
  globalMcpServers: [],
  mcpServerMappingUnavailableMessage: 'MCP mapping unavailable.',
  agentMcpServerCountByAgent: {},
  agentMcpServersByAgent: {},
  selectedAgentMcpServers: [],
  selectedAgentMcpServerMappingAvailable: false,
  selectedAgentMcpServersUnscoped: false,
  selectedContextMcpServers: [],
  selectedContextMcpServerDetails: [],
  selectedContextMcpServerMappingAvailable: true,
  selectedContextMcpServersUnscoped: false,
  globalMcpServersHydrated: true,
  globalMcpServersError: null,
  refresh: vi.fn(),
  refreshWithCatalog: vi.fn(),
  reset: vi.fn(),
  ...overrides,
})

const makeConnectorsValue = (
  overrides: Partial<ReturnType<typeof useConnectorsController>> = {}
): ReturnType<typeof useConnectorsController> => ({
  loading: false,
  error: null,
  agents: [],
  pendingKey: null,
  refresh: vi.fn(),
  reset: vi.fn(),
  authorize: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => ({ confirmed: true })),
  ...overrides,
})

const makeTeamsDataValue = (
  overrides: Partial<ReturnType<typeof useTeamsDataController>> = {}
): ReturnType<typeof useTeamsDataController> => ({
  loading: false,
  error: null,
  teams: TEAMS,
  teamMembers: TEAM_MEMBERS,
  teamDirectory: {},
  teamDirectoryHydrated: true,
  truncated: false,
  currentTeamId: 'team-1',
  lastUpdatedAt: Date.now(),
  refresh: vi.fn(),
  refreshInitialDirectory: vi.fn(),
  ensureHydrated: vi.fn(),
  reset: vi.fn(),
  ...overrides,
})

const makeNavValue = (overrides: Partial<NavigationContextValue> = {}): NavigationContextValue => ({
  navItem: 'context-details',
  selectedAgent: null,
  selectedAgentRoute: 'details',
  selectedContext: 'ctx-alpha',
  selectedContextTab: 'agents',
  selectedTeam: null,
  handleNavSelect: vi.fn(),
  handleOpenAgentWorkspace: vi.fn(),
  handleSelectChatAgent: vi.fn(),
  handleBackToAgents: vi.fn(),
  handleOpenContextDetails: vi.fn(),
  handleBackToContexts: vi.fn(),
  handleOpenTeamDetails: vi.fn(),
  handleBackToTeams: vi.fn(),
  ...overrides,
})

function buildTree(
  navOverrides: Partial<NavigationContextValue> = {},
  dataOverrides: DataOverrides = {}
) {
  const accessCatalog =
    'accessCatalog' in dataOverrides ? dataOverrides.accessCatalog! : ACCESS_CATALOG
  useContextsDataControllerMock.mockReturnValue(
    makeContextsDataValue(accessCatalog, dataOverrides.contexts)
  )
  useMcpServersDataControllerMock.mockReturnValue(
    makeMcpServersDataValue(accessCatalog, dataOverrides.mcpServers)
  )
  useTeamsDataControllerMock.mockReturnValue(makeTeamsDataValue(dataOverrides.teams))
  useConnectorsControllerMock.mockReturnValue(makeConnectorsValue(dataOverrides.connectors))

  return (
    <AuthContext.Provider value={makeAuthValue(dataOverrides.auth)}>
      <NavigationContext.Provider value={makeNavValue(navOverrides)}>
        <ContextDetailsPage />
      </NavigationContext.Provider>
    </AuthContext.Provider>
  )
}

function renderWithContexts(
  navOverrides: Partial<NavigationContextValue> = {},
  dataOverrides: DataOverrides = {}
) {
  return render(buildTree(navOverrides, dataOverrides))
}

describe('ContextDetailsPage', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders not-found empty state when selectedContext is null', () => {
    renderWithContexts({ selectedContext: null })
    expect(screen.getByText('Context not found')).toBeTruthy()
  })

  it('renders not-found empty state when accessCatalog is null', () => {
    renderWithContexts({}, { accessCatalog: null })
    expect(screen.getByText('Context not found')).toBeTruthy()
  })

  it('renders the selected context name in the page heading', () => {
    renderWithContexts()
    expect(screen.getByRole('heading', { name: 'ctx-alpha' })).toBeTruthy()
  })

  it('calls handleBackToContexts when clicking breadcrumb "Contexts"', () => {
    const handleBackToContexts = vi.fn()
    renderWithContexts({ handleBackToContexts })

    fireEvent.click(screen.getByRole('button', { name: 'Contexts' }))
    expect(handleBackToContexts).toHaveBeenCalledTimes(1)
  })

  it('defaults to agents tab on mount', () => {
    renderWithContexts()
    const agentsTab = screen.getByRole('button', { name: 'Agents' })
    expect(agentsTab.className).toContain('active')
    expect(screen.getByRole('button', { name: 'Open agent alpha' })).toBeTruthy()
  })

  it('shows team content when switching to teams tab', () => {
    renderWithContexts()
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    expect(screen.getByRole('button', { name: 'Open team Core Team' })).toBeTruthy()
  })

  it('shows members content when switching to members tab', () => {
    renderWithContexts()
    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    expect(screen.getByText('Alice')).toBeTruthy()
  })

  it('resets active tab to agents when selectedContext changes', async () => {
    const { rerender } = render(buildTree())

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    expect(screen.getByRole('button', { name: 'Open team Core Team' })).toBeTruthy()

    rerender(
      buildTree(
        { selectedContext: 'ctx-beta' },
        {
          accessCatalog: {
            ...ACCESS_CATALOG,
            userContextIds: ['ctx-alpha', 'ctx-beta'],
            teamContextIds: [],
          },
        }
      )
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Agents' }).className).toContain('active')
    })
    expect(screen.queryByRole('button', { name: 'Open team Core Team' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open agent beta' })).toBeTruthy()
  })

  it('renders only agents mapped to the selected context', () => {
    renderWithContexts()

    expect(screen.getByRole('button', { name: 'Open agent alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open agent gamma' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open agent beta' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open agent delta' })).toBeNull()
  })
})

// Part 3: the context detail's Connectors tab overlays the SHARED read-model +
// Authorize/Disconnect (one controller, one action/confirmation path — D4).
describe('ContextDetailsPage — Connectors tab actions', () => {
  const CONTEXT_SERVERS: ContextMcpServerDetail[] = [
    { name: 'monday', mappedAgentCount: 1, mappedAgents: ['alpha'], mappingSource: 'context-map' },
    { name: 'jira', mappedAgentCount: 1, mappedAgents: ['alpha'], mappingSource: 'context-map' },
    {
      name: 'filesystem',
      mappedAgentCount: 1,
      mappedAgents: ['alpha'],
      mappingSource: 'context-map',
    },
  ]

  // Read-model grouped by agent for ctx-alpha; deriveConnectorRows keys it by
  // server so the table can overlay status/actions. representativeAgent = alpha.
  const CONNECTOR_AGENTS: RpcAgentConnectors[] = [
    {
      name: 'alpha',
      contextRef: 'ctx-alpha',
      connectors: [
        {
          name: 'monday',
          provider: 'monday',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'requires_setup',
        },
        {
          name: 'jira',
          provider: 'jira',
          authKind: 'oauth-user',
          grantScope: 'user',
          status: 'authorized',
        },
        { name: 'filesystem', authKind: 'static', status: 'no_oauth' },
      ],
    },
  ]

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  const openConnectorsTab = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }))
  const connectorRow = (container: HTMLElement, name: string) => {
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.context-mcp-servers-data-table tbody tr')
    )
    const row = rows.find(
      r => r.querySelector('.context-mcp-server-name')?.textContent?.trim() === name
    )
    if (!row) throw new Error(`connector row ${name} not found`)
    return row
  }

  it('(a) drops the URL and Source columns, adds Status + Actions', () => {
    renderWithContexts(
      {},
      {
        mcpServers: { selectedContextMcpServerDetails: CONTEXT_SERVERS },
        connectors: { agents: CONNECTOR_AGENTS },
      }
    )
    openConnectorsTab()

    expect(screen.queryByRole('columnheader', { name: 'URL' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Source' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy()
  })

  it('(b) Authorize for requires_setup, Disconnect for authorized, neither for no_oauth', () => {
    const { container } = renderWithContexts(
      {},
      {
        mcpServers: { selectedContextMcpServerDetails: CONTEXT_SERVERS },
        connectors: { agents: CONNECTOR_AGENTS },
      }
    )
    openConnectorsTab()

    expect(
      within(connectorRow(container, 'monday')).getByRole('button', { name: 'Authorize' })
    ).toBeTruthy()
    expect(
      within(connectorRow(container, 'jira')).getByRole('button', { name: 'Disconnect' })
    ).toBeTruthy()
    const filesystem = connectorRow(container, 'filesystem')
    expect(within(filesystem).queryByRole('button', { name: 'Authorize' })).toBeNull()
    expect(within(filesystem).queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })

  it('(c) actions invoke the shared controller with the representative agent + context', () => {
    const authorize = vi.fn(async () => undefined)
    const disconnect = vi.fn(async () => ({ confirmed: true }))
    const { container } = renderWithContexts(
      {},
      {
        mcpServers: { selectedContextMcpServerDetails: CONTEXT_SERVERS },
        connectors: { agents: CONNECTOR_AGENTS, authorize, disconnect },
      }
    )
    openConnectorsTab()

    fireEvent.click(
      within(connectorRow(container, 'monday')).getByRole('button', { name: 'Authorize' })
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'alpha',
        contextRef: 'ctx-alpha',
        connector: expect.objectContaining({ name: 'monday' }),
      })
    )

    fireEvent.click(
      within(connectorRow(container, 'jira')).getByRole('button', { name: 'Disconnect' })
    )
    expect(disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'alpha',
        contextRef: 'ctx-alpha',
        connector: expect.objectContaining({ name: 'jira' }),
      })
    )
  })

  it('(d) the status pill reflects each connector state', () => {
    const { container } = renderWithContexts(
      {},
      {
        mcpServers: { selectedContextMcpServerDetails: CONTEXT_SERVERS },
        connectors: { agents: CONNECTOR_AGENTS },
      }
    )
    openConnectorsTab()

    const pill = (name: string) =>
      connectorRow(container, name).querySelector('.ui-pill')?.textContent?.trim()
    expect(pill('monday')).toBe('Requires setup')
    expect(pill('jira')).toBe('Authorized')
    expect(pill('filesystem')).toBe('No OAuth')
  })

  it('degrades gracefully (no status/actions) when the read-model is not cached', () => {
    const { container } = renderWithContexts(
      {},
      {
        mcpServers: { selectedContextMcpServerDetails: CONTEXT_SERVERS },
        connectors: { agents: [] },
      }
    )
    openConnectorsTab()

    const monday = connectorRow(container, 'monday')
    expect(monday.querySelector('.ui-pill')).toBeNull()
    expect(within(monday).queryByRole('button', { name: 'Authorize' })).toBeNull()
  })
})

// Regression: cross-team agents (H1). scopedAgents / mappedAgents can include
// agents that live only in another team's directory entry — never in the
// current team's catalog — so `agentDisplayByName` (total ONLY over
// catalog.agentNames) has no entry for them. Rendering the map lookup without a
// fallback leaves an empty cell; the fix falls back to the identifier.
describe('ContextDetailsPage — cross-team agent display (H1)', () => {
  // T1: derive the catalog from the real producer (AppService.refreshAccessCatalog)
  // instead of hand-tabulating it, so agentDisplayByName is genuinely total only
  // over the catalog's own agents and genuinely omits the cross-team agent.
  let derivedCatalog: AccessCatalog

  const CROSS_TEAM_AGENT = 'crossteam-agent'
  const OTHER_TEAM: TeamSummary = { id: 'team-2', name: 'Other Team', role: 'member' }
  const OTHER_TEAM_DIRECTORY: Record<string, TeamDirectoryEntry> = {
    'team-2': {
      team: OTHER_TEAM,
      members: [],
      contextIds: ['ctx-alpha'],
      agentNames: [CROSS_TEAM_AGENT],
    },
  }

  async function deriveAccessCatalog(): Promise<AccessCatalog> {
    const service = new AppService() as unknown as {
      sessionToken: string
      me: SessionMe
      bindCurrentChatStore: (id: string) => Promise<void>
      rpcTokenManager: { getOrIssue: () => unknown; clear: () => void }
      authClient: Record<string, unknown>
      refreshAccessCatalog: () => Promise<AccessCatalog>
    }
    service.sessionToken = 'session-token'
    service.me = ME
    // Catalog construction does not need the chat store; keep it out of the fixture.
    service.bindCurrentChatStore = async () => {}
    service.rpcTokenManager = { getOrIssue: vi.fn(), clear: vi.fn() }
    const currentTeamAgents = {
      agentNames: ['alpha', 'gamma'],
      agents: [
        { name: 'alpha', displayName: 'Alpha Host', contextRef: 'ctx-alpha', mcpServers: [] },
        { name: 'gamma', displayName: 'Gamma Host', contextRef: 'ctx-alpha', mcpServers: [] },
      ],
    }
    service.authClient = {
      getMe: vi.fn().mockResolvedValue(ME),
      getMyContexts: vi.fn().mockResolvedValue({ contextIds: ['ctx-alpha'] }),
      getMyAgents: vi.fn().mockResolvedValue(currentTeamAgents),
      getTeamContexts: vi.fn().mockResolvedValue({ contextIds: ['ctx-alpha'] }),
      getTeamAgents: vi.fn().mockResolvedValue(currentTeamAgents),
    }
    return service.refreshAccessCatalog()
  }

  beforeAll(async () => {
    derivedCatalog = await deriveAccessCatalog()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('producer catalog is total over its own agents and omits the cross-team agent', () => {
    // Guards the fixture's realism (T1): if the producer ever started emitting a
    // display entry for non-catalog agents, this test would no longer cover H1.
    expect(Object.keys(derivedCatalog.agentDisplayByName ?? {}).sort()).toEqual(['alpha', 'gamma'])
    expect(derivedCatalog.agentDisplayByName?.[CROSS_TEAM_AGENT]).toBeUndefined()
    expect(derivedCatalog.agentNames).not.toContain(CROSS_TEAM_AGENT)
  })

  it('shows the identifier for a cross-team agent in the agents tab (no empty cell)', () => {
    renderWithContexts(
      { selectedContext: 'ctx-alpha' },
      {
        accessCatalog: derivedCatalog,
        teams: {
          teams: [{ id: 'team-1', name: 'Core Team', role: 'admin' }, OTHER_TEAM],
          currentTeamId: 'team-1',
          teamDirectory: OTHER_TEAM_DIRECTORY,
        },
      }
    )

    // Catalog agents still render their spec.host display name.
    expect(screen.getByText('Alpha Host')).toBeTruthy()

    // T4: assert the visible cell of the cross-team row, not an intermediate. The
    // row exists (aria-label uses the id), but before the fix its display cell is
    // empty because agentDisplayByName has no entry for the cross-team agent.
    const crossTeamRow = screen.getByRole('button', {
      name: `Open agent ${CROSS_TEAM_AGENT}`,
    })
    expect(within(crossTeamRow).getByText(CROSS_TEAM_AGENT)).toBeTruthy()
  })

  it('shows the identifier for a cross-team mapped agent in the connectors tab', () => {
    renderWithContexts(
      { selectedContext: 'ctx-alpha' },
      {
        accessCatalog: derivedCatalog,
        teams: {
          teams: [{ id: 'team-1', name: 'Core Team', role: 'admin' }, OTHER_TEAM],
          currentTeamId: 'team-1',
          teamDirectory: OTHER_TEAM_DIRECTORY,
        },
        mcpServers: {
          selectedContextMcpServerMappingAvailable: true,
          selectedContextMcpServerDetails: [
            {
              name: 'srv-1',
              mappedAgentCount: 1,
              mappedAgents: [CROSS_TEAM_AGENT],
              mappingSource: 'context-map',
            },
          ],
        },
      }
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }))

    // T4: the mapped-agent reference tag renders the identifier (aria-label uses
    // the id; the visible label was empty before the fix).
    const mappedTag = screen.getByRole('button', {
      name: `Open connectors for agent ${CROSS_TEAM_AGENT}`,
    })
    expect(within(mappedTag).getByText(CROSS_TEAM_AGENT)).toBeTruthy()
  })
})
