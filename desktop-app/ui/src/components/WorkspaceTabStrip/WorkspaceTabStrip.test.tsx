// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import {
  createWorkspaceTabsState,
  newChatTab,
  openAppTab,
  openChatTab,
  openSettingsTab,
} from '@lib/workspaceTabs'
import { WorkspaceTabStrip } from '.'

afterEach(cleanup)

// Fixtures are derived from the real universal-store producers, never hand-built
// WorkspaceTab objects — if the store's tab shape changes, these stop compiling
// against the real form (T1). `openChatTab` collapses the first persisted chat
// into the seed blank tab, so the ids resolve deterministically.
const twoChatTabs = newChatTab(
  openChatTab(createWorkspaceTabsState('one', 'alpha'), {
    id: 'one-persisted',
    agentRef: 'alpha',
    chatId: 'chat-1',
    title: 'First chat',
  }),
  'two',
  'alpha'
).tabs

describe('WorkspaceTabStrip', () => {
  it('renders the tab order and exposes non-destructive view actions', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={twoChatTabs}
        activeTabId="one"
        onSelect={onSelect}
        onClose={onClose}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Workspace tabs' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'First chat' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close First chat' }))
    expect(onSelect).toHaveBeenCalledWith('two')
    expect(onClose).toHaveBeenCalledWith('one')
  })

  it('keeps long tab labels left-aligned, truncatable, and separate from close controls', () => {
    const longTitle = 'A very long conversation title that must not overlap its close control'
    const longTabs = openChatTab(createWorkspaceTabsState('one', 'alpha'), {
      id: 'one-persisted',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: longTitle,
    }).tabs
    const { container } = render(
      <WorkspaceTabStrip tabs={longTabs} activeTabId="one" onSelect={vi.fn()} onClose={vi.fn()} />
    )

    const select = screen.getByRole('button', { name: longTitle })
    const scroller = container.querySelector('.chat-view-tabs__scroller')
    const list = container.querySelector('.chat-view-tabs__list')
    const label = container.querySelector('.chat-view-tab__label')
    const close = screen.getByRole('button', { name: `Close ${longTitle}` })
    expect(select.classList.contains('ui-button--align-start')).toBe(true)
    expect(label?.textContent).toBe(longTitle)
    expect(select.nextElementSibling).toBe(close)
    expect(scroller?.firstElementChild).toBe(list)

    const styles = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')
    expect(styles).toMatch(/\.chat-view-tabs\s*\{[^}]*padding:\s*var\(--space-2\) 0 0;/s)
    expect(styles).toMatch(/\.chat-view-tabs__scroller\s*\{[^}]*width:\s*100%;/s)
    expect(styles).toMatch(/\.chat-view-tabs__list\s*\{[^}]*width:\s*100%;/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*flex:\s*1 1 var\(--chat-tab-max\);/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*max-width:\s*var\(--chat-tab-max\);/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*min-width:\s*var\(--chat-tab-min\);/s)
    expect(styles).toMatch(/\.chat-view-tab\.is-active\s*\{[^}]*flex-shrink:\s*0\.4;/s)
    expect(styles).toMatch(/\.chat-view-tabs::after\s*\{[^}]*z-index:\s*-1;/s)
    expect(styles).toMatch(
      /\.chat-view-tab:not\(\.is-active\)\s*\{[^}]*border-bottom:\s*1px solid var\(--chat-view-selected-border\);/s
    )
    expect(styles).toMatch(/\.chat-view-tab__select\s*\{[^}]*flex:\s*1 1 auto;/s)
    expect(styles).toMatch(/\.chat-view-tab__label\s*\{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('associates the active tab control with its owned surface, and only that one', () => {
    const tabs = openChatTab(
      openChatTab(createWorkspaceTabsState('one', 'alpha'), {
        id: 'one-persisted',
        agentRef: 'alpha',
        chatId: 'chat-1',
        title: 'First chat',
      }),
      {
        id: 'two',
        agentRef: 'alpha',
        chatId: 'chat-2',
        title: 'A second conversation with a long title that must remain usable',
      }
    ).tabs
    render(
      <WorkspaceTabStrip
        activeTabId="one"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        panelId="chat-view-panel"
        tabs={tabs}
      />
    )

    expect(screen.getByRole('button', { name: 'First chat' }).getAttribute('aria-controls')).toBe(
      'chat-view-panel'
    )
    expect(
      screen
        .getByRole('button', {
          name: 'A second conversation with a long title that must remain usable',
        })
        .getAttribute('aria-controls')
    ).toBeNull()
  })

  it('shows running and approval indicators before their chat tab names', () => {
    const runningKey = makeTaskKey('alpha', 'chat-running')
    const approvalKey = makeTaskKey('beta', 'chat-approval')
    const fsm = createSessionFsmStore()
    fsm.dispatch(runningKey, { type: 'SEND_STARTED', taskId: 'task-running' })
    fsm.dispatch(runningKey, { type: 'TASK_CREATED', taskId: 'task-running' })
    fsm.dispatch(approvalKey, { type: 'SEND_STARTED', taskId: 'task-approval' })
    fsm.dispatch(approvalKey, { type: 'TASK_CREATED', taskId: 'task-approval' })
    fsm.dispatch(approvalKey, {
      type: 'STREAM_SUSPENDED',
      taskId: 'task-approval',
      approval: { requestId: 'request-1', displayName: 'Run shell' },
    })
    const sessionStateByChatKey = Object.fromEntries(
      Object.entries(fsm.getSnapshot()).map(([key, state]) => [key, projectSessionState(state)])
    )

    const tabs = newChatTab(
      openChatTab(
        openChatTab(createWorkspaceTabsState('seed', 'alpha'), {
          id: 'running',
          agentRef: 'alpha',
          chatId: 'chat-running',
          title: 'Running chat',
        }),
        { id: 'approval', agentRef: 'beta', chatId: 'chat-approval', title: 'Approval chat' }
      ),
      'blank',
      'alpha'
    ).tabs

    render(
      <ChatListProvider
        value={{
          activeChatId: 'chat-running',
          chatList: [],
          chatListLoading: false,
          latestChatSessions: [],
          latestChatSessionsLoading: false,
          sessionStateByChatId: {},
          sessionStateByChatKey,
        }}
      >
        <WorkspaceTabStrip tabs={tabs} activeTabId="seed" onSelect={vi.fn()} onClose={vi.fn()} />
      </ChatListProvider>
    )

    const running = screen.getByLabelText('Running')
    const awaitingApproval = screen.getByLabelText('Awaiting approval')
    const runningLabel = screen.getByText('Running chat')
    const approvalLabel = screen.getByText('Approval chat')

    expect(screen.getByRole('button', { name: 'Running chat' }).contains(running)).toBe(true)
    expect(screen.getByRole('button', { name: 'Approval chat' }).contains(awaitingApproval)).toBe(
      true
    )
    expect(running.nextElementSibling).toBe(runningLabel)
    expect(awaitingApproval.nextElementSibling).toBe(approvalLabel)
    // The blank chat tab carries no live badge — only the two running/approval do.
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('renders app and settings tabs alongside chats, with badges only on chat tabs', () => {
    const runningKey = makeTaskKey('alpha', 'chat-1')
    const fsm = createSessionFsmStore()
    fsm.dispatch(runningKey, { type: 'SEND_STARTED', taskId: 'task-running' })
    fsm.dispatch(runningKey, { type: 'TASK_CREATED', taskId: 'task-running' })
    const sessionStateByChatKey = Object.fromEntries(
      Object.entries(fsm.getSnapshot()).map(([key, state]) => [key, projectSessionState(state)])
    )

    // A universal workspace: one running chat, one app, one settings section.
    const tabs = openSettingsTab(
      openAppTab(
        openChatTab(createWorkspaceTabsState('chat', 'alpha'), {
          id: 'chat',
          agentRef: 'alpha',
          chatId: 'chat-1',
          title: 'Running chat',
        }),
        { id: 'app-1', appRef: 'ns/app', title: 'My App' }
      ),
      { id: 'settings-1', section: 'settings', title: 'Settings' }
    ).tabs

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
        <WorkspaceTabStrip tabs={tabs} activeTabId="app-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </ChatListProvider>
    )

    expect(screen.getByRole('button', { name: 'Running chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My App' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My App' }).getAttribute('aria-pressed')).toBe('true')
    // Only the chat tab carries a live session badge — app/settings do not.
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})
