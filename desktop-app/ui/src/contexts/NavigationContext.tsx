import { createContext, useContext } from 'react'
import type { AgentWorkspaceRoute, HeldHost, NavItem } from '../uiTypes'

export interface NavigationContextValue {
  navItem: NavItem
  selectedAgent: string | null
  heldAgentRefs: string[]
  /** `heldAgentRefs` with the names the Retry rows show. */
  heldHosts: HeldHost[]
  /**
   * True while the Host of the chat on screen (the focused chat tab's, or the
   * one a hold deselected under the chat drawer) is held and still in the
   * catalog, so its Retry row exists: ChatPage must not select another Host.
   */
  keepFocusedChat: boolean
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
