// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionMe, TeamDirectoryEntry, TeamMember, TeamSummary } from '../../../../src/types'
import { AuthContext } from '../../contexts/AuthContext'
import type { AuthContextValue } from '../../contexts/AuthContext'
import { NavigationContext } from '../../contexts/NavigationContext'
import type { NavigationContextValue } from '../../contexts/NavigationContext'
import { useTeamsDataController } from '../../hooks/domain/useTeamsDataController'
import { TeamsPage } from '../TeamsPage'

vi.mock('../../contexts/WorkspaceActionsContext', () => ({
  useWorkspaceActionsContext: () => ({
    handleRefreshWorkspaceData: vi.fn(),
  }),
}))

vi.mock('../../hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: vi.fn(),
}))

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

const TEAM_DIRECTORY: Record<string, TeamDirectoryEntry> = {
  'team-1': {
    team: TEAMS[0]!,
    members: TEAM_MEMBERS,
    contextIds: ['ctx-alpha'],
    agentNames: ['alpha'],
  },
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

const makeNavigationValue = (
  overrides: Partial<NavigationContextValue> = {}
): NavigationContextValue => ({
  navItem: 'teams',
  selectedAgent: null,
  selectedAgentRoute: 'details',
  selectedContext: null,
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

const makeTeamsDataValue = (
  overrides: Partial<ReturnType<typeof useTeamsDataController>> = {}
): ReturnType<typeof useTeamsDataController> => ({
  loading: false,
  error: null,
  teams: TEAMS,
  teamMembers: TEAM_MEMBERS,
  teamDirectory: TEAM_DIRECTORY,
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

function renderTeamsPage(teamsOverrides: Partial<ReturnType<typeof useTeamsDataController>> = {}) {
  const teamsValue = makeTeamsDataValue(teamsOverrides)
  useTeamsDataControllerMock.mockReturnValue(teamsValue)

  render(
    <AuthContext.Provider value={makeAuthValue()}>
      <NavigationContext.Provider value={makeNavigationValue()}>
        <TeamsPage />
      </NavigationContext.Provider>
    </AuthContext.Provider>
  )

  return teamsValue
}

describe('TeamsPage', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows capped initial-directory state and lets users load the full directory', () => {
    const refresh = vi.fn(() => Promise.resolve())

    renderTeamsPage({ truncated: true, refresh })

    expect(screen.getByText(/partial team directory/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Load all teams' }))

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not show the capped-directory warning for complete team data', () => {
    renderTeamsPage()

    expect(screen.queryByText(/partial team directory/i)).toBeNull()
  })
})
