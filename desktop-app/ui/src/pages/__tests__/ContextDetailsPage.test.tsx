// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AccessCatalog, SessionMe, TeamMember, TeamSummary } from '../../../../src/types'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { NavigationContext } from '../../contexts/NavigationContext'
import type { NavigationContextValue } from '../../contexts/NavigationContext'
import { useContextsDataController } from '../../hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '../../hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '../../hooks/domain/useTeamsDataController'
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

const useContextsDataControllerMock = vi.mocked(useContextsDataController)
const useMcpServersDataControllerMock = vi.mocked(useMcpServersDataController)
const useTeamsDataControllerMock = vi.mocked(useTeamsDataController)

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
