import { useContext } from 'react'
import { McpRuntimeContext } from './context'
import type { McpRuntimeContextValue } from './types'

export function useMcpRuntimeContext(): McpRuntimeContextValue {
  const ctx = useContext(McpRuntimeContext)
  if (!ctx) throw new Error('useMcpRuntimeContext must be used within McpRuntimeProvider')
  return ctx
}
