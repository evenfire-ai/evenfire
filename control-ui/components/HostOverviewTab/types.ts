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
  description: string
  statusLabel: string
  statusTone: 'active' | 'inactive' | 'unknown'
  contextRef: string
  contextMcpServers: string[]
  contextMcpTotal: number
  modelPrimary: string
  modelProviderLine: string
  stateless: boolean
  lifecycleState: string
  lifecycleReason: string
  statelessRejectionMessage: string
  accessSummary: HostOverviewAccessSummary
  onNavigate: (tab: HostTabKey) => void
  onSaveDisplayName: (displayName: string) => Promise<boolean>
  onSaveLifecycle: (stateless: boolean) => Promise<boolean>
  createdAt: string
}
