import type { ReactNode } from 'react'
import type { HostRuntimeStatus } from '../../../../src/types'

export interface McpRuntimeContextValue {
  hostRuntimeStatus: HostRuntimeStatus | null
  hostRuntimeLoading: boolean
  hostRuntimeError: string | null
  hostRuntimeLastUpdatedAt: number | null
  hostRuntimeIsStale: boolean
  activeLlmModel: string | null
  activeLlmProvider: string | null
  mcpHealthRefreshing: boolean
  handleRefreshMcpHealth: () => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
}

export interface McpRuntimeProviderProps {
  value: McpRuntimeContextValue
  children: ReactNode
}
