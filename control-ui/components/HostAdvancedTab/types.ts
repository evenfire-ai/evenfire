import type { ReactNode } from 'react'
import type { HostGuardrailsSectionProps } from '../HostGuardrailsSection/types'

export type AdvancedSubTab = 'hooks' | 'env'

export type HostAdvancedTabProps = {
  busy: boolean
  hostName: string
  initialLoading: boolean
  initialGuardrails: HostGuardrailsSectionProps['initialGuardrails']
  onSaveGuardrails: HostGuardrailsSectionProps['onSave']
  onActionsChange?: (actions: ReactNode | null) => void
}
