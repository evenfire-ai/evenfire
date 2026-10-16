import { createContext, useContext } from 'react'
import type { AgentWorkspaceRoute, NavItem } from '../uiTypes'

export interface NavigationContextValue {
  navItem: NavItem
  selectedAgent: string | null
  heldAgentRefs: string[]
  /** The Host of the active chat tab, or null when no chat tab is active or it has no Host. */
  focusedChatAgentRef: string | null
  selectedAgentRoute: AgentWorkspaceRoute
  handleNavSelect: (item: NavItem) => void
  handleOpenAgentWorkspace: (agentName: string, route?: AgentWorkspaceRoute) => void
  handleSelectChatAgent: (
    agentName: string,
    options?: { selectLatest?: boolean; chatId?: string; isRemote?: boolean; title?: string }
  ) => void
  handleBackToAgents: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function useNavigationContext(): NavigationContextValue {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigationContext must be used within NavigationContext.Provider')
  return ctx
}

export { NavigationContext }
