import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button } from '@components/Common'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import { useClickOutside } from '@hooks/useClickOutside'
import { activeChatViewTab } from '@lib/chatViewTabs'
import type { ChatSwitcherProps } from './types'

/**
 * Open-chats selector for the chat drawer header. It is a thin, read-only view
 * over the shared global `chatViewTabs`: `tabs` is the list, `activeTabId` the
 * selection, and `onSelect`/`onNewChat` mutate that same state — no second tab
 * store. Per-chat status badges reuse `sessionStateByChatKey` exactly as the
 * full-screen `ChatTabs` strip does.
 */
export function ChatSwitcher({
  tabs,
  activeTabId,
  onSelect,
  onNewChat,
  focusRequestId = 0,
}: ChatSwitcherProps) {
  const chatList = useContext(ChatListContext)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const lastFocusRequestIdRef = useRef(focusRequestId)

  const active = activeChatViewTab({ tabs, activeTabId })
  const activeIndex = Math.max(
    0,
    tabs.findIndex(tab => tab.id === active.id)
  )
  const close = useCallback(() => setOpen(false), [])

  useClickOutside(rootRef, open, close)

  const badgeFor = (agentRef: string | null, chatId: string | null) =>
    agentRef && chatId ? chatList?.sessionStateByChatKey[makeTaskKey(agentRef, chatId)] : undefined

  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  // The `chat.switcher` shortcut bumps `focusRequestId`; open and focus the list.
  useEffect(() => {
    if (focusRequestId <= 0 || focusRequestId === lastFocusRequestIdRef.current) return
    lastFocusRequestIdRef.current = focusRequestId
    setOpen(true)
  }, [focusRequestId])

  const choose = (id: string) => {
    close()
    triggerRef.current?.focus()
    onSelect(id)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
      triggerRef.current?.focus()
      return
    }
    if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = optionRefs.current.findIndex(option => option === document.activeElement)
    let next = current
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = tabs.length - 1
    if (event.key === 'ArrowDown') next = Math.min(tabs.length - 1, current + 1)
    if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
    optionRefs.current[next]?.focus()
  }

  return (
    <div className="chat-switcher" onKeyDown={handleKeyDown} ref={rootRef}>
      <Button
        align="between"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Open chats"
        block
        className="chat-switcher__trigger"
        color="neutral"
        onClick={() => setOpen(current => !current)}
        ref={triggerRef}
        size="sm"
        variant="soft"
      >
        <span className="chat-switcher__trigger-main">
          <ChatStateBadge sessionState={badgeFor(active.agentRef, active.chatId)} unreadTerminal={false} />
          <span className="chat-switcher__label">{active.title}</span>
        </span>
        <span aria-hidden="true" className="chat-switcher__chevron">
          ▾
        </span>
      </Button>
      {open ? (
        <div className="chat-switcher__menu" role="listbox" aria-label="Open chats">
          <div className="chat-switcher__options">
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeTabId
              return (
                <Button
                  key={tab.id}
                  align="start"
                  aria-selected={isActive}
                  className={`chat-switcher__option${isActive ? ' is-active' : ''}`}
                  color="neutral"
                  onClick={() => choose(tab.id)}
                  ref={element => {
                    optionRefs.current[index] = element
                  }}
                  role="option"
                  size="sm"
                  variant="ghost"
                >
                  <ChatStateBadge
                    sessionState={badgeFor(tab.agentRef, tab.chatId)}
                    unreadTerminal={false}
                  />
                  <span className="chat-switcher__label">{tab.title}</span>
                </Button>
              )
            })}
          </div>
          <div className="chat-switcher__footer">
            <Button
              align="start"
              block
              className="chat-switcher__new"
              color="neutral"
              onClick={() => {
                close()
                onNewChat()
              }}
              size="sm"
              variant="ghost"
            >
              + New chat
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
