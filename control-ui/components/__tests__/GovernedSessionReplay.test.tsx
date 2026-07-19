import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  getGovernedApprovalPromptHistory,
  getGovernedTraceSessionDetail,
  getGovernedTraceSessions,
} from '@lib/governedTrace'
import { SessionReplay } from '../GovernedTraceSurface/SessionReplay'
import { SessionReplayDetail } from '../GovernedTraceSurface/SessionReplayDetail'

const navigation = vi.hoisted(() => ({
  pathname: '/traces',
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}))
vi.mock('@lib/api', () => ({
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock('recharts', () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))
vi.mock('@lib/governedTrace', () => ({
  getGovernedApprovalPromptHistory: vi.fn(),
  getGovernedTraceSessionDetail: vi.fn(),
  getGovernedTraceSessions: vi.fn(),
}))

const mockGetSessions = vi.mocked(getGovernedTraceSessions)
const mockGetSessionDetail = vi.mocked(getGovernedTraceSessionDetail)
const mockGetPromptHistory = vi.mocked(getGovernedApprovalPromptHistory)

const SESSION = {
  hostRef: 'chatllm',
  sessionId: 'session-42',
  origins: ['direct_chat'] as const,
  firstOccurredAt: '2026-07-14T10:00:00.000Z',
  lastOccurredAt: '2026-07-14T10:05:00.000Z',
  runCount: 2,
  eventCount: 7,
  latestRunOutcome: 'succeeded' as const,
  agent: {
    status: 'verified' as const,
    subject: 'mcp-host:chatllm',
    displayName: 'Chat agent',
  },
  human: {
    status: 'verified' as const,
    subject: 'human-sub-1',
    userId: 'user-1',
    displayName: 'Alice Operator',
    identityIssuer: 'https://issuer.example',
  },
  tools: {
    totalCalls: 3,
    distinctTools: 2,
    byKind: { internal_tool: 1, mcp_server_tool: 2, workflow: 0, unclassified: 0 },
  },
  tokenUsage: {
    observedLlmCalls: 2,
    meteredCalls: 2,
    coverage: 'complete' as const,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    cacheReporting: 'complete' as const,
    totalTokens: 150,
  },
  approvals: {
    requested: 1,
    approved: 1,
    denied: 0,
    promptHistory: 'available' as const,
  },
}

const SESSION_DETAIL = {
  summary: SESSION,
  runs: [
    {
      runId: 'run-1',
      startedAt: '2026-07-14T10:00:00.000Z',
      endedAt: '2026-07-14T10:05:00.000Z',
      outcome: 'succeeded',
      origin: 'direct_chat' as const,
      eventCount: 7,
    },
  ],
  tools: [
    {
      toolName: 'search',
      toolKind: 'mcp_server_tool' as const,
      toolSourceRef: 'search-server',
      totalCalls: 1,
      succeeded: 1,
      failed: 0,
      firstOccurredAt: '2026-07-14T10:01:00.000Z',
      lastOccurredAt: '2026-07-14T10:01:00.000Z',
    },
  ],
  approvals: [
    {
      approvalRequestId: 'approval-1',
      runId: 'run-1',
      source: 'tool' as const,
      toolName: 'search',
      toolKind: 'mcp_server_tool' as const,
      toolSourceRef: 'search-server',
      requestedAt: '2026-07-14T10:00:30.000Z',
      decidedAt: '2026-07-14T10:00:45.000Z',
      state: 'approved' as const,
      decisionActorSub: 'human-sub-1',
      observedExecution: 'succeeded' as const,
      promptHistory: 'available' as const,
    },
  ],
  interactions: [
    {
      streamSequence: '10',
      eventId: 'event-10',
      runId: 'run-1',
      eventType: 'approval',
      occurredAt: '2026-07-14T10:00:45.000Z',
      outcome: 'approved',
      toolName: 'search',
      toolKind: 'mcp_server_tool' as const,
      toolSourceRef: 'search-server',
      approvalRequestId: 'approval-1',
      decision: 'allow',
      decisionActorSub: 'human-sub-1',
      safeFields: { provider: 'fake_telegram' },
    },
  ],
  tokenUsage: {
    ...SESSION.tokenUsage,
    points: [
      {
        streamSequence: '8',
        eventId: 'usage-1',
        runId: 'run-1',
        occurredAt: '2026-07-14T10:01:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        sourceKind: 'desktop',
        iteration: 1,
        inputTokens: 70,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        cacheTokensReported: true,
      },
      {
        streamSequence: '9',
        eventId: 'usage-2',
        runId: 'run-1',
        occurredAt: '2026-07-14T10:02:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        sourceKind: 'desktop',
        iteration: 2,
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        cacheTokensReported: true,
      },
    ],
    pointsTruncated: false,
  },
  nextCursor: null,
  capturedHighWatermark: '10',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigation.pathname = '/traces'
  navigation.searchParams = new URLSearchParams()
})

describe('SessionReplay', () => {
  it('renders one governed row per host/session with human and agent attribution', async () => {
    mockGetSessions.mockResolvedValue({
      sessions: [SESSION],
      nextCursor: null,
      capturedHighWatermark: '10',
    })

    render(<SessionReplay />)

    await waitFor(() => expect(screen.getByText('session-42')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'session-42' })).toHaveAttribute(
      'href',
      '/traces/sessions/chatllm/session-42'
    )
    expect(screen.getByRole('link', { name: 'Alice Operator' })).toHaveAttribute(
      'href',
      '/users-and-teams/users/user-1'
    )
    expect(screen.getByText('Chat agent')).toBeInTheDocument()
    expect(screen.getByText('2 runs · 7 events')).toBeInTheDocument()
    expect(screen.getAllByText('150')).toHaveLength(2)
    expect(screen.getByText('2 calls · complete')).toBeInTheDocument()
    expect(screen.queryByText('tool_call')).not.toBeInTheDocument()
    expect(screen.queryByText('sensitive prompt sentinel')).not.toBeInTheDocument()
  })

  it('sends restored URL filters to the server instead of filtering loaded rows', async () => {
    navigation.searchParams = new URLSearchParams({
      window: '7d',
      hostRef: 'chatllm',
      approvalState: 'denied,approved',
      targetUserId: 'ignored-for-session-list',
    })
    mockGetSessions.mockResolvedValue({
      sessions: [],
      nextCursor: null,
      capturedHighWatermark: '0',
    })

    render(<SessionReplay />)

    await waitFor(() => expect(mockGetSessions).toHaveBeenCalledOnce())
    expect(mockGetSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalState: 'approved,denied',
        hostRef: 'chatllm',
        occurredFrom: expect.any(String),
        occurredTo: expect.any(String),
      }),
      expect.any(AbortSignal)
    )
    expect(mockGetSessions.mock.calls[0]?.[0]).not.toHaveProperty('targetUserId')
    expect(
      screen.getByText('No sessions match the active server-side filters.')
    ).toBeInTheDocument()
  })

  it('keeps restored user IDs removable even before the authenticated lookup resolves them', async () => {
    navigation.searchParams = new URLSearchParams({ humanUserId: 'user-from-shared-url' })
    mockGetSessions.mockResolvedValue({
      sessions: [],
      nextCursor: null,
      capturedHighWatermark: '0',
    })

    render(<SessionReplay />)
    await waitFor(() => expect(mockGetSessions).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Filter Human' }))

    expect(screen.getByRole('option', { name: 'user-from-shared-url' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('labels historical list gaps without a generic unavailable status', async () => {
    mockGetSessions.mockResolvedValue({
      sessions: [
        {
          ...SESSION,
          human: {
            status: 'unavailable',
            subject: null,
            userId: null,
            displayName: null,
            identityIssuer: null,
          },
          tokenUsage: {
            ...SESSION.tokenUsage,
            coverage: 'unavailable',
            meteredCalls: 0,
          },
        },
      ],
      nextCursor: null,
      capturedHighWatermark: '10',
    })

    render(<SessionReplay />)

    await waitFor(() => expect(screen.getByText('Attribution not recorded')).toBeInTheDocument())
    expect(screen.getByText('not recorded')).toBeInTheDocument()
    expect(screen.getByText('0 calls · no central usage events')).toBeInTheDocument()
    expect(screen.queryByText('unavailable')).not.toBeInTheDocument()
  })
})

describe('SessionReplayDetail protected prompt evidence', () => {
  it('keeps same-named tools from distinct kinds and sources as separate rows', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetSessionDetail.mockResolvedValue({
      ...SESSION_DETAIL,
      tools: [
        {
          ...SESSION_DETAIL.tools[0],
          toolKind: 'internal_tool',
          toolSourceRef: 'mcp-host:internal',
        },
        {
          ...SESSION_DETAIL.tools[0],
          toolKind: 'mcp_server_tool',
          toolSourceRef: 'weather-server',
          firstOccurredAt: '2026-07-14T10:02:00.000Z',
          lastOccurredAt: '2026-07-14T10:02:00.000Z',
        },
      ],
    })

    try {
      render(<SessionReplayDetail hostRef="chatllm" sessionId="session-42" />)

      expect(await screen.findByText('mcp-host:internal')).toBeInTheDocument()
      expect(screen.getByText('weather-server')).toBeInTheDocument()
      const toolSection = screen.getByRole('heading', { name: 'Tool usage' }).closest('section')
      expect(toolSection).not.toBeNull()
      expect(within(toolSection!).getAllByText('search')).toHaveLength(2)
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
        'Encountered two children with the same key'
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not request or render retained prompt text until the admin explicitly reveals it', async () => {
    mockGetSessionDetail.mockResolvedValue(SESSION_DETAIL)
    mockGetPromptHistory.mockResolvedValue({
      approvalRequestId: 'approval-1',
      availability: 'available',
      prompt: {
        text: 'Protected retained approval prompt',
        capturedAt: '2026-07-14T10:00:30.000Z',
        expiresAt: '2026-08-13T10:00:30.000Z',
        keyVersion: 'v1',
        redactionSummary: { redacted: true, replacementCount: 1 },
      },
    })

    render(<SessionReplayDetail hostRef="chatllm" sessionId="session-42" />)

    await waitFor(() => expect(screen.getByText('Approval timeline')).toBeInTheDocument())
    expect(screen.getByText('Token usage')).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: 'Cumulative input and output token usage across 2 metered calls, ending at 150 tokens',
      })
    ).toBeInTheDocument()
    expect(screen.getAllByText('mcp server tool').length).toBeGreaterThan(0)
    expect(screen.getAllByText('search-server').length).toBeGreaterThan(0)
    expect(screen.getByText('Alice Operator')).toBeInTheDocument()
    expect(
      screen.getAllByRole('link', { name: 'Alice Operator · human-sub-1' }).length
    ).toBeGreaterThan(0)
    expect(screen.getByText('Reported by provider')).toBeInTheDocument()
    expect(screen.getAllByText('approval-1').length).toBeGreaterThan(0)
    expect(screen.getByText('Decision: allow')).toBeInTheDocument()
    expect(mockGetPromptHistory).not.toHaveBeenCalled()
    expect(screen.queryByText('Protected retained approval prompt')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reveal retained prompt' }))

    await waitFor(() => expect(mockGetPromptHistory).toHaveBeenCalledWith('approval-1'))
    expect(await screen.findByText('Protected retained approval prompt')).toBeInTheDocument()
    expect(
      screen.getByText('Key version v1 · redaction applied · 1 replacements')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide retained prompt' }))
    expect(screen.queryByText('Protected retained approval prompt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal retained prompt' })).toBeInTheDocument()
  })

  it('explains unavailable historical attribution and provider cache reporting', async () => {
    mockGetSessionDetail.mockResolvedValue({
      ...SESSION_DETAIL,
      summary: {
        ...SESSION,
        human: {
          status: 'unavailable',
          subject: null,
          userId: null,
          displayName: null,
          identityIssuer: null,
        },
      },
      tokenUsage: {
        ...SESSION_DETAIL.tokenUsage,
        cacheReporting: 'unavailable',
      },
    })

    render(<SessionReplayDetail hostRef="chatllm" sessionId="legacy-session" />)

    await waitFor(() => expect(screen.getByText('Status: not recorded')).toBeInTheDocument())
    expect(
      screen.getByText('No authoritative run binding was persisted for this session.')
    ).toBeInTheDocument()
    expect(screen.getByText('Not reported by provider')).toBeInTheDocument()
  })
})
