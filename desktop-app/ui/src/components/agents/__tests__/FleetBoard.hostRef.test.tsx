// @vitest-environment jsdom
import type { PropsWithChildren, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext.types'
import { type RenderOptions, cleanup, render as testingLibraryRender } from '@testing-library/react'
import { fleetRowHostRefs } from '../../../../../test/e2e-playwright/helpers/fleetRowHostRefs'
import { FleetBoard } from '../FleetBoard'

function AuthContextTestWrapper({ children }: PropsWithChildren) {
  return (
    <AuthContext.Provider value={{ me: null } as AuthContextValue}>{children}</AuthContext.Provider>
  )
}

function render(ui: ReactElement, options?: RenderOptions) {
  return testingLibraryRender(ui, { ...options, wrapper: AuthContextTestWrapper })
}

// The stateless-wake spec reads hostRefs from the rendered FleetBoard rows.
// Both row shapes are rendered here: one whose display name differs from its
// hostRef, and one whose display name equals it.

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    handleOpenAgentWorkspace: vi.fn(),
    handleSelectChatAgent: vi.fn(),
    selectedAgent: null,
  }),
}))
vi.mock('@contexts/AgentActivityContext', () => ({
  useAgentActivityContext: () => ({ agentLastActiveByAgent: {} }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({ handleCreateChat: vi.fn() }),
}))
vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({
    agentNames: ['chatllm-stateless', 'researcher'],
    agentDisplayByName: { 'chatllm-stateless': 'chatLLM', researcher: 'researcher' },
    userAgentNames: ['chatllm-stateless', 'researcher'],
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
    agentMcpServerCountByAgent: {},
    agentMcpServersByAgent: {},
    mcpServerMappingUnavailableMessage: 'unavailable',
  }),
}))

describe('fleetRowHostRefs on rendered FleetBoard rows', () => {
  afterEach(() => {
    cleanup()
  })

  it('reads the hostRef of a row whose display name differs and of one whose display name equals it', () => {
    const { container } = render(<FleetBoard />)
    const rows = Array.from(container.querySelectorAll('.agents-table-row-clickable'))
    // Witness: both row shapes rendered; the second has a single description.
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.querySelectorAll('.agent-row-description').length).sort()).toEqual([
      1, 2,
    ])
    expect(fleetRowHostRefs(rows).sort()).toEqual(['chatllm-stateless', 'researcher'])
  })
})
