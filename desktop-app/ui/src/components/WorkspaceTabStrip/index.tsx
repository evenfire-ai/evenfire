import { useContext } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button } from '@components/Common'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { WorkspaceTabStripProps } from './types'

/**
 * The single global workspace strip (spec 01 §4.2, mini-spec 03 §3). It renders
 * every tab in the universal store — chat, app, files, settings — and is the
 * only tab strip in the app (it absorbs the old chat-only `ChatTabs`). Chat tabs
 * show their live session badge via `sessionStateByChatKey`, exactly as the
 * former strip did; non-chat tabs carry no badge. Selecting a tab activates it
 * (the seam derives the route from the active tab); the close control removes it.
 */
export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  panelId,
}: WorkspaceTabStripProps) {
  const chatList = useContext(ChatListContext)

  return (
    <div className="chat-view-tabs" role="toolbar" aria-label="Workspace tabs">
      <div className="chat-view-tabs__scroller">
        <div className="chat-view-tabs__list">
          {tabs.map(tab => {
            const active = tab.id === activeTabId
            const sessionState =
              tab.kind === 'chat' && tab.chat?.agentRef && tab.chat?.chatId
                ? chatList?.sessionStateByChatKey[makeTaskKey(tab.chat.agentRef, tab.chat.chatId)]
                : undefined
            return (
              <div className={`chat-view-tab${active ? ' is-active' : ''}`} key={tab.id}>
                <Button
                  align="start"
                  aria-controls={active ? panelId : undefined}
                  aria-label={tab.title}
                  aria-pressed={active}
                  className="chat-view-tab__select"
                  color="neutral"
                  onClick={() => onSelect(tab.id)}
                  size="sm"
                  variant="ghost"
                >
                  {tab.kind === 'chat' && (
                    <ChatStateBadge sessionState={sessionState} unreadTerminal={false} />
                  )}
                  <span className="chat-view-tab__label">{tab.title}</span>
                </Button>
                <Button
                  aria-label={`Close ${tab.title}`}
                  className="chat-view-tab__close"
                  color="neutral"
                  onClick={() => onClose(tab.id)}
                  size="xs"
                  variant="ghost"
                >
                  <span aria-hidden="true">×</span>
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
