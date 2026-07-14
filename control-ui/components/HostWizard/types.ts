import type { ReactNode } from 'react'
import type { ChannelType } from '../../lib/channelTypes'

export type McpServer = {
  metadata?: { name?: string; namespace?: string }
}

export type SecretMeta = {
  metadata?: { name?: string; namespace?: string }
  name?: string
  type?: string
}

export type { ChannelType }

export type ChannelProvider = Extract<ChannelType, 'telegram' | 'slack'>

export type NewChannelDraft = {
  slackBotHandle: string
  slackReplyOnlyWhenMentioned: boolean
  slackReplyInThreads: boolean
  telegramBotHandle: string
  telegramReplyOnlyWhenMentioned: boolean
}

export type ContextOption = {
  contextId: string
  mcpServers: string[]
  name: string
  namespace: string
}

export type ChannelOption = {
  name: string
  namespace: string
  spec: Record<string, unknown>
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
