import type { CommunicationChannelGroup } from '@lib/communicationChannels'

export type CommunicationChannelConversation = CommunicationChannelGroup & {
  provider: 'telegram' | 'slack'
}

export type CommunicationChannelConversationsTableProps = {
  conversations: CommunicationChannelConversation[]
  emptyLabel?: string
  onDelete?: (conversation: CommunicationChannelConversation) => void
  showUserColumn?: boolean
  userLabelsById?: Record<string, string>
}
