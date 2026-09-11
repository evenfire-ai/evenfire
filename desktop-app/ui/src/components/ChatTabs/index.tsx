import { useContext } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button } from '@components/Common'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { ChatTabsProps } from './types'

export function ChatTabs({ tabs, activeTabId, onSelect, onClose, panelId }: ChatTabsProps) {
  const chatList = useContext(ChatListContext)

  return (
    <div className="chat-view-tabs" role="toolbar" aria-label="Chat tabs">
      <div className="chat-view-tabs__scroller">
        <div className="chat-view-tabs__list">
          {tabs.map(tab => {
            const active = tab.id === activeTabId
            const sessionState =
              tab.agentRef && tab.chatId
                ? chatList?.sessionStateByChatKey[makeTaskKey(tab.agentRef, tab.chatId)]
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
                  <ChatStateBadge sessionState={sessionState} unreadTerminal={false} />
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
