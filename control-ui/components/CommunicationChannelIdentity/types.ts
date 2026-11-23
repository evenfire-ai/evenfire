import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'

export type CommunicationChannelIdentityProps = {
  channelName: string
  onNameChange?: (name: string) => void
  agentName: string
  onAgentChange: (name: string) => void
  agentOptions: SelectionDropdownOption[]
  loadingAgents?: boolean
  disabled: boolean
}
