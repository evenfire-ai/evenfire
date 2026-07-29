// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useActivityController } from '../useActivityController'

const AGENT_A = ['agent-a']
const TWO_AGENTS = ['agent-a', 'agent-b']
const EMPTY_CHAT_LIST: [] = []
const EMPTY_PROGRESS = {}

function installChatIndexMock() {
  const getIndex = vi.fn(async (agentRef: string) => ({
    version: 2,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: [
      {
        id: `${agentRef}-chat`,
        title: 'Chat',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        messageCount: 3,
      },
    ],
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      chat: { getIndex },
    },
  })
  return getIndex
}

describe('useActivityController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('computes activity from index metadata without reading conversation histories', () => {
    installChatIndexMock()
    const { result } = renderHook(() =>
      useActivityController({
        selectedAgent: 'agent-a',
        isAuthenticated: true,
        loadMenuData: false,
        chatList: [
          {
            id: 'chat-1',
            title: 'One',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            messageCount: 12,
            errorCount: 2,
            toolCallCount: 4,
          },
        ],
        progressByAgentMessage: EMPTY_PROGRESS,
        agentNames: AGENT_A,
      })
    )

    expect(result.current.selectedAgentActivitySummary).toMatchObject({
      conversations: 1,
      messages: 12,
      errors: 2,
      toolCalls: 4,
    })
  })

  it('waits until after first paint before loading agent menu metadata', async () => {
    const getIndex = installChatIndexMock()
    const initialProps = { loadMenuData: false }
    const { rerender } = renderHook(
      ({ loadMenuData }: typeof initialProps) =>
        useActivityController({
          selectedAgent: null,
          isAuthenticated: true,
          loadMenuData,
          chatList: EMPTY_CHAT_LIST,
          progressByAgentMessage: EMPTY_PROGRESS,
          agentNames: TWO_AGENTS,
        }),
      { initialProps }
    )

    expect(getIndex).not.toHaveBeenCalled()
    rerender({ loadMenuData: true })

    await waitFor(() => expect(getIndex).toHaveBeenCalledTimes(2))
  })

  it('backfills missing activity counters for chats created before metadata counters existed', async () => {
    const getIndex = vi.fn(async () => ({
      version: 3,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    }))
    const loadMessages = vi.fn(async () => [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: 'failed',
        timestamp: 2,
        isError: true,
        toolSteps: [{ toolName: 'read', displayName: 'Read', state: 'completed' }],
      },
    ])
    const backfillCounters = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { chat: { getIndex, loadMessages, backfillCounters } },
    })

    const { result } = renderHook(() =>
      useActivityController({
        selectedAgent: 'agent-a',
        isAuthenticated: true,
        loadMenuData: true,
        chatList: [
          {
            id: 'legacy-chat',
            title: 'Legacy',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            messageCount: 2,
          },
        ],
        progressByAgentMessage: EMPTY_PROGRESS,
        agentNames: AGENT_A,
      })
    )

    await waitFor(() =>
      expect(result.current.selectedAgentActivitySummary).toMatchObject({
        errors: 1,
        toolCalls: 1,
      })
    )
    expect(loadMessages).toHaveBeenCalledWith('agent-a', 'legacy-chat', 1000, undefined)
    expect(backfillCounters).toHaveBeenCalledWith(
      'agent-a',
      'legacy-chat',
      expect.arrayContaining([expect.objectContaining({ id: 'm1' })])
    )
  })

  it('does not download transcripts for server-only catalog entries', async () => {
    const getIndex = vi.fn(async () => ({
      version: 3,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    }))
    const loadMessages = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { chat: { getIndex, loadMessages } },
    })

    renderHook(() =>
      useActivityController({
        selectedAgent: 'agent-a',
        isAuthenticated: true,
        loadMenuData: true,
        chatList: [
          {
            id: 'remote-chat',
            title: 'Remote',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            messageCount: 2,
            remote: true,
          },
        ],
        progressByAgentMessage: EMPTY_PROGRESS,
        agentNames: AGENT_A,
      })
    )

    await waitFor(() => expect(getIndex).toHaveBeenCalled())
    expect(loadMessages).not.toHaveBeenCalled()
  })

  it('keeps prior backfills when a later chat list adds another legacy chat', async () => {
    const loadMessages = vi.fn(async (_agentRef: string, chatId: string) =>
      chatId === 'legacy-one'
        ? [{ id: 'e1', role: 'assistant', content: 'failed', timestamp: 1, isError: true }]
        : [
            {
              id: 't1',
              role: 'assistant',
              content: 'used tool',
              timestamp: 2,
              toolSteps: [{ toolName: 'read', displayName: 'Read', state: 'completed' }],
            },
          ]
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        chat: {
          getIndex: vi.fn(async () => ({ chats: [] })),
          loadMessages,
          backfillCounters: vi.fn().mockResolvedValue(undefined),
        },
      },
    })
    const baseChat = {
      title: 'Legacy',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      messageCount: 1,
    }
    const initialProps = {
      chatList: [{ ...baseChat, id: 'legacy-one' }],
    }
    const { result, rerender } = renderHook(
      ({ chatList }: typeof initialProps) =>
        useActivityController({
          selectedAgent: 'agent-a',
          isAuthenticated: true,
          loadMenuData: true,
          chatList,
          progressByAgentMessage: EMPTY_PROGRESS,
          agentNames: AGENT_A,
        }),
      { initialProps }
    )

    await waitFor(() => expect(result.current.selectedAgentActivitySummary.errors).toBe(1))

    rerender({
      chatList: [
        { ...baseChat, id: 'legacy-one' },
        { ...baseChat, id: 'legacy-two', updatedAt: '2026-07-23T00:00:00.000Z' },
      ],
    })

    await waitFor(() =>
      expect(result.current.selectedAgentActivitySummary).toMatchObject({
        errors: 1,
        toolCalls: 1,
      })
    )
  })
})
