import type { ReactNode } from 'react'
import { AgentChatActionsProvider } from './AgentChatActionsContext'
import type { AgentChatActionsContextValue } from './AgentChatActionsContext'
import { ChatComposerStateProvider } from './ChatComposerStateContext'
import type { ChatComposerStateContextValue } from './ChatComposerStateContext'
import { ChatListProvider } from './ChatListContext'
import type { ChatListContextValue } from './ChatListContext'
import { ChatThreadStateProvider } from './ChatThreadStateContext'
import type { ChatThreadStateContextValue } from './ChatThreadStateContext'

type AgentChatProvidersProps = {
  actions: AgentChatActionsContextValue
  chatList: ChatListContextValue
  composerState: ChatComposerStateContextValue
  threadState: ChatThreadStateContextValue
  children: ReactNode
}

/**
 * Convenience wrapper that nests the four chat contexts the old AgentChatContext
 * was split into. Keeps App.tsx's provider tree flat while each value stays its own
 * memoized slice.
 */
export function AgentChatProviders({
  actions,
  chatList,
  composerState,
  threadState,
  children,
}: AgentChatProvidersProps) {
  return (
    <AgentChatActionsProvider value={actions}>
      <ChatListProvider value={chatList}>
        <ChatComposerStateProvider value={composerState}>
          <ChatThreadStateProvider value={threadState}>{children}</ChatThreadStateProvider>
        </ChatComposerStateProvider>
      </ChatListProvider>
    </AgentChatActionsProvider>
  )
}
