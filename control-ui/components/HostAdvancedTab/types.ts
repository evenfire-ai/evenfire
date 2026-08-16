import type { HostApprovalSectionProps } from '../HostApprovalSection/types'

export type AdvancedSubTab = 'approvals' | 'env'

export type HostAdvancedTabProps = {
  busy: boolean
  hostName: string
  initialLoading: boolean
  initialTools: HostApprovalSectionProps['initialTools']
  onSaveApprovalTools: HostApprovalSectionProps['onSave']
}
