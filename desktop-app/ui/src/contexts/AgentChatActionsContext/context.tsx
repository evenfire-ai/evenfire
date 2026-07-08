import { createContext } from 'react'
import type { AgentChatActionsContextValue, AgentChatActionsProviderProps } from './types'

export const AgentChatActionsContext = createContext<AgentChatActionsContextValue | null>(null)

export function AgentChatActionsProvider({ value, children }: AgentChatActionsProviderProps) {
  return (
    <AgentChatActionsContext.Provider value={value}>{children}</AgentChatActionsContext.Provider>
  )
}
