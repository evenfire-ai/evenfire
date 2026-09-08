// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { AgentWorkspace } from '../AgentWorkspace'

// M2 regression: the Members tab used to collapse "loading" and "read failed"
// into the same empty projection, so a failed access-catalog / team-directory
// read rendered a permanent "No members" instead of surfacing the error.

const contextsMock = vi.hoisted(() => ({
  accessCatalog: null as unknown,
  loading: false,
  error: null as string | null,
}))

const teamsMock = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ agentNames: ['trader'] }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({
    accessCatalog: contextsMock.accessCatalog,
    loading: contextsMock.loading,
    error: contextsMock.error,
  }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentContextByName: {},
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
    loading: teamsMock.loading,
    error: teamsMock.error,
  }),
}))
vi.mock('@hooks/domain/useConnectorsController', async importActual => ({
  ...(await importActual<typeof import('@hooks/domain/useConnectorsController')>()),
  useConnectorsController: () => ({
    loading: false,
    error: null,
    agents: [],
    pendingKey: null,
    actionError: null,
    refresh: vi.fn(),
    reset: vi.fn(),
    authorize: vi.fn(),
    disconnect: vi.fn(),
  }),
}))
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({ me: null }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: 'trader',
    selectedAgentRoute: 'members',
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

function renderWorkspace() {
  return render(<AgentWorkspace scrollContainerRef={{ current: null }} />)
}

describe('AgentWorkspace — Members tab loading/error (M2)', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    contextsMock.accessCatalog = null
    contextsMock.loading = false
    contextsMock.error = null
    teamsMock.loading = false
    teamsMock.error = null
  })

  it('shows an error banner, not "No members", when the contexts read fails', () => {
    contextsMock.error = 'catalog boom'

    renderWorkspace()

    const panel = screen.getByRole('region', { name: 'Agent members' })
    expect(within(panel).getByText('catalog boom')).toBeTruthy()
    expect(within(panel).queryByText('No members')).toBeNull()
  })

  it('shows an error banner, not "No members", when the team directory read fails', () => {
    teamsMock.error = 'directory boom'

    renderWorkspace()

    const panel = screen.getByRole('region', { name: 'Agent members' })
    expect(within(panel).getByText('directory boom')).toBeTruthy()
    expect(within(panel).queryByText('No members')).toBeNull()
  })
})
