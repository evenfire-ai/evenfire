export type HostOverviewAccessSummary = {
  memberCount: number
  teamCount: number
  memberNames: string[]
  teamNames: string[]
}

export type HostTabKey = 'access' | 'model' | 'connectors'

export type HostOverviewTabProps = {
  hostName: string
  displayName: string
  statusLabel: string
  statusTone: 'active' | 'inactive' | 'unknown'
  contextRef: string
  contextMcpServers: string[]
  contextMcpTotal: number
  modelPrimary: string
  modelProviderLine: string
  modelAllowlistLine: string
  accessSummary: HostOverviewAccessSummary
  onNavigate: (tab: HostTabKey) => void
  createdAt: string
  lastUpdated: string
}
