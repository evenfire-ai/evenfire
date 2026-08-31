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
  editingName: boolean
  nameDraft: string
  onCancelNameEdit: () => void
  onNameDraftChange: (value: string) => void
  onNavigate: (tab: HostTabKey) => void
  onSaveDisplayName: (displayName: string) => Promise<boolean>
  onSaveLifecycle: (stateless: boolean) => Promise<boolean>
  onStartNameEdit: () => void
  createdAt: string
}
