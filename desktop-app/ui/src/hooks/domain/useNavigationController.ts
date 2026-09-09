import { useCallback, useState } from 'react'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../../constants/navigation'
import type { AgentWorkspaceRoute, NavItem } from '../../uiTypes'

export function useNavigationController() {
  const [navItem, setNavItem] = useState<NavItem>(DESKTOP_ROUTES.chat)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<AgentWorkspaceRoute>(
    AGENT_WORKSPACE_ROUTES.connectors
  )

  // Basic nav select — does NOT call cross-domain handlers (no workflow refresh here)
  const handleNavSelect = useCallback((item: NavItem) => {
    setNavItem(item)
    if (item === DESKTOP_ROUTES.agents || item === DESKTOP_ROUTES.chat) {
      setSelectedAgent(null)
      setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
    }
  }, [])

  const handleBackToAgents = useCallback(() => {
    setSelectedAgent(null)
    setSelectedAgentRoute(AGENT_WORKSPACE_ROUTES.connectors)
  }, [])

  return {
    navItem,
    selectedAgent,
    selectedAgentRoute,
    setNavItem,
    setSelectedAgent,
    setSelectedAgentRoute,
    handleNavSelect,
    handleBackToAgents,
  }
}
