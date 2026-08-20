import type { LlmProvider } from '../../lib/llm'

export type HostOverviewAccessSummary = {
  memberCount: number
  teamCount: number
}

export type HostOverviewTabProps = {
  hostName: string
  displayName: string
  contextRef: string
  contextMcpServers: string[]
  provider: LlmProvider
  modelName: string
  fallbackLines: string[]
  allowedModelLines: string[]
  accessSummary: HostOverviewAccessSummary
}
