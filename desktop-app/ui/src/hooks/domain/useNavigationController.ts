import { useCallback, useState } from 'react'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

export function useNavigationController() {
  const [navItem, setNavItem] = useState<NavItem>('chat')
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>('details')
  const [selectedContext, setSelectedContext] = useState<string | null>(null)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)

  // Basic nav select — does NOT call cross-domain handlers (no workflow refresh here)
  const handleNavSelect = useCallback((item: NavItem) => {
    setNavItem(item)
    if (item === 'agents' || item === 'chat') {
      setSelectedAgent(null)
      setSelectedAgentRoute('details')
    }
    if (item === 'contexts') {
      setSelectedContext(null)
    }
    if (item === 'teams') {
      setSelectedTeam(null)
    }
  }, [])

  const handleOpenTeamDetails = useCallback((teamId: string) => {
    if (!teamId) return
    setSelectedTeam(teamId)
    setNavItem('team-details')
  }, [])

  const handleBackToTeams = useCallback(() => {
    setSelectedTeam(null)
    setNavItem('teams')
  }, [])

  const handleBackToAgents = useCallback(() => {
    setSelectedAgent(null)
    setSelectedAgentRoute('details')
  }, [])

  const handleOpenContextDetails = useCallback((contextId: string) => {
    if (!contextId) return
    setSelectedContext(contextId)
    setNavItem('context-details')
  }, [])

  const handleBackToContexts = useCallback(() => {
    setSelectedContext(null)
    setNavItem('contexts')
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
