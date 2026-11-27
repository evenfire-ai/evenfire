import type { ReactNode } from 'react'
import type { CommunicationChannelDraftState } from '@lib/communicationChannelEdit'
import type { CommunicationChannelProvider } from '@lib/communicationChannelProviders'

export type ProviderDraft = Pick<
  CommunicationChannelDraftState,
  | 'slackBotHandle'
  | 'slackReplyOnlyWhenMentioned'
  | 'slackReplyInThreads'
  | 'teamsAppName'
  | 'teamsAppId'
  | 'teamsTenantId'
  | 'teamsReplyOnlyWhenMentioned'
  | 'telegramBotHandle'
  | 'telegramReplyOnlyWhenMentioned'
>
export type ChannelProviderSetupProps = {
  channelName: string
  activeProvider: CommunicationChannelProvider
  draft: ProviderDraft
  onChange: (next: ProviderDraft, field?: keyof ProviderDraft) => void
  onProviderChange: (next: CommunicationChannelProvider) => void
  saving: boolean
  /** The route owns new credentials or staged write-only editing of stored credentials. */
  credentials: ReactNode
  /** Existing channels pass gated URLs with their persisted namespace; null means unconfigured. */
  slackRequestUrlOverride?: string | null
  teamsRequestUrlOverride?: string | null
  showRequestUrls?: boolean
}
export type CommandBlockProps = {
  command: string
  copyDisabled?: boolean
  copyLabel: string
  onCopy: () => void
}
export type ProviderPanelProps = {
  checked: boolean
  children: ReactNode
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  onReplyInThreadsChange?: (checked: boolean) => void
  provider: CommunicationChannelProvider
  replyInThreads?: boolean
  description?: string
}
export type RequestUrlFieldProps = {
  provider: 'Slack' | 'Teams'
  url: string | null
  saving: boolean
}
