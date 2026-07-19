import { useCallback, useState } from 'react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../constants/navigation'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

export function useNavigationController() {
  const [navItem, setNavItem] = useState<NavItem>(DESKTOP_ROUTES.chat)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>(
    AGENT_WORKSPACE_ROUTES.details
  )
  const [selectedContext, setSelectedContext] = useState<string | null>(null)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)

  // Basic nav select — does NOT call cross-domain handlers (no workflow refresh here)
  const handleNavSelect = useCallback((item: NavItem) => {
    setNavItem(item)
    if (item === DESKTOP_ROUTES.agents || item === DESKTOP_ROUTES.chat) {
      setSelectedAgent(null)
      setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.details)
    }
    if (item === DESKTOP_ROUTES.contexts) {
      setSelectedContext(null)
    }
    if (item === DESKTOP_ROUTES.teams) {
      setSelectedTeam(null)
    }
  }, [])

  const handleOpenTeamDetails = useCallback((teamId: string) => {
    if (!teamId) return
    setSelectedTeam(teamId)
    setNavItem(DESKTOP_ROUTES.teamDetails)
  }, [])

  const handleBackToTeams = useCallback(() => {
    setSelectedTeam(null)
    setNavItem(DESKTOP_ROUTES.teams)
  }, [])

  const handleBackToAgents = useCallback(() => {
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.details)
  }, [])

  const handleOpenContextDetails = useCallback((contextId: string) => {
    if (!contextId) return
    setSelectedContext(contextId)
    setNavItem(DESKTOP_ROUTES.contextDetails)
  }, [])

  const handleBackToContexts = useCallback(() => {
    setSelectedContext(null)
    setNavItem(DESKTOP_ROUTES.contexts)
  }, [])

  return {
    navItem,
    selectedAgent,
    selectedAgentRoute,
    selectedContext,
    selectedTeam,
    setNavItem,
    setSelectedAgent,
    setSelectedAgentRoute,
    setSelectedContext,
    setSelectedTeam,
    handleNavSelect,
    handleOpenTeamDetails,
    handleBackToTeams,
    handleBackToAgents,
    handleOpenContextDetails,
    handleBackToContexts,
  }
}
