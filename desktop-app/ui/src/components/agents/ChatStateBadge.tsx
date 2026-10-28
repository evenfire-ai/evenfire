import { Tag } from 'antd'
import type { SessionStateLite } from '../../hooks/domain/useAgentChatController'

/** Single state badge per chat (mutually exclusive by construction, D.5 §6.2). */
export function ChatStateBadge({
  sessionState,
  unreadTerminal,
}: {
  sessionState: SessionStateLite | undefined
  unreadTerminal: boolean
}) {
  if (sessionState?.state === 'processing') {
    return (
      <Tag color="processing" role="status" aria-label="Running">
        Running
      </Tag>
    )
  }
  if (sessionState?.state === 'awaiting_approval')
    return (
      <Tag color="warning" role="status" aria-label="Awaiting approval">
        Awaiting approval
      </Tag>
    )
  if ((!sessionState || sessionState.state === 'idle') && unreadTerminal)
    return (
      <Tag color="success" role="status" aria-label="Completed, unread">
        Completed, unread
      </Tag>
    )
  return null
}
