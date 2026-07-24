// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useActivityController } from '../useActivityController'

const AGENT_A = ['agent-a']
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
})
