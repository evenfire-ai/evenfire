// @vitest-environment jsdom
/**
 * #582 — the progress stepper's "N tools" list must survive a reload. The live
 * steps live in `progressByMessageId` (renderer-only); after a reload that map is
 * empty and the tools come from the assistant message's persisted/hydrated
 * `toolSteps`. These tests exercise the `ChatThread` fallback selection:
 *   - live progress present  → render from it (no fallback, no double-render)
 *   - live progress absent    → render from `message.toolSteps`
 *   - neither                 → render nothing
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MessageToolStep } from '../../../../../src/types'
import type { AgentChatMessage, TaskProgress } from '../../../uiTypes'
// vi.mock calls are hoisted above this import, so ChatThread binds the mocks.
import { ChatThread } from '../ChatThread'

// ── context stubs (ChatThread reads everything from 6 contexts) ──
const navValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue = { resolveApprovalNotification: vi.fn() }
const chatListValue = { chatList: [], chatListLoading: false, sessionStateByChatId: {} }
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  handleDeleteChat: vi.fn(),
}
const mcpRuntimeValue = { cancelTask: vi.fn() }
let threadStateValue: {
  activeMessages: AgentChatMessage[]
  groupedMessages: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }>
  chatMessagesLoading: boolean
  activeChatId: string | null
  activityByMessageId: Record<string, unknown>
  progressByMessageId: Record<string, TaskProgress>
  hasOlderMessages: boolean
  olderMessagesLoading: boolean
  handleLoadOlderMessages: ReturnType<typeof vi.fn>
  localSearchQuery: string
  localSearchCurrentMatch: { messageId: string; occurrence: number } | null
}

vi.mock('@contexts/NavigationContext', () => ({ useNavigationContext: () => navValue }))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatListContext', () => ({ useChatListContext: () => chatListValue }))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({ useMcpRuntimeContext: () => mcpRuntimeValue }))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => threadStateValue,
}))

// ── neutralize heavy children that need their own contexts/IPC (keep ProgressStepper real) ──
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

const actEnvGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvGlobal.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const userMsg: AgentChatMessage = {
  id: 'turn-1-user',
  role: 'user',
  content: 'busca noticias',
  timestamp: 1,
}
const toolSteps: MessageToolStep[] = [
  {
    toolName: 'web-research__fetch_page',
    displayName: 'Web research',
    state: 'completed',
    durationMs: 40000,
  },
  { toolName: 'tavily__search', displayName: 'Tavily', state: 'completed', durationMs: 3000 },
]

function setThreadState(
  groupedMessages: typeof threadStateValue.groupedMessages,
  progressByMessageId: Record<string, TaskProgress> = {},
  options: { hasOlderMessages?: boolean; olderMessagesLoading?: boolean } = {}
) {
  const activeMessages = groupedMessages.flatMap(g => g.items)
  threadStateValue = {
    activeMessages,
    groupedMessages,
    chatMessagesLoading: false,
    activeChatId: 'c1',
    activityByMessageId: {},
    progressByMessageId,
    hasOlderMessages: options.hasOlderMessages ?? false,
    olderMessagesLoading: options.olderMessagesLoading ?? false,
    handleLoadOlderMessages: vi.fn().mockResolvedValue(undefined),
    localSearchQuery: '',
    localSearchCurrentMatch: null,
  }
}

describe('ChatThread local-search highlighting', () => {
  it('renders every plain and Markdown match and distinguishes the selected occurrence', () => {
    setThreadState([
      {
        role: 'user',
        items: [{ ...userMsg, content: 'Needle then needle' }],
      },
      {
        role: 'assistant',
        items: [
          {
            id: 'turn-1-assistant',
            role: 'assistant',
            content: 'A **needle** in a [needle link](https://example.com).',
            timestamp: 2,
          },
        ],
      },
    ])
    threadStateValue.localSearchQuery = 'needle'
    threadStateValue.localSearchCurrentMatch = {
      messageId: 'turn-1-assistant',
      occurrence: 1,
    }

    const { rerender } = render(<ChatThread />)

    expect(document.querySelectorAll('.chat-search-match')).toHaveLength(4)
    const active = screen.getByTestId('chat-search-current-match')
    expect(active.textContent).toBe('needle')
    expect(active.closest('a')?.getAttribute('href')).toBe('https://example.com')

    threadStateValue.localSearchCurrentMatch = { messageId: 'turn-1-user', occurrence: 1 }
    rerender(<ChatThread />)
    expect(screen.getByTestId('chat-search-current-match').textContent).toBe('needle')

    threadStateValue.localSearchQuery = 'missing'
    threadStateValue.localSearchCurrentMatch = null
    rerender(<ChatThread />)
    expect(document.querySelector('.chat-search-match')).toBeNull()
  })
})

describe('ChatThread tool-steps fallback (#582)', () => {
  it('renders assistant response-file attachments with a direct download action', () => {
    const assistant: AgentChatMessage = {
      id: 'turn-1-assistant',
      role: 'assistant',
      content: 'The model text may be wrong about attachments.',
      timestamp: 2,
      attachments: [
        {
          id: 'response-file:research-summary.pdf',
          type: 'response_file',
          label: 'research-summary.pdf',
          filename: 'research-summary.pdf',
          mimeType: 'application/pdf',
          encoding: 'base64',
          dataBase64: 'JVBERi0x',
          sizeBytes: 14600,
        },
      ],
    }
    setThreadState([
      { role: 'user', items: [userMsg] },
      { role: 'assistant', items: [assistant] },
    ])

    render(<ChatThread />)

    expect(screen.getByText('Generated file')).toBeTruthy()
    expect(screen.getByText('research-summary.pdf')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('renders the "N tools" stepper from the assistant message on reload (live progress absent)', () => {
    const assistant: AgentChatMessage = {
      id: 'turn-1-assistant',
      role: 'assistant',
      content: 'aquí están',
      timestamp: 2,
      toolSteps,
    }
    setThreadState([
      { role: 'user', items: [userMsg] },
      { role: 'assistant', items: [assistant] },
    ])

    render(<ChatThread />)

    expect(screen.getByText(/More details · 2 tools/i)).toBeTruthy()
    expect(screen.getAllByTestId('progress-stepper')).toHaveLength(1)
  })

  it('renders nothing extra when the assistant has no toolSteps and no live progress', () => {
    const assistant: AgentChatMessage = {
      id: 'turn-1-assistant',
      role: 'assistant',
      content: 'sin tools',
      timestamp: 2,
    }
    setThreadState([
      { role: 'user', items: [userMsg] },
      { role: 'assistant', items: [assistant] },
    ])

    render(<ChatThread />)

    expect(screen.queryByTestId('progress-stepper')).toBeNull()
  })

  it('ignores a malformed persisted toolSteps value instead of crashing the transcript', () => {
    const assistant: AgentChatMessage = {
      id: 'turn-1-assistant',
      role: 'assistant',
      content: 'still visible',
      timestamp: 2,
      toolSteps: 'PWNED' as never,
    }
    setThreadState([
      { role: 'user', items: [userMsg] },
      { role: 'assistant', items: [assistant] },
    ])

    expect(() => render(<ChatThread />)).not.toThrow()
    expect(screen.getByText('still visible')).toBeTruthy()
    expect(screen.queryByTestId('progress-stepper')).toBeNull()
  })

  it('prefers live progress and does NOT double-render when both live progress and toolSteps exist', () => {
    const assistant: AgentChatMessage = {
      id: 'turn-1-assistant',
      role: 'assistant',
      content: 'aquí están',
      timestamp: 2,
      toolSteps,
    }
    // Live completed progress keyed by the USER message (how the live path keys it).
    const liveProgress: TaskProgress = {
      taskId: 'task-1',
      status: 'completed',
      currentIteration: 0,
      steps: [
        {
          toolCallId: 'tc-live',
          toolName: 'web-research__fetch_page',
          displayName: 'Web research',
          intentSummary: '',
          iteration: 0,
          stepIndex: 0,
          totalSteps: 1,
          state: 'completed',
          durationMs: 40000,
        },
      ],
    }
    setThreadState(
      [
        { role: 'user', items: [userMsg] },
        { role: 'assistant', items: [assistant] },
      ],
      { 'turn-1-user': liveProgress }
    )

    render(<ChatThread />)

    // Exactly one stepper — the live one — not one live + one hydrated fallback.
    expect(screen.getAllByTestId('progress-stepper')).toHaveLength(1)
    // Live progress has 1 step → "1 tool"; the hydrated fallback (2 steps) must NOT render.
    expect(screen.getByText(/More details · 1 tool\b/i)).toBeTruthy()
    expect(screen.queryByText(/More details · 2 tools/i)).toBeNull()
  })

  it('renders and invokes the older-history page control', async () => {
    const user = userEvent.setup()
    setThreadState([{ role: 'user', items: [userMsg] }], {}, { hasOlderMessages: true })

    render(<ChatThread />)

    await user.click(screen.getByRole('button', { name: 'Load older messages' }))
    expect(threadStateValue.handleLoadOlderMessages).toHaveBeenCalledTimes(1)
  })

  it('reports when the reader is away from the bottom of the conversation', () => {
    const onScrollPositionChange = vi.fn()
    setThreadState([{ role: 'user', items: [userMsg] }])

    render(<ChatThread onScrollPositionChange={onScrollPositionChange} />)

    const chatThread = screen.getByTestId('message-list')
    Object.defineProperties(chatThread, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })

    fireEvent.scroll(chatThread)
    expect(onScrollPositionChange).toHaveBeenLastCalledWith(true)

    Object.defineProperty(chatThread, 'scrollTop', {
      configurable: true,
      value: 600,
      writable: true,
    })
    fireEvent.scroll(chatThread)

    expect(onScrollPositionChange).toHaveBeenLastCalledWith(false)
  })

  it('wraps long histories in virtualized message chunks', () => {
    const groups = Array.from({ length: 10 }, (_, index) => {
      const role = index % 2 === 0 ? ('user' as const) : ('assistant' as const)
      const turn = Math.floor(index / 2) + 1
      return {
        role,
        items: [
          {
            id: `turn-${turn}-${role}`,
            role,
            content: `${role} ${turn}`,
            timestamp: index,
            serverTurnNumber: turn,
          },
        ],
      }
    })
    setThreadState(groups)

    const { container } = render(<ChatThread />)

    expect(container.querySelectorAll('.virtualized-message-chunk').length).toBeGreaterThan(1)
  })

  it('preserves mounted chunks and message nodes across prepend and streaming updates', () => {
    const groups = Array.from({ length: 16 }, (_, index) => {
      const role = index % 2 === 0 ? ('user' as const) : ('assistant' as const)
      const turn = Math.floor(index / 2) + 5
      return {
        role,
        items: [
          {
            id: `turn-${turn}-${role}`,
            role,
            content: `${role} ${turn}`,
            timestamp: index,
            serverTurnNumber: turn,
          },
        ],
      }
    })
    setThreadState(groups)
    const { rerender } = render(<ChatThread />)
    const stableMessage = screen.getByText('user 5').closest('article')
    const stableChunk = stableMessage?.closest('.virtualized-message-chunk')

    const prepended = [
      {
        role: 'user' as const,
        items: [
          {
            id: 'turn-1-user',
            role: 'user' as const,
            content: 'user 1',
            timestamp: -1,
            serverTurnNumber: 1,
          },
        ],
      },
      ...groups.map(group => ({
        ...group,
        items: group.items.map(message =>
          message.id === 'turn-5-user' ? { ...message, content: 'user 5 streaming' } : message
        ),
      })),
    ]
    setThreadState(prepended)
    rerender(<ChatThread />)

    const updatedMessage = screen.getByText('user 5 streaming').closest('article')
    expect(updatedMessage).toBe(stableMessage)
    expect(updatedMessage?.closest('.virtualized-message-chunk')).toBe(stableChunk)
    expect(screen.getByText('user 1')).toBeTruthy()
  })
})
