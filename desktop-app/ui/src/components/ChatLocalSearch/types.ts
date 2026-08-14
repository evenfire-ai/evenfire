import type { ChatLocalMatch } from '@lib/chatLocalSearch'
import type { ChatMessageSemanticModel } from '@lib/chatMessageSemantics'

export type ChatLocalSearchProps = {
  models: readonly ChatMessageSemanticModel[]
  onClose: () => void
  onSearchStateChange: (query: string, currentMatch: ChatLocalMatch | null) => void
}
