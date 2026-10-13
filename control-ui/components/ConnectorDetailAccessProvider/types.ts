import type { ConnectorAgentBinding, ConnectorAgentTarget } from '@components/McpServerTable.types'
import type { ConnectorAccessState } from '@lib/connectorAccessManagement'

export type ConnectorDetailAccessState = {
  snapshot: ConnectorAccessState | null
  agentBindings: ConnectorAgentBinding[]
  agentTargets: ConnectorAgentTarget[]
  loading: boolean
  updating: boolean
  error: string
  notice: string
  refresh: () => Promise<void>
  addAgents: (agents: Array<Pick<ConnectorAgentTarget, 'name' | 'contextRef'>>) => Promise<boolean>
  removeBinding: (binding: ConnectorAgentBinding) => Promise<boolean>
}
