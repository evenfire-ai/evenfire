// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import { ChatSwitcher } from '.'

afterEach(cleanup)

const tabs = [
  { id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: 'First chat' },
  { id: 'two', agentRef: 'alpha', chatId: 'chat-2', title: 'Second chat' },
  { id: 'blank', agentRef: 'alpha', chatId: null, title: 'New chat' },
]

describe('ChatSwitcher', () => {
  it('shows the active chat in the trigger and lists open chats on demand', () => {
    const onSelect = vi.fn()
    render(
      <ChatSwitcher tabs={tabs} activeTabId="one" onSelect={onSelect} onNewChat={vi.fn()} />
    )

    const trigger = screen.getByRole('button', { name: 'Open chats' })
    expect(trigger.textContent).toContain('First chat')
    // Collapsed: options are not in the tree.
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox', { name: 'Open chats' })
    expect(listbox).toBeTruthy()
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'First chat',
      'Second chat',
      'New chat',
    ])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('option', { name: 'Second chat' }))
    expect(onSelect).toHaveBeenCalledWith('two')
  })

  it('exposes a new-chat action that closes the menu', () => {
    const onNewChat = vi.fn()
    render(
      <ChatSwitcher tabs={tabs} activeTabId="one" onSelect={vi.fn()} onNewChat={onNewChat} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open chats' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New chat' }))
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens the menu when the focus request id increments (the chat.switcher shortcut)', () => {
    const { rerender } = render(
      <ChatSwitcher
        tabs={tabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        focusRequestId={0}
      />
    )
    expect(screen.queryByRole('listbox')).toBeNull()

    rerender(
      <ChatSwitcher
        tabs={tabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onNewChat={vi.fn()}
        focusRequestId={1}
      />
    )
    expect(screen.getByRole('listbox', { name: 'Open chats' })).toBeTruthy()
  })

  it('reuses per-chat session badges from sessionStateByChatKey', () => {
    const runningKey = makeTaskKey('alpha', 'chat-1')
    const fsm = createSessionFsmStore()
    fsm.dispatch(runningKey, { type: 'SEND_STARTED', taskId: 'task-running' })
    fsm.dispatch(runningKey, { type: 'TASK_CREATED', taskId: 'task-running' })
    const sessionStateByChatKey = Object.fromEntries(
      Object.entries(fsm.getSnapshot()).map(([key, state]) => [key, projectSessionState(state)])
    )

    render(
      <ChatListProvider
        value={{
          activeChatId: 'chat-1',
          chatList: [],
          chatListLoading: false,
          latestChatSessions: [],
          latestChatSessionsLoading: false,
          sessionStateByChatId: {},
          sessionStateByChatKey,
        }}
      >
        <ChatSwitcher tabs={tabs} activeTabId="one" onSelect={vi.fn()} onNewChat={vi.fn()} />
      </ChatListProvider>
    )

    // The badge shows in the collapsed trigger for the active chat.
    expect(screen.getByLabelText('Running')).toBeTruthy()
  })
})
