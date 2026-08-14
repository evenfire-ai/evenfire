import type { ReactNode } from 'react'

export type McpServer = {
  metadata?: { name?: string; namespace?: string }
}

export type SecretMeta = {
  metadata?: { name?: string; namespace?: string }
  name?: string
  // Data-key names only; Secret values are never included in this response.
  keys?: string[]
  type?: string
}

export type ContextOption = {
  contextId: string
  mcpServers: string[]
  name: string
  namespace: string
}

export type HostWizardProps = {
  existingSecrets: SecretMeta[]
  mcpServers: McpServer[]
  mode?: 'modal' | 'page'
  onClose: () => void
  onCreated: () => Promise<void>
  pageHeader?: ReactNode
}

export type WizardSelectOption = {
  label: ReactNode
  meta?: ReactNode
  providers?: { id: string; label: string }[]
  value: string
}

export type WizardSelectProps = {
  className?: string
  disabled?: boolean
  onChange: (value: string) => void
  options: WizardSelectOption[]
  placeholder: string
  value: string
}
