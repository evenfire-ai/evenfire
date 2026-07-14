import type { ReactNode } from 'react'
import type { NavItem } from '../../uiTypes'

export interface WorkspaceActionsContextValue {
  handleRefreshWorkspaceData: (route: NavItem) => Promise<void>
}

export interface WorkspaceActionsProviderProps {
  value: WorkspaceActionsContextValue
  children: ReactNode
}
