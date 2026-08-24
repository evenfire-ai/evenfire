// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import { ChatTabs } from '.'

afterEach(cleanup)

describe('ChatTabs', () => {
  it('renders the in-memory tab order and exposes non-destructive view actions', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <ChatTabs
        tabs={[
          { id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: 'First chat' },
          { id: 'two', agentRef: 'alpha', chatId: null, title: 'New chat' },
        ]}
        activeTabId="one"
        onSelect={onSelect}
        onClose={onClose}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Chat tabs' })).toBeTruthy()
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
    const { container } = render(
      <ChatTabs
        tabs={[{ id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: longTitle }]}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
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
    expect(styles).toMatch(/\.chat-view-tabs__list\s*\{[^}]*width:\s*max-content;/s)
    expect(styles).toMatch(/\.chat-view-tab__select\s*\{[^}]*flex:\s*1 1 auto;/s)
    expect(styles).toMatch(/\.chat-view-tab__label\s*\{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('shows existing running and approval indicators before their tab names', () => {
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
        <ChatTabs
          tabs={[
            {
              id: 'running',
              agentRef: 'alpha',
              chatId: 'chat-running',
              title: 'Running chat',
            },
            {
              id: 'approval',
              agentRef: 'beta',
              chatId: 'chat-approval',
              title: 'Approval chat',
            },
            { id: 'blank', agentRef: 'alpha', chatId: null, title: 'New chat' },
          ]}
          activeTabId="running"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
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
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })
})
