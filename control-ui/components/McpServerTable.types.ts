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

export type ConnectorContextBinding = {
  name: string
  description?: string
  mcpServers: string[]
}

export type ConnectorContextShareTarget = {
  id: string
  label: string
  contextName: string
  affectedAgentCount: number
}

export type ConnectorContextShareTargets = {
  agents: ConnectorContextShareTarget[]
  teams: ConnectorContextShareTarget[]
  members: ConnectorContextShareTarget[]
}

export type McpServerTableProps = {
  items: McpServerItem[]
  accessByConnectorKey?: Record<string, ConnectorAccessSummary>
  contexts?: ConnectorContextBinding[]
  shareTargets?: ConnectorContextShareTargets
  onOpenContext?: (contextName: string) => void
  onAddToContexts?: (server: ServerRef, contextNames: string[]) => Promise<void>
  onRemoveFromContext?: (server: ServerRef, contextName: string) => Promise<void>
  updatingContextMembershipKey?: string | null
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
