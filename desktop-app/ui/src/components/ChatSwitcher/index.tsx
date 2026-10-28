import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlusOutlined } from '@ant-design/icons'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListContext } from '@contexts/ChatListContext'
import { Button, Flex, type RefSelectProps, Select } from 'antd'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import type { ChatSwitcherProps } from './types'

/**
 * Open-chats selector for the chat drawer header. It is a thin, read-only view
 * over the chat sub-slice of the universal store: `tabs` are the chat tabs,
 * `activeTabId` the drawer's current chat, and `onSelect`/`onNewChat` drive that
 * same store — no second tab store. Per-chat status badges reuse
 * `sessionStateByChatKey` exactly as the global `WorkspaceTabStrip` does.
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
  const selectRef = useRef<RefSelectProps>(null)
  const lastFocusRequestIdRef = useRef(focusRequestId)

  const active = tabs.find(tab => tab.id === activeTabId) ?? tabs[0]
  const badgeFor = (agentRef: string | null | undefined, chatId: string | null | undefined) =>
    agentRef && chatId ? chatList?.sessionStateByChatKey[makeTaskKey(agentRef, chatId)] : undefined
  const options = useMemo(() => tabs.map(tab => ({ value: tab.id, label: tab.title })), [tabs])
  const renderTabLabel = (tabId: string, label: ReactNode) => {
    const tab = tabs.find(candidate => candidate.id === tabId)
    return (
      <Flex align="center" gap="small">
        <ChatStateBadge
          sessionState={badgeFor(tab?.chat?.agentRef, tab?.chat?.chatId)}
          unreadTerminal={false}
        />
        <span>{label ?? tab?.title ?? ''}</span>
      </Flex>
    )
  }

  // The `chat.switcher` shortcut bumps `focusRequestId`; open and focus the list.
  useEffect(() => {
    if (focusRequestId <= 0 || focusRequestId === lastFocusRequestIdRef.current) return
    lastFocusRequestIdRef.current = focusRequestId
    setOpen(true)
    selectRef.current?.focus()
  }, [focusRequestId])

  return (
    <Select
      aria-label="Open chats"
      className="chat-switcher"
      labelInValue={false}
      labelRender={({ label, value }) => renderTabLabel(String(value), label)}
      optionRender={option => renderTabLabel(String(option.value), option.label)}
      popupRender={menu => (
        <Flex vertical>
          {menu}
          <Button
            block
            icon={<PlusOutlined aria-hidden="true" />}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              setOpen(false)
              onNewChat()
            }}
            size="small"
            type="text"
          >
            New chat
          </Button>
        </Flex>
      )}
      virtual={false}
      onChange={(value: string) => {
        setOpen(false)
        onSelect(value)
      }}
      onOpenChange={setOpen}
      options={options}
      open={open}
      ref={selectRef}
      size="small"
      value={active?.id}
    />
  )
}
