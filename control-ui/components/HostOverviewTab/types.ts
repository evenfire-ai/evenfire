export type HostOverviewAccessSummary = {
  memberCount: number
  teamCount: number
}

export type HostOverviewTabProps = {
  hostName: string
  displayName: string
  statusLabel: string
  statusTone: 'active' | 'inactive' | 'unknown'
  contextRef: string
  contextMcpServers: string[]
  contextMcpTotal: number
  contextHref: string
  modelPrimary: string
  modelProviderLine: string
  modelAllowlistLine: string
  accessSummary: HostOverviewAccessSummary
  uid: string
  createdAt: string
  lastUpdated: string
}
