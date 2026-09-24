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
  /**
   * True while the header/identity data is still loading. The editable name
   * renders a skeleton instead of falling back to the slug (QA: no flash),
   * and the edit affordance is hidden until a real name is on screen.
   */
  loadingName?: boolean
  description: string
  statusLabel: string
  statusTone: 'active' | 'inactive' | 'unknown'
  contextRef: string
  contextMcpServers: string[]
  contextMcpTotal: number
  modelPrimary: string
  modelProviderLine: string
  accessSummary: HostOverviewAccessSummary
  editingName: boolean
  nameDraft: string
  onCancelNameEdit: () => void
  onNameDraftChange: (value: string) => void
  onNavigate: (tab: HostTabKey) => void
  onSaveDisplayName: (displayName: string) => Promise<boolean>
  onStartNameEdit: () => void
  createdAt: string
}
