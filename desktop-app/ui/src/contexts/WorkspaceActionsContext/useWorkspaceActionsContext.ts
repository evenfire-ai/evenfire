import { useContext } from 'react'
import { WorkspaceActionsContext } from './context'
import type { WorkspaceActionsContextValue } from './types'

export function useWorkspaceActionsContext(): WorkspaceActionsContextValue {
  const ctx = useContext(WorkspaceActionsContext)
  if (!ctx)
    throw new Error('useWorkspaceActionsContext must be used within WorkspaceActionsProvider')
  return ctx
}
