import { useContext } from 'react'
import { AgentActivityContext } from './context'
import type { AgentActivityContextValue } from './types'

export function useAgentActivityContext(): AgentActivityContextValue {
  const ctx = useContext(AgentActivityContext)
  if (!ctx) throw new Error('useAgentActivityContext must be used within AgentActivityProvider')
  return ctx
}
