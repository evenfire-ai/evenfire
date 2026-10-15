// @vitest-environment jsdom
/**
 * #1109: the agent sessions card keeps "Show more" expanded while the agent
 * stays the same, even when the list briefly shrinks during a reload, and
 * resets to the preview when the agent changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SidebarChatEntry } from '../../../hooks/domain/useAgentChatController'
import { ChatThread } from '../ChatThread'

let selectedAgent: string | null = 'agent-a'
let chatList: SidebarChatEntry[] = []

const notificationsValue = { decideApproval: vi.fn(), pushToast: vi.fn() }
const composerStateValue = {
  composerImageAttachments: [] as never[],
  composerReferenceAttachments: [] as never[],
  requestComposerFocus: vi.fn(),
}
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  captureChatDeleteFence: vi.fn(async () => {
    throw new Error('no delete target')
  }),
  handleDeleteChat: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({ selectedAgent, handleSelectChatAgent: vi.fn() }),
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerStateValue,
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    chatList,
    chatListLoading: false,
    chatListHasMoreRemoteSessions: false,
    sessionStateByChatId: {},
  }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => runtimeValue,
}))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => ({
    activeMessages: [],
    groupedMessages: [],
    chatMessagesLoading: false,
    hasOlderMessages: false,
    olderMessagesLoading: false,
    handleLoadOlderMessages: vi.fn(),
    activeChatId: null,
    activityByMessageId: {},
    progressByMessageId: {},
    localSearchQuery: '',
    localSearchCurrentMatch: null,
    semanticModelsByMessageId: new Map(),
  }),
}))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

/** `count` local sessions, newest first: session-1 is the most recent. */
function sessions(count: number): SidebarChatEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const updatedAt = new Date(Date.UTC(2026, 9, 15, 12, 59 - index)).toISOString()
    return {
      id: `session-${index + 1}`,
      title: `Session ${index + 1}`,
      createdAt: updatedAt,
      updatedAt,
      messageCount: 1,
    }
  })
}

function visibleIds(): string[] {
  return screen.getAllByTestId('agent-chat-row').map(row => row.getAttribute('data-chat-id') ?? '')
}

function expandWith(list: SidebarChatEntry[]) {
  chatList = list
  const view = render(<ChatThread />)
  expect(visibleIds()).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(visibleIds()).toHaveLength(list.length)
  return view
}

afterEach(() => {
  cleanup()
  selectedAgent = 'agent-a'
  chatList = []
  vi.clearAllMocks()
})

describe('ChatThread agent sessions card expansion', () => {
  it('T-H10-1: stays expanded when the list shrinks to 3 and grows back to 12', () => {
    const full = sessions(12)
    const { rerender } = expandWith(full)

    chatList = full.slice(0, 3)
    rerender(<ChatThread />)
    // Liveness witness: the three-row list rendered (session-6 is gone).
    expect(visibleIds()).toEqual(['session-1', 'session-2', 'session-3'])

    chatList = full
    rerender(<ChatThread />)

    expect(visibleIds()).toHaveLength(12)
  })

  it('T-H10-2: resets to the preview for another agent and keeps the expansion across A → null → A', () => {
    const full = sessions(12)
    const { rerender } = expandWith(full)

    // A hold of A commits with the selection already cleared (`blockHostAccess`
    // holds and clears in one handler), and the stored list of A stays.
    selectedAgent = null
    rerender(<ChatThread />)
    // Liveness witness: the render with no selected agent happened.
    expect(
      screen.getAllByTestId('agent-chat-row').every(row => !row.hasAttribute('data-agent-ref'))
    ).toBe(true)
    selectedAgent = 'agent-a'
    rerender(<ChatThread />)
    expect(visibleIds()).toHaveLength(12)

    selectedAgent = 'agent-b'
    rerender(<ChatThread />)
    expect(screen.getAllByTestId('agent-chat-row')[0]?.getAttribute('data-agent-ref')).toBe(
      'agent-b'
    )
    expect(visibleIds()).toHaveLength(5)
  })

  it('T-H10-3: a session menu does not reopen when its session leaves and returns to the list', () => {
    const full = sessions(12)
    const { rerender } = expandWith(full)

    fireEvent.click(screen.getByRole('button', { name: 'Session actions for Session 8' }))
    // Liveness witness: the menu of session-8 was open.
    expect(screen.getByRole('group', { name: 'Session actions for Session 8' })).toBeTruthy()

    chatList = full.filter(chat => chat.id !== 'session-8')
    rerender(<ChatThread />)
    expect(visibleIds()).not.toContain('session-8')
    chatList = full
    rerender(<ChatThread />)

    expect(visibleIds()).toContain('session-8')
    expect(screen.queryByRole('group', { name: 'Session actions for Session 8' })).toBeNull()
  })
})
