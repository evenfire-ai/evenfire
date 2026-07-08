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
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => undefined }))

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
  progressByMessageId: Record<string, TaskProgress> = {}
) {
  const activeMessages = groupedMessages.flatMap(g => g.items)
  threadStateValue = {
    activeMessages,
    groupedMessages,
    chatMessagesLoading: false,
    activeChatId: 'c1',
    activityByMessageId: {},
    progressByMessageId,
  }
}

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
})
