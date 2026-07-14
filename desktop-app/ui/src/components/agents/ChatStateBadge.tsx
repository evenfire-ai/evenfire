import { Badge } from '@components/Common'
import type { SessionStateLite } from '../../hooks/domain/useAgentChatController'

/** Single state badge per chat (mutually exclusive by construction, D.5 §6.2). */
export function ChatStateBadge({
  sessionState,
  unreadTerminal,
}: {
  sessionState: SessionStateLite | undefined
  unreadTerminal: boolean
}) {
  if (sessionState?.state === 'processing') return <Badge variant="running" label="Running" />
  if (sessionState?.state === 'awaiting_approval')
    return <Badge variant="awaiting_approval" label="Awaiting approval" />
  if ((!sessionState || sessionState.state === 'idle') && unreadTerminal)
    return <Badge variant="completed_unread" label="Completed, unread" />
  return null
}
