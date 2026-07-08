import { createContext } from 'react'
import type { AgentActivityContextValue, AgentActivityProviderProps } from './types'

export const AgentActivityContext = createContext<AgentActivityContextValue | null>(null)

export function AgentActivityProvider({ value, children }: AgentActivityProviderProps) {
  return <AgentActivityContext.Provider value={value}>{children}</AgentActivityContext.Provider>
}
