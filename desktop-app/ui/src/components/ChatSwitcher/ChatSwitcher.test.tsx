// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import { createWorkspaceTabsState, newChatTab, openChatTab } from '@lib/workspaceTabs'
import { ChatSwitcher } from '.'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'

afterEach(cleanup)
beforeEach(installAntdDomEnvironment)

// Derive the tab list from the real universal-store producers instead of
// hand-writing WorkspaceTab objects — if the tab shape changes, this fixture
// stops compiling against the real form (T1). Two persisted chats
// (chat-1/chat-2, agent 'alpha') plus a trailing blank tab. Ids resolve to 'one'
// (the seed blank reused for the first persisted view), 'two' (view id), and
// 'blank', matching the assertions.
const tabs = newChatTab(
  openChatTab(
    openChatTab(createWorkspaceTabsState('one', 'alpha'), {
      id: 'chat-1-tab',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: 'First chat',
    }),
    { id: 'two', agentRef: 'alpha', chatId: 'chat-2', title: 'Second chat' }
  ),
  'blank',
  'alpha'
).tabs

describe('ChatSwitcher', () => {
  it('shows the active chat in the trigger and lists open chats on demand', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<ChatSwitcher tabs={tabs} activeTabId="one" onSelect={onSelect} onNewChat={vi.fn()} />)

    const trigger = screen.getByRole('combobox', { name: 'Open chats' })
    expect(trigger.closest('.ant-select')?.textContent).toContain('First chat')
    // Collapsed: options are not in the tree.
    expect(screen.queryByRole('listbox')).toBeNull()

    await user.click(trigger.closest('.ant-select')!)
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeTruthy()
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('.ant-select-dropdown-list .ant-select-item-option')
    )
    const firstChat = options.find(option => option.textContent?.includes('First chat'))!
    const secondChat = options.find(option => option.textContent?.includes('Second chat'))!
    expect(firstChat).toBeTruthy()
    expect(secondChat).toBeTruthy()
    const accessibleSecondChat = screen.getByRole('option', { name: 'Second chat' })
    expect(accessibleSecondChat.textContent).toContain('Second chat')
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(firstChat.classList.contains('ant-select-item-option-selected')).toBe(true)

    await user.click(secondChat)
    expect(onSelect).toHaveBeenCalledWith('two')
  })

  it('exposes a new-chat action that closes the menu', async () => {
    const onNewChat = vi.fn()
    const user = userEvent.setup()
    render(<ChatSwitcher tabs={tabs} activeTabId="one" onSelect={vi.fn()} onNewChat={onNewChat} />)
    const trigger = screen.getByRole('combobox', { name: 'Open chats' })
    await user.click(trigger.closest('.ant-select')!)
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and focuses the menu when the chat.switcher shortcut requests it', async () => {
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
    expect(screen.getByRole('listbox')).toBeTruthy()
    const trigger = screen.getByRole('combobox', { name: 'Open chats' })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
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
