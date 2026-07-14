import { createContext } from 'react'
import type { WorkspaceActionsContextValue, WorkspaceActionsProviderProps } from './types'

export const WorkspaceActionsContext = createContext<WorkspaceActionsContextValue | null>(null)

export function WorkspaceActionsProvider({ value, children }: WorkspaceActionsProviderProps) {
  return (
    <WorkspaceActionsContext.Provider value={value}>{children}</WorkspaceActionsContext.Provider>
  )
}
