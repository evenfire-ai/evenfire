// @vitest-environment jsdom
import type { PropsWithChildren, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext.types'
import {
  type RenderOptions,
  cleanup,
  fireEvent,
  render as testingLibraryRender,
} from '@testing-library/react'
import { fleetAgentSelector } from '../../../../../test/e2e-playwright/helpers/agentIdentity'
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

const state = vi.hoisted(() => ({
  refs: ['chatllm-stateless', 'researcher'],
  display: { 'chatllm-stateless': 'chatLLM', researcher: 'researcher' } as Record<string, string>,
  open: vi.fn(),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    handleOpenAgentWorkspace: state.open,
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
    agentNames: state.refs,
    agentDisplayByName: state.display,
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
    state.display = { 'chatllm-stateless': 'chatLLM', researcher: 'researcher' }
    state.refs = ['chatllm-stateless', 'researcher']
    state.open.mockClear()
  })

  it('disambiguates names and preserves navigation after a catalog refresh', () => {
    state.display = { 'chatllm-stateless': 'Support', researcher: 'Support' }
    const view = render(<FleetBoard />)
    const rows = () => Array.from(view.container.querySelectorAll('.agents-table-row-clickable'))
    expect(rows().map(row => row.querySelector('strong')?.textContent)).toEqual([
      'Support (chatllm-stateless)',
      'Support (researcher)',
    ])
    rows().forEach(row => fireEvent.click(row))
    expect(state.open.mock.calls).toEqual([
      ['chatllm-stateless', 'mcp-servers'],
      ['researcher', 'mcp-servers'],
    ])
    state.display = { 'chatllm-stateless': 'Renamed', researcher: 'Support' }
    view.rerender(<FleetBoard />)
    expect(rows().map(row => row.querySelector('strong')?.textContent)).toEqual([
      'Renamed',
      'Support',
    ])
    expect(fleetRowHostRefs(rows())).toEqual(['chatllm-stateless', 'researcher'])
    rows().forEach(row => fireEvent.keyDown(row, { key: 'Enter' }))
    expect(state.open.mock.calls.slice(2)).toEqual([
      ['chatllm-stateless', 'mcp-servers'],
      ['researcher', 'mcp-servers'],
    ])
  })

  it('keeps the final rendered names unique when a catalog refresh introduces generated-name collisions', () => {
    state.refs = ['support', 'support-staging', 'support-production']
    state.display = {
      support: 'Main',
      'support-staging': 'Staging',
      'support-production': 'Customer Support (support-staging)',
    }
    const view = render(<FleetBoard />)
    state.display = {
      ...state.display,
      support: 'Customer Support',
      'support-staging': 'Customer Support',
    }
    view.rerender(<FleetBoard />)
    const rows = Array.from(view.container.querySelectorAll('.agents-table-row-clickable'))
    expect(new Set(rows.map(row => row.querySelector('strong')!.textContent)).size).toBe(3)
    expect(new Set(rows.map(row => row.getAttribute('aria-label'))).size).toBe(3)
    rows.forEach(row => fireEvent.click(row))
    expect(state.open.mock.calls.map(([ref]) => ref)).toEqual([
      'support',
      'support-production',
      'support-staging',
    ])
  })

  it('selects exact references when one is a substring and neither display name contains it', () => {
    state.refs = ['support', 'support-prod']
    state.display = { support: 'Customer service', 'support-prod': 'Production service' }
    const { container } = render(<FleetBoard />)
    for (const ref of state.refs) {
      const rows = container.querySelectorAll(fleetAgentSelector(ref))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.getAttribute('data-agent-ref')).toBe(ref)
      fireEvent.click(rows[0]!)
    }
    expect(state.open.mock.calls).toEqual([
      ['support', 'mcp-servers'],
      ['support-prod', 'mcp-servers'],
    ])
  })

  it('reads the hostRef of a row whose display name differs and of one whose display name equals it', () => {
    const { container } = render(<FleetBoard />)
    const rows = Array.from(container.querySelectorAll('.agents-table-row-clickable'))
    // Witness: both row shapes rendered, each showing only its display name.
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.querySelector('strong')?.textContent)).toEqual(['chatLLM', 'researcher'])
    expect(container.querySelectorAll('.agent-row-description')).toHaveLength(0)
    expect(fleetRowHostRefs(rows).sort()).toEqual(['chatllm-stateless', 'researcher'])
  })
})
