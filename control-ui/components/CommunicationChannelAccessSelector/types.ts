import type { AgentTeam, AgentUser } from '@lib/api'

export type CommunicationChannelAccessSelectorProps = {
  agentName: string
  disabled?: boolean
  inlineDropdowns?: boolean
  selectedTeamIds: string[]
  selectedUserIds: string[]
  onSelectedTeamIdsChange: (next: string[]) => void
  onSelectedUserIdsChange: (next: string[]) => void
}

export type CommunicationChannelAccessTab = 'members' | 'teams'

export type CommunicationChannelAccessDirectory = {
  teams: AgentTeam[]
  users: AgentUser[]
}
