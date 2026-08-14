import type { ChatLocalMatch } from '@lib/chatLocalSearch'
import type { AgentChatMessage } from '@/uiTypes'

export type ChatLocalSearchProps = {
  messages: AgentChatMessage[]
  onClose: () => void
  onSearchStateChange: (query: string, currentMatch: ChatLocalMatch | null) => void
}
