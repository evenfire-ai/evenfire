import { createContext } from 'react'
import type { McpRuntimeContextValue, McpRuntimeProviderProps } from './types'

export const McpRuntimeContext = createContext<McpRuntimeContextValue | null>(null)

export function McpRuntimeProvider({ value, children }: McpRuntimeProviderProps) {
  return <McpRuntimeContext.Provider value={value}>{children}</McpRuntimeContext.Provider>
}
