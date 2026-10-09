import type {
  ConnectorAccessPrincipal,
  ConnectorAgentBinding,
  ServerRef,
} from '@components/McpServerTable.types'
import type { ConnectorAccessState } from '@lib/connectorAccessManagement'

export type ConnectorAccessBoundary = 'users' | 'teams' | 'agents'

export type ConnectorDetailAccessPanelProps = {
  boundary: ConnectorAccessBoundary
  server: ServerRef
  snapshot: ConnectorAccessState | null
  agentBindings: ConnectorAgentBinding[]
  loading: boolean
  updating: boolean
  error: string
  notice?: string
  onRemove: (binding: ConnectorAgentBinding) => void
}

export type ConnectorDetailAccessRow = ConnectorAccessPrincipal & {
  binding?: ConnectorAgentBinding
}
