// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FleetBoard } from '../FleetBoard'

// FleetBoard deep-links: a fleet row and its Connectors column must both open
// the agent workspace on the Connectors (mcp-servers) tab — never the removed
// `details` tab (Fase 2, spec §5.D).

const nav = vi.hoisted(() => ({
  handleOpenAgentWorkspace: vi.fn(),
  handleOpenTeamDetails: vi.fn(),
  handleSelectChatAgent: vi.fn(),
  selectedAgent: null as string | null,
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => nav,
}))
vi.mock('@contexts/AgentActivityContext', () => ({
  useAgentActivityContext: () => ({ agentLastActiveByAgent: {} }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({ handleCreateChat: vi.fn() }),
}))
vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({
    agentNames: ['agent-x'],
    userAgentNames: ['agent-x'],
    teamAgentNames: [],
  }),
}))
vi.mock('@hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: () => ({
    teams: [],
    currentTeamId: '',
    teamDirectory: {},
    ensureHydrated: vi.fn(async () => undefined),
  }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    agentMcpServerCountByAgent: { 'agent-x': 2 },
    agentMcpServersByAgent: { 'agent-x': [{ name: 'monday' }, { name: 'jira' }] },
    mcpServerMappingUnavailableMessage: 'unavailable',
  }),
}))

describe('FleetBoard — deep-link to the Connectors tab', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('clicking a fleet row opens the agent workspace on the Connectors (mcp-servers) tab', () => {
    const { container } = render(<FleetBoard />)
    const row = container.querySelector<HTMLElement>('.agents-table-row-clickable')
    expect(row).not.toBeNull()
    fireEvent.click(row as HTMLElement)
    expect(nav.handleOpenAgentWorkspace).toHaveBeenCalledWith('agent-x', 'mcp-servers')
  })

  it('the Connectors column button opens the agent workspace on the Connectors tab', () => {
    render(<FleetBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open connectors for agent-x' }))
    expect(nav.handleOpenAgentWorkspace).toHaveBeenCalledWith('agent-x', 'mcp-servers')
  })
})
