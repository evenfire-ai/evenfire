import type { AgentChatMessage } from '@/uiTypes'

export type ChatLocalSearchProps = {
  messages: AgentChatMessage[]
  onClose: () => void
}
