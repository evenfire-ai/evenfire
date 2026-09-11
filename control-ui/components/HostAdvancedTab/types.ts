import type { HostApprovalSectionProps } from '../HostApprovalSection/types'
import type { HostGuardrailsSectionProps } from '../HostGuardrailsSection/types'

export type AdvancedSubTab = 'hooks' | 'approvals' | 'env'

export type HostAdvancedTabProps = {
  busy: boolean
  hostName: string
  initialLoading: boolean
  initialTools: HostApprovalSectionProps['initialTools']
  onSaveApprovalTools: HostApprovalSectionProps['onSave']
  initialGuardrails: HostGuardrailsSectionProps['initialGuardrails']
  onSaveGuardrails: HostGuardrailsSectionProps['onSave']
}
