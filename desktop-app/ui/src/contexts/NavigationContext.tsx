import { createContext, useContext } from 'react'
import type { AgentWorkspaceRoute, NavItem } from '../uiTypes'

export interface NavigationContextValue {
  navItem: NavItem
  selectedAgent: string | null
  selectedAgentRoute: AgentWorkspaceRoute
  selectedContext: string | null
  selectedTeam: string | null
  handleNavSelect: (item: NavItem) => void
  handleOpenAgentWorkspace: (agentName: string, route?: AgentWorkspaceRoute) => void
  handleSelectChatAgent: (
    agentName: string,
    options?: { selectLatest?: boolean; chatId?: string; isRemote?: boolean; title?: string }
  ) => void
  handleBackToAgents: () => void
  handleOpenContextDetails: (contextId: string) => void
  handleBackToContexts: () => void
  handleOpenTeamDetails: (teamId: string) => void
  handleBackToTeams: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function useNavigationContext(): NavigationContextValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigationContext must be used within NavigationContext.Provider')
  return ctx
}

export { NavigationContext }
