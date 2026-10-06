import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button } from '@components/Common'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import { useClickOutside } from '@hooks/useClickOutside'
import type { ChatSwitcherProps } from './types'

/**
 * Open-chats selector for the chat drawer header. It is a thin, read-only view
 * over the chat sub-slice of the universal store: `tabs` are the chat tabs,
 * `activeTabId` the current or requested chat, and `onSelect`/`onNewChat` drive
 * that same store — no second tab store. Per-chat status badges reuse
 * `sessionStateByChatKey` exactly as the global `WorkspaceTabStrip` does.
 */
export function ChatSwitcher({
  tabs,
  activeTabId,
  pendingTabId = null,
  loadingTabId = null,
  unavailableTabId = null,
  unavailableReason = 'access',
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

  const active = tabs.find(tab => tab.id === activeTabId) ?? tabs[0]
  const activePending = active?.id === pendingTabId
  const activeLoading = active?.id === loadingTabId
  const activeUnavailable = active?.id === unavailableTabId
  const activeIndex = Math.max(
    0,
    tabs.findIndex(tab => tab.id === active?.id)
  )
  const close = useCallback(() => setOpen(false), [])

  useClickOutside(rootRef, open, close)

  const badgeFor = (agentRef: string | null | undefined, chatId: string | null | undefined) =>
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
        aria-busy={activePending || activeLoading || undefined}
        block
        className="chat-switcher__trigger"
        color="neutral"
        onClick={() => setOpen(current => !current)}
        ref={triggerRef}
        size="sm"
        title={
          activePending
            ? 'Checking host access to this conversation'
            : activeLoading
              ? 'Loading conversation'
              : activeUnavailable
                ? unavailableReason === 'conversation'
                  ? 'Conversation unavailable. Close this tab or select to retry.'
                  : 'Could not verify host access. Select to retry.'
                : undefined
        }
        variant="soft"
      >
        <span className="chat-switcher__trigger-main">
          <ChatStateBadge
            sessionState={badgeFor(active?.chat?.agentRef, active?.chat?.chatId)}
            unreadTerminal={false}
          />
          <span className="chat-switcher__label">{active?.title ?? 'New chat'}</span>
          {(activePending || activeLoading) && (
            <span className="chat-view-tab__pending" aria-hidden="true" />
          )}
          {activeUnavailable && <span className="chat-view-tab__access-error" aria-hidden="true" />}
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
              const pending = tab.id === pendingTabId
              const loading = tab.id === loadingTabId
              const unavailable = tab.id === unavailableTabId
              return (
                <Button
                  key={tab.id}
                  align="start"
                  aria-selected={isActive}
                  aria-label={
                    pending
                      ? `${tab.title}, checking access`
                      : loading
                        ? `${tab.title}, loading conversation`
                        : unavailable
                          ? unavailableReason === 'conversation'
                            ? `${tab.title}, conversation unavailable`
                            : `${tab.title}, access check failed`
                          : undefined
                  }
                  aria-busy={pending || loading || undefined}
                  className={`chat-switcher__option${isActive ? ' is-active' : ''}`}
                  color="neutral"
                  onClick={() => choose(tab.id)}
                  ref={element => {
                    optionRefs.current[index] = element
                  }}
                  role="option"
                  size="sm"
                  title={
                    pending
                      ? 'Checking host access to this conversation'
                      : loading
                        ? 'Loading conversation'
                        : unavailable
                          ? unavailableReason === 'conversation'
                            ? 'Conversation unavailable. Close this tab or select to retry.'
                            : 'Could not verify host access. Select to retry.'
                          : undefined
                  }
                  variant="ghost"
                >
                  <ChatStateBadge
                    sessionState={badgeFor(tab.chat?.agentRef, tab.chat?.chatId)}
                    unreadTerminal={false}
                  />
                  <span className="chat-switcher__label">{tab.title}</span>
                  {(pending || loading) && (
                    <span className="chat-view-tab__pending" aria-hidden="true" />
                  )}
                  {unavailable && (
                    <span className="chat-view-tab__access-error" aria-hidden="true" />
                  )}
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
