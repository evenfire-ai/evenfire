import { useContext } from 'react'
import { AgentChatActionsContext } from './context'
import type { AgentChatActionsContextValue } from './types'

export function useAgentChatActionsContext(): AgentChatActionsContextValue {
  const ctx = useContext(AgentChatActionsContext)
  if (!ctx)
    throw new Error('useAgentChatActionsContext must be used within AgentChatActionsProvider')
  return ctx
}
