import type { ReactNode } from 'react'
import type { AgentActivitySummary } from '../../pages/AgentsPage.types'

export interface AgentActivityContextValue {
  agentLastActiveByAgent: Record<string, string | null>
  selectedAgentActivitySummary: AgentActivitySummary
}

export interface AgentActivityProviderProps {
  value: AgentActivityContextValue
  children: ReactNode
}
