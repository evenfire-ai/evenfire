// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../../constants/navigation'
import { useNavigationController } from '../useNavigationController'

describe('useNavigationController — agent-centric navigation (Fase 2)', () => {
  it('defaults selectedAgentRoute to Connectors (mcp-servers), not details', () => {
    const { result } = renderHook(() => useNavigationController())
    expect(result.current.selectedAgentRoute).toBe(AGENT_WORKSPACE_ROUTES.connectors)
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('handleBackToAgents resets the workspace route to Connectors', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.activity))
    act(() => result.current.handleBackToAgents())
    expect(result.current.selectedAgent).toBeNull()
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('opening chat/agents from the nav resets the route to Connectors', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.members))
    act(() => result.current.handleNavSelect(DESKTOP_ROUTES.agents))
    expect(result.current.selectedAgentRoute).toBe('mcp-servers')
  })

  it('no longer exposes the removed context/teams handlers or state', () => {
    const { result } = renderHook(() => useNavigationController())
    const controller = result.current as Record<string, unknown>
    expect(controller.handleOpenContextDetails).toBeUndefined()
    expect(controller.handleBackToContexts).toBeUndefined()
    expect(controller.handleOpenTeamDetails).toBeUndefined()
    expect(controller.handleBackToTeams).toBeUndefined()
    expect(controller.selectedContext).toBeUndefined()
    expect(controller.selectedContextTab).toBeUndefined()
    expect(controller.selectedTeam).toBeUndefined()
  })
})
