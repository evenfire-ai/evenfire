import type { ReactNode } from 'react'
import type { RemoteGrantScope } from '../../lib/remoteMcp.types'

export type AddRemoteServerWizardProps = {
  /** Rendered create-page header (icon, title, back). */
  pageHeader: ReactNode
  /** Called after a successful install (201). Redirects to the connectors list. */
  onInstalled: () => void
  /** Called when the operator cancels from the first step. */
  onCancel: () => void
}

export type GrantScopeOption = {
  value: RemoteGrantScope
  label: string
  description: string
}
