// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  newChatTab,
  openAppTab,
  openChatTab,
  openSettingsTab,
  reorderWorkspaceTab,
} from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
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
        onReorder={vi.fn()}
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
      <WorkspaceTabStrip
        tabs={longTabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
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
        onReorder={vi.fn()}
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
        <WorkspaceTabStrip
          tabs={tabs}
          activeTabId="seed"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
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
        <WorkspaceTabStrip
          tabs={tabs}
          activeTabId="app-1"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
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

describe('WorkspaceTabStrip — reorder (drag & keyboard)', () => {
  // App tabs keep their ids and never dedupe, so this yields three distinct,
  // stably-ordered tabs [a, b, c] derived from the real store producer (T1).
  const threeTabs = openAppTab(
    openAppTab(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'a', appRef: 'ns/x', title: 'Alpha' }),
      { id: 'b', appRef: 'ns/x', title: 'Bravo' }
    ),
    { id: 'c', appRef: 'ns/x', title: 'Charlie' }
  ).tabs

  // jsdom returns a zeroed rect from getBoundingClientRect, so the drop side is
  // computed as 'after' for any clientX >= 0. Pin a real 100px-wide rect (midpoint
  // at x=50) on every element so `clientX` selects the half deterministically:
  // clientX < 50 → 'before', >= 50 → 'after'.
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined
  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => {
    rectSpy?.mockRestore()
  })

  const makeDataTransfer = () => {
    const store: Record<string, string> = {}
    return {
      effectAllowed: '',
      setData: (type: string, value: string) => {
        store[type] = value
      },
      getData: (type: string) => store[type] ?? '',
    }
  }

  const containerFor = (root: HTMLElement, name: string): HTMLElement =>
    screen.getByRole('button', { name }).closest('.chat-view-tab') as HTMLElement

  // jsdom has no DragEvent, so `fireEvent.drop(..., { clientX })` drops clientX on
  // the floor. Build the event explicitly and pin clientX so the side is real.
  const fireDrag = (
    kind: 'dragOver' | 'drop',
    node: HTMLElement,
    dataTransfer: unknown,
    clientX: number
  ): void => {
    const event = createEvent[kind](node, { dataTransfer })
    Object.defineProperty(event, 'clientX', { value: clientX })
    fireEvent(node, event)
  }

  it('drags a left tab to the right of a later tab (shift-adjusted final index)', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const source = containerFor(container, 'Alpha')
    const target = containerFor(container, 'Charlie')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(source, { dataTransfer })
    fireDrag('dragOver', target, dataTransfer, 90)
    fireDrag('drop', target, dataTransfer, 90)
    // Drop after 'c' (index 2); 'a' sat before it, so the final index is 2.
    expect(onReorder).toHaveBeenCalledWith('a', 2)
  })

  it('drags a right tab to the left of an earlier tab (no shift adjustment)', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const source = containerFor(container, 'Charlie')
    const target = containerFor(container, 'Alpha')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(source, { dataTransfer })
    fireDrag('dragOver', target, dataTransfer, 10)
    fireDrag('drop', target, dataTransfer, 10)
    // Drop before 'a' (index 0); 'c' sat after it, so the final index is 0.
    expect(onReorder).toHaveBeenCalledWith('c', 0)
  })

  it('does not reorder when dropped on itself', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const self = containerFor(container, 'Bravo')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(self, { dataTransfer })
    fireDrag('drop', self, dataTransfer, 90)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('moves a tab with Alt+ArrowRight / Alt+ArrowLeft from the focused select', () => {
    const onReorder = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    fireEvent.keyDown(bravo, { key: 'ArrowRight', altKey: true })
    expect(onReorder).toHaveBeenLastCalledWith('b', 2) // index 1 -> 2
    fireEvent.keyDown(bravo, { key: 'ArrowLeft', altKey: true })
    expect(onReorder).toHaveBeenLastCalledWith('b', 0) // index 1 -> 0
  })

  it('ignores arrow keys without Alt (leaves navigation/select alone)', () => {
    const onReorder = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    fireEvent.keyDown(bravo, { key: 'ArrowRight' })
    fireEvent.keyDown(bravo, { key: 'ArrowLeft' })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('keeps focus on the moved tab after a keyboard reorder (list keyed by id)', () => {
    // Drive the real store reducer so the rerender reflects the new order; the
    // moved tab's DOM node persists (keyed by id) and thus keeps DOM focus.
    let state: WorkspaceTabsState = { tabs: threeTabs, activeTabId: 'a' }
    const onReorder = (fromId: string, toIndex: number) => {
      state = reorderWorkspaceTab(state, fromId, toIndex)
    }
    const { rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    bravo.focus()
    expect(document.activeElement).toBe(bravo)
    fireEvent.keyDown(bravo, { key: 'ArrowRight', altKey: true })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'c', 'b'])
    // Same DOM node, now last, still focused.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Bravo' }))
    expect(document.activeElement).toBe(bravo)
  })

  // R3-H2: unlike a reorder (which keeps focus because the keyed node survives), a
  // close removes the focused control, so a keyboard user who closes the ACTIVE tab
  // would drop to <body>. Focus must follow the workspace to the tab that took over.
  it('moves keyboard focus to the surviving active tab when the active tab is closed (R3-H2, T3)', () => {
    // Drive the real store reducer: closing active 'b' (index 1) promotes 'c'.
    let state: WorkspaceTabsState = { tabs: threeTabs, activeTabId: 'b' }
    const onClose = (id: string) => {
      state = closeWorkspaceTab(state, id)
    }
    const { rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    const closeActive = screen.getByRole('button', { name: 'Close Bravo' })
    closeActive.focus()
    expect(document.activeElement).toBe(closeActive)
    // Keyboard activation of the close control: Enter/Space fire a click with
    // `detail === 0` (a pointer click reports >= 1).
    fireEvent.click(closeActive, { detail: 0 })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'c'])
    expect(state.activeTabId).toBe('c')
    // Observable result: focus landed on the now-active tab's control, not <body>.
    const nowActive = screen.getByRole('button', { name: 'Charlie' })
    expect(document.activeElement).toBe(nowActive)
  })

  it('keeps keyboard focus in the strip when the last tab is closed (R3-H2)', () => {
    let state: WorkspaceTabsState = { tabs: [threeTabs[0]!], activeTabId: 'a' }
    const onClose = (id: string) => {
      state = closeWorkspaceTab(state, id)
    }
    const { container, rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    const closeActive = screen.getByRole('button', { name: 'Close Alpha' })
    closeActive.focus()
    fireEvent.click(closeActive, { detail: 0 })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    expect(state.tabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
    // No tab survives, so focus stays in the strip rather than dropping to <body>.
    const strip = container.querySelector('.chat-view-tabs') as HTMLElement
    expect(document.activeElement).toBe(strip)
  })
})
