import type { ReactNode } from 'react'

export type ConnectorAccessPrincipal = {
  id: string
  label: string
}

export type ConnectorAccessSummary = {
  agents: ConnectorAccessPrincipal[]
  users: ConnectorAccessPrincipal[]
  teams: ConnectorAccessPrincipal[]
}

export type ConnectorAccessSummaryMap = Record<string, ConnectorAccessSummary>

export type McpServerCondition = {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export type McpServerStatus = {
  conditions?: McpServerCondition[]
  resolvedEgressIPs?: unknown
}

export type McpServerSpec = {
  image?: string
  contextRef?: string
  description?: string
  enabled?: boolean
  managed?: boolean
  transport?: {
    type?: 'sse' | 'streamableHttp' | 'stdio'
    url?: string
    port?: number
  }
  auth?: {
    type?: 'none' | 'bearer' | 'basic' | 'apiKey'
  }
}

export type McpServerItem = {
  metadata?: { name?: string; namespace?: string }
  spec?: McpServerSpec
  status?: McpServerStatus
}

export type ServerRef = { name: string; namespace: string }

// One write-unit of connector access: the agents that share the underlying
// private context. The contextRef is internal plumbing for the owning page's
// PUT and is never rendered.
export type ConnectorAgentBinding = {
  contextRef: string
  agents: ConnectorAccessPrincipal[]
}

// An agent the operator can grant a connector to. Carries the agent's private
// contextRef so the page can resolve the write target without another lookup.
export type ConnectorAgentTarget = {
  name: string
  label: string
  contextRef: string
}

export type McpServerTableProps = {
  items: McpServerItem[]
  accessByConnectorKey?: Record<string, ConnectorAccessSummary>
  agentBindingsByConnectorName?: Record<string, ConnectorAgentBinding[]>
  agentTargets?: ConnectorAgentTarget[]
  onAddToAgents?: (
    server: ServerRef,
    agents: Array<{ name: string; contextRef: string }>
  ) => Promise<void>
  onRemoveFromAgents?: (server: ServerRef, binding: ConnectorAgentBinding) => Promise<void>
  updatingAgentAccessKey?: string | null
  onDelete?: (server: ServerRef) => Promise<void>
  onEdit?: (server: ServerRef) => void
  deletingKey?: string | null
  onRefresh?: () => void
  onCreate?: () => void
  onInstallFromRegistry?: () => void
  detailContent?: ReactNode
  refreshing?: boolean
  loading?: boolean
}
