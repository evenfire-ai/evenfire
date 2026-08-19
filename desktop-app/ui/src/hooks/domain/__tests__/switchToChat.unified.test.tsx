// @vitest-environment jsdom
/**
 * D.4 goldens — the unified `switchToChat` (cache-first → server reconcile →
 * tracker rejoin). Plan: D4-switch-to-chat-unified.md §5.1.
 *
 * `tracker.rejoinIfRunning` is observed indirectly: a rejoin opens the SSE via
 * `window.clerum.rpc.subscribeTaskProgress(agentRef, taskId, …)`, so a
 * registered progress handler for the task is the observable proof of rejoin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

const turn = (n: number, user: string, response?: string) => ({
  number: n,
  user_input: user,
  response,
  started_at: `2026-05-28T10:0${n}:00Z`,
  completed_at: response ? `2026-05-28T10:0${n}:05Z` : undefined,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('switchToChat (unified, D.4)', () => {
  it('Phase 1 renders the cache, Phase 2 reconciles, and preserves the cache when there is no diff', async () => {
    const cached = [
      { id: 'turn-1-user', role: 'user' as const, content: 'q', timestamp: 1 },
      { id: 'turn-1-assistant', role: 'assistant' as const, content: 'a', timestamp: 2 },
    ]
    clerum.chat.loadMessages.mockResolvedValue(cached)
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c1',
      state: 'idle',
      turns: [turn(1, 'q', 'a')], // same length as cache → no overwrite
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c1')
    })

    expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'c1', 80, undefined)
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c1',
      undefined,
      { limit: 40, afterTurn: 1 }
    )
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
    expect(result.current.chatMessages).toHaveLength(2)
  })

  it('persists authoritative content changes when stable message IDs are unchanged', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'old question',
        timestamp: Date.parse('2026-05-28T10:01:00Z'),
        serverTurnNumber: 1,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant',
        content: 'old answer',
        timestamp: Date.parse('2026-05-28T10:01:05Z'),
        serverTurnNumber: 1,
      },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'content-update',
      state: 'idle',
      turns: [turn(1, 'new question', 'new answer')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'content-update')
    })

    expect(result.current.chatMessages.map(message => message.content)).toEqual([
      'new question',
      'new answer',
    ])
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'content-update',
      expect.arrayContaining([
        expect.objectContaining({ id: 'turn-1-assistant', content: 'new answer' }),
      ])
    )
  })

  it('drops an old A response after A-B-A and uses the fresh same-chat reconcile', async () => {
    const sessionResult = (chatId: string, answer?: string) => ({
      agent: 'agent-x',
      chatId,
      state: 'idle' as const,
      turns: chatId === 'chat-a' ? [turn(1, 'question', answer)] : [],
    })
    let resolveOldA!: (value: ReturnType<typeof sessionResult>) => void
    const oldA = new Promise<ReturnType<typeof sessionResult>>(resolve => {
      resolveOldA = resolve
    })
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages
      .mockImplementationOnce(() => oldA)
      .mockResolvedValueOnce(sessionResult('chat-b'))
      .mockResolvedValueOnce(sessionResult('chat-a', 'fresh answer'))
    const { result } = renderController()
    await settleMount()

    let firstSwitch!: Promise<void>
    await act(async () => {
      firstSwitch = result.current.switchToChat('agent-x', 'chat-a')
      await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledTimes(1))
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
      await result.current.switchToChat('agent-x', 'chat-a')
    })
    resolveOldA(sessionResult('chat-a', 'stale answer'))
    await act(async () => {
      await firstSwitch
    })

    expect(result.current.activeChatId).toBe('chat-a')
    expect(result.current.chatMessages.map(message => message.content)).toContain('fresh answer')
    expect(result.current.chatMessages.map(message => message.content)).not.toContain(
      'stale answer'
    )
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledTimes(3)
  })

  it('drops a superseded A reconcile parked inside hydration after A-B-A', async () => {
    type Messages = Awaited<ReturnType<typeof clerum.chat.loadMessages>>
    type SessionResult = Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>
    const staleFetch = deferred<SessionResult>()
    const staleHydration = deferred<Messages>()
    clerum.chat.loadMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => staleHydration.promise)
      .mockResolvedValue([])
    let agentAFetches = 0
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, _agentRef: string, chatId: string) => {
        if (chatId === 'chat-b') {
          return {
            agent: 'agent-x',
            chatId: 'chat-b',
            state: 'idle' as const,
            turns: [],
          }
        }
        agentAFetches += 1
        return agentAFetches === 1
          ? staleFetch.promise
          : {
              agent: 'agent-x',
              chatId: 'chat-a',
              state: 'idle' as const,
              turns: [turn(1, 'question', 'fresh answer')],
            }
      }
    )
    const { result } = renderController()
    await settleMount()
    let staleSwitch!: Promise<void>
    await act(async () => {
      staleSwitch = result.current.switchToChat('agent-x', 'chat-a')
      await waitFor(() => expect(agentAFetches).toBe(1))
    })
    await act(async () => {
      staleFetch.resolve({
        agent: 'agent-x',
        chatId: 'chat-a',
        state: 'idle',
        turns: [turn(1, 'question', 'stale answer')],
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(clerum.chat.loadMessages).toHaveBeenCalledTimes(3))

    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
      await result.current.switchToChat('agent-x', 'chat-a')
    })
    await waitFor(() =>
      expect(result.current.chatMessages.map(message => message.content)).toContain('fresh answer')
    )
    const persistedBeforeStaleHydration = clerum.chat.replaceMessages.mock.calls.length

    await act(async () => {
      staleHydration.resolve([])
      await staleSwitch
    })

    expect(result.current.chatMessages.map(message => message.content)).toContain('fresh answer')
    expect(result.current.chatMessages.map(message => message.content)).not.toContain(
      'stale answer'
    )
    expect(clerum.chat.replaceMessages).toHaveBeenCalledTimes(persistedBeforeStaleHydration)
    expect(
      clerum.chat.replaceMessages.mock.calls.some(call =>
        call[2].some((message: { content?: string }) => message.content === 'stale answer')
      )
    ).toBe(false)
  })

  it('does not overwrite a long chat whose cache already matches the server (no 50-cap false-stale)', async () => {
    // 30 turns → 60 messages, well past any windowing limit.
    const turns = Array.from({ length: 30 }, (_, i) => turn(i + 1, `q${i + 1}`, `a${i + 1}`))
    const cached = turns.flatMap(t => [
      { id: `turn-${t.number}-user`, role: 'user' as const, content: t.user_input, timestamp: 1 },
      {
        id: `turn-${t.number}-assistant`,
        role: 'assistant' as const,
        content: t.response!,
        timestamp: 2,
      },
    ])
    clerum.chat.loadMessages.mockResolvedValue(cached)
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'long',
      state: 'idle',
      turns,
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'long')
    })

    // Cache (60) === server (60) → reconcile is a no-op, no rewrite.
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
    expect(result.current.chatMessages).toHaveLength(60)
  })

  it('replaces a settled legacy turnless cache instead of persisting duplicate server history', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'legacy-q1', role: 'user', content: 'q1', timestamp: 1 },
      { id: 'legacy-a1', role: 'assistant', content: 'a1', timestamp: 2 },
      { id: 'legacy-q2', role: 'user', content: 'q2', timestamp: 3 },
      { id: 'legacy-a2', role: 'assistant', content: 'a2', timestamp: 4 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'legacy-cache',
      state: 'idle',
      totalTurns: 3,
      turns: [turn(1, 'q1', 'a1'), turn(2, 'q2', 'a2'), turn(3, 'q3', 'a3')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'legacy-cache')
    })

    expect(result.current.chatMessages.map(message => message.id)).toEqual([
      'turn-1-user',
      'turn-1-assistant',
      'turn-2-user',
      'turn-2-assistant',
      'turn-3-user',
      'turn-3-assistant',
    ])
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'legacy-cache',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-3-assistant' })])
    )
    expect(clerum.chat.replaceMessages.mock.calls.at(-1)?.[2]).toHaveLength(6)
  })

  it('Phase 2 persists the merged server delta to a durable-ID cache', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c2',
      state: 'idle',
      turns: [turn(1, 'q1', 'a1'), turn(2, 'q2', 'a2')], // 4 messages > 1 cached
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c2')
    })

    expect(result.current.chatMessages).toHaveLength(4)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'c2',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-2-assistant' })])
    )
  })

  it('follows server delta pages until the active chat reaches the latest turn', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
      { id: 'turn-1-assistant', role: 'assistant' as const, content: 'a1', timestamp: 2 },
    ])
    clerum.rpc.loadSessionMessages
      .mockResolvedValueOnce({
        agent: 'agent-x',
        chatId: 'delta-pages',
        state: 'idle',
        totalTurns: 3,
        latestTurnNumber: 2,
        hasMoreAfter: true,
        turns: [turn(2, 'q2', 'a2')],
      })
      .mockResolvedValueOnce({
        agent: 'agent-x',
        chatId: 'delta-pages',
        state: 'idle',
        totalTurns: 3,
        latestTurnNumber: 3,
        hasMoreAfter: false,
        turns: [turn(3, 'q3', 'a3')],
      })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'delta-pages')
    })

    expect(clerum.rpc.loadSessionMessages).toHaveBeenNthCalledWith(
      1,
      'agent-x',
      'agent-x',
      'delta-pages',
      undefined,
      { limit: 40, afterTurn: 1 }
    )
    expect(clerum.rpc.loadSessionMessages).toHaveBeenNthCalledWith(
      2,
      'agent-x',
      'agent-x',
      'delta-pages',
      undefined,
      { limit: 40, afterTurn: 2 }
    )
    expect(result.current.chatMessages).toHaveLength(6)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'delta-pages',
      expect.arrayContaining([
        expect.objectContaining({ id: 'turn-2-assistant' }),
        expect.objectContaining({ id: 'turn-3-assistant' }),
      ])
    )
  })

  it('keeps durable local bubbles in place and deduplicates trimmed server echoes', async () => {
    const turnTwoStartedAt = Date.parse('2026-05-28T10:02:00Z')
    clerum.chat.loadMessages.mockResolvedValue([
      {
        id: 'turn-1-user',
        role: 'user' as const,
        content: 'q1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant' as const,
        content: 'a1',
        timestamp: 2,
        serverTurnNumber: 1,
      },
      {
        id: 'durable-error',
        role: 'assistant' as const,
        content: 'Recovered warning',
        timestamp: 3,
        isError: true,
      },
      {
        id: 'local-turn-2-user',
        role: 'user' as const,
        content: 'q2',
        timestamp: turnTwoStartedAt,
      },
      {
        id: 'local-turn-2-assistant',
        role: 'assistant' as const,
        content: 'a2 ',
        timestamp: turnTwoStartedAt + 5_000,
      },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'stable-local-order',
      state: 'idle',
      totalTurns: 2,
      hasMoreBefore: false,
      hasMoreAfter: false,
      turns: [turn(2, 'q2', 'a2')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'stable-local-order')
    })

    expect(result.current.chatMessages.map(message => message.id)).toEqual([
      'turn-1-user',
      'turn-1-assistant',
      'durable-error',
      'turn-2-user',
      'turn-2-assistant',
    ])
  })

  it('caps server delta pagination so reconcile cannot walk an unbounded cursor chain', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
      { id: 'turn-1-assistant', role: 'assistant' as const, content: 'a1', timestamp: 2 },
    ])
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef, _agent, chatId, _teamId, query?: { afterTurn?: number }) => {
        if (query?.afterTurn === undefined) {
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            latestTurnNumber: 999,
            hasMoreBefore: true,
            hasMoreAfter: false,
            turns: [turn(999, 'newest question', 'newest answer')],
          }
        }
        const nextTurn = (query?.afterTurn ?? 1) + 1
        return {
          agent: 'agent-x',
          chatId,
          state: 'idle',
          latestTurnNumber: nextTurn,
          hasMoreAfter: true,
          turns: [turn(nextTurn, `q${nextTurn}`, `a${nextTurn}`)],
        }
      }
    )
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'delta-cap')
    })

    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledTimes(6)
    expect(clerum.rpc.loadSessionMessages).toHaveBeenLastCalledWith(
      'agent-x',
      'agent-x',
      'delta-cap',
      undefined,
      { limit: 40 }
    )
    expect(result.current.chatMessages.map(message => message.id)).toEqual([
      'turn-1-user',
      'turn-1-assistant',
      'turn-2-user',
      'turn-2-assistant',
      'turn-3-user',
      'turn-3-assistant',
      'turn-4-user',
      'turn-4-assistant',
      'turn-5-user',
      'turn-5-assistant',
      'turn-6-user',
      'turn-6-assistant',
      'turn-999-user',
      'turn-999-assistant',
    ])
    expect(result.current.hasOlderMessages).toBe(true)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'delta-cap',
      expect.arrayContaining([
        expect.objectContaining({ id: 'turn-2-user' }),
        expect.objectContaining({ id: 'turn-999-assistant' }),
      ])
    )
  })

  it('loads older history into the first server-turn gap after a delta-cap fallback', async () => {
    const serverTurn = (n: number) => ({
      number: n,
      user_input: `q${n}`,
      response: `a${n}`,
      started_at: '2026-05-28T10:00:00Z',
      completed_at: '2026-05-28T10:00:05Z',
    })
    const localTail = [
      {
        id: 'turn-1-user',
        role: 'user' as const,
        content: 'q1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant' as const,
        content: 'a1',
        timestamp: 2,
        serverTurnNumber: 1,
      },
    ]
    const latestWindow = Array.from({ length: 40 }, (_, index) => serverTurn(960 + index))
    const gapPage = Array.from({ length: 40 }, (_, index) => serverTurn(920 + index))
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, _chatId: string, _limit?: number, offset?: number) =>
        offset ? [] : localTail
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (
        _hostRef: string,
        _agent: string,
        chatId: string,
        _teamId?: string,
        query?: { afterTurn?: number; beforeTurn?: number; limit?: number }
      ) => {
        if (query?.beforeTurn === 960) {
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            totalTurns: 999,
            oldestTurnNumber: 920,
            latestTurnNumber: 959,
            hasMoreBefore: true,
            hasMoreAfter: true,
            turns: gapPage,
          }
        }
        if (query?.afterTurn !== undefined) {
          const nextTurn = query.afterTurn + 1
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            latestTurnNumber: nextTurn,
            hasMoreAfter: true,
            turns: [serverTurn(nextTurn)],
          }
        }
        return {
          agent: 'agent-x',
          chatId,
          state: 'idle',
          totalTurns: 999,
          oldestTurnNumber: 960,
          latestTurnNumber: 999,
          hasMoreBefore: true,
          hasMoreAfter: false,
          turns: latestWindow,
        }
      }
    )
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'delta-gap')
    })

    expect(result.current.hasOlderMessages).toBe(true)
    expect(result.current.chatMessages.map(message => message.serverTurnNumber)).toContain(960)

    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })

    expect(clerum.rpc.loadSessionMessages).toHaveBeenLastCalledWith(
      'agent-x',
      'agent-x',
      'delta-gap',
      undefined,
      { limit: 40, beforeTurn: 960 }
    )
    expect(result.current.chatMessages.map(message => message.id)).toContain('turn-920-user')
    expect(result.current.hasOlderMessages).toBe(true)
  })

  it('skips an unfillable server-turn gap after a no-progress older-page response', async () => {
    const serverTurn = (n: number) => ({
      number: n,
      user_input: `q${n}`,
      response: `a${n}`,
      started_at: '2026-05-28T10:00:00Z',
      completed_at: '2026-05-28T10:00:05Z',
    })
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (
        _hostRef: string,
        _agent: string,
        chatId: string,
        _teamId?: string,
        query?: { beforeTurn?: number; limit?: number }
      ) => {
        if (query?.beforeTurn === 61) {
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            totalTurns: 99,
            oldestTurnNumber: 58,
            latestTurnNumber: 60,
            hasMoreBefore: true,
            hasMoreAfter: true,
            turns: [58, 59, 60].map(serverTurn),
          }
        }
        if (query?.beforeTurn === 58) {
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            totalTurns: 99,
            oldestTurnNumber: 17,
            latestTurnNumber: 56,
            hasMoreBefore: true,
            hasMoreAfter: true,
            turns: Array.from({ length: 40 }, (_, index) => serverTurn(17 + index)),
          }
        }
        if (query?.beforeTurn === 17) {
          return {
            agent: 'agent-x',
            chatId,
            state: 'idle',
            totalTurns: 99,
            oldestTurnNumber: 1,
            latestTurnNumber: 16,
            hasMoreBefore: false,
            hasMoreAfter: true,
            turns: Array.from({ length: 16 }, (_, index) => serverTurn(1 + index)),
          }
        }
        return {
          agent: 'agent-x',
          chatId,
          state: 'idle',
          totalTurns: 99,
          oldestTurnNumber: 61,
          latestTurnNumber: 100,
          hasMoreBefore: true,
          hasMoreAfter: false,
          turns: Array.from({ length: 40 }, (_, index) => serverTurn(61 + index)),
        }
      }
    )
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'missing-turn-gap')
    })
    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })
    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })
    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })
    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })

    const beforeTurns = clerum.rpc.loadSessionMessages.mock.calls
      .map(call => (call[4] as { beforeTurn?: number } | undefined)?.beforeTurn)
      .filter((turn): turn is number => turn !== undefined)
    expect(beforeTurns).toEqual([61, 58, 58, 17])
    expect(result.current.chatMessages.map(message => message.id)).toContain('turn-1-user')
    expect(result.current.hasOlderMessages).toBe(false)
  })

  it('loads older history on demand and prepends it without blocking first render', async () => {
    const newestLocalPage = Array.from({ length: 80 }, (_, index) => ({
      id: `turn-${index + 21}-user`,
      role: 'user' as const,
      content: `q${index + 21}`,
      timestamp: index + 21,
    }))
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, _chatId: string, _limit?: number, offset?: number) =>
        offset ? [] : newestLocalPage
    )
    clerum.rpc.loadSessionMessages
      .mockResolvedValueOnce({
        agent: 'agent-x',
        chatId: 'older-pages',
        state: 'idle',
        totalTurns: 100,
        hasMoreBefore: true,
        hasMoreAfter: false,
        turns: [],
      })
      .mockResolvedValueOnce({
        agent: 'agent-x',
        chatId: 'older-pages',
        state: 'idle',
        totalTurns: 100,
        oldestTurnNumber: 1,
        latestTurnNumber: 20,
        hasMoreBefore: false,
        hasMoreAfter: true,
        turns: Array.from({ length: 20 }, (_, index) =>
          turn(index + 1, `q${index + 1}`, `a${index + 1}`)
        ),
      })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'older-pages')
    })

    expect(result.current.chatMessages).toHaveLength(80)
    expect(result.current.hasOlderMessages).toBe(true)

    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })

    expect(clerum.rpc.loadSessionMessages).toHaveBeenLastCalledWith(
      'agent-x',
      'agent-x',
      'older-pages',
      undefined,
      { limit: 40, beforeTurn: 21 }
    )
    expect(result.current.chatMessages).toHaveLength(120)
    expect(result.current.chatMessages[0]?.id).toBe('turn-1-user')
    expect(result.current.hasOlderMessages).toBe(false)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'older-pages',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-1-assistant' })])
    )

    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'older-pages',
      state: 'idle',
      totalTurns: 101,
      oldestTurnNumber: 101,
      latestTurnNumber: 101,
      hasMoreBefore: true,
      hasMoreAfter: false,
      turns: [turn(101, 'q101', 'a101')],
    })
    await act(async () => {
      await result.current.reconcileChat(makeTaskKey('agent-x', 'older-pages'), {
        reason: 'system_resume',
      })
    })

    expect(result.current.chatMessages[0]?.id).toBe('turn-1-user')
    expect(result.current.chatMessages.at(-1)?.id).toBe('turn-101-assistant')
  })

  it('does not show older history for a complete exact-page-size local chat', async () => {
    const cached = Array.from({ length: 40 }, (_, index) =>
      turn(index + 1, `q${index + 1}`, `a${index + 1}`)
    ).flatMap(t => [
      { id: `turn-${t.number}-user`, role: 'user' as const, content: t.user_input, timestamp: 1 },
      {
        id: `turn-${t.number}-assistant`,
        role: 'assistant' as const,
        content: t.response!,
        timestamp: 2,
      },
    ])
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, _chatId: string, _limit?: number, offset?: number) =>
        offset ? [] : cached
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'exact-page',
      state: 'idle',
      turns: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'exact-page')
    })

    expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'exact-page', 1, 80)
    expect(result.current.chatMessages).toHaveLength(80)
    expect(result.current.hasOlderMessages).toBe(false)
  })

  it('ignores hasMoreBefore from an empty afterTurn reconciliation response', async () => {
    const cached = [
      {
        id: 'turn-1-user',
        role: 'user' as const,
        content: 'q1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'turn-1-assistant',
        role: 'assistant' as const,
        content: 'a1',
        timestamp: 2,
        serverTurnNumber: 1,
      },
    ]
    clerum.chat.loadMessages.mockResolvedValue(cached)
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'synced-chat',
      state: 'idle',
      turns: [],
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'synced-chat')
    })

    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'synced-chat',
      undefined,
      { limit: 40, afterTurn: 1 }
    )
    expect(result.current.chatMessages.map(message => message.id)).toEqual([
      'turn-1-user',
      'turn-1-assistant',
    ])
    expect(result.current.hasOlderMessages).toBe(false)
  })

  it('does not keep older history visible after loading an exact multiple of local pages', async () => {
    const allMessages = Array.from({ length: 160 }, (_, index) => ({
      id: `turn-${index + 1}-user`,
      role: 'user' as const,
      content: `q${index + 1}`,
      timestamp: index + 1,
    }))
    const firstVisiblePage = allMessages.slice(80)
    const olderPage = allMessages.slice(0, 80)
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, chatId: string, _limit?: number, offset?: number) => {
        if (chatId !== 'exact-local-pages') return []
        if (offset === undefined) return firstVisiblePage
        if (offset === 80) return olderPage
        return []
      }
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'exact-local-pages',
      state: 'idle',
      turns: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'exact-local-pages')
    })
    expect(result.current.hasOlderMessages).toBe(true)

    await act(async () => {
      await result.current.handleLoadOlderMessages()
    })

    expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'exact-local-pages', 1, 160)
    expect(result.current.chatMessages).toHaveLength(160)
    expect(result.current.hasOlderMessages).toBe(false)
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight older-page request when switching chats', async () => {
    let resolveOlder!: (messages: unknown[]) => void
    const olderPage = new Promise<unknown[]>(resolve => {
      resolveOlder = resolve
    })
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, chatId: string, _limit?: number, offset?: number) => {
        if (chatId === 'chat-a' && offset === 1) return olderPage
        if (chatId === 'chat-a') {
          return [
            {
              id: 'turn-10-user',
              role: 'user' as const,
              content: 'q10',
              timestamp: 10,
              serverTurnNumber: 10,
            },
          ]
        }
        return []
      }
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'chat-a',
      state: 'idle',
      turns: [],
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-a')
    })

    let pendingOlder!: Promise<void>
    act(() => {
      pendingOlder = result.current.handleLoadOlderMessages()
    })
    await waitFor(() => expect(result.current.olderMessagesLoading).toBe(true))

    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
    })
    expect(result.current.olderMessagesLoading).toBe(false)

    resolveOlder([])
    await act(async () => {
      await pendingOlder
    })
    expect(result.current.olderMessagesLoading).toBe(false)
  })

  it('ignores an older-page response when switching away and back before it resolves', async () => {
    let resolveOlder!: (messages: unknown[]) => void
    const olderPage = new Promise<unknown[]>(resolve => {
      resolveOlder = resolve
    })
    clerum.chat.loadMessages.mockImplementation(
      async (_agentRef: string, chatId: string, _limit?: number, offset?: number) => {
        if (chatId === 'chat-a' && offset === 1) return olderPage
        if (chatId === 'chat-a') {
          return [
            {
              id: 'turn-10-user',
              role: 'user' as const,
              content: 'q10',
              timestamp: 10,
              serverTurnNumber: 10,
            },
          ]
        }
        return []
      }
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, _agent: string, chatId: string) => ({
        agent: 'agent-x',
        chatId,
        state: 'idle',
        turns: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      })
    )
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-a')
    })

    let pendingOlder!: Promise<void>
    act(() => {
      pendingOlder = result.current.handleLoadOlderMessages()
    })
    await waitFor(() => expect(result.current.olderMessagesLoading).toBe(true))

    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
      await result.current.switchToChat('agent-x', 'chat-a')
    })

    resolveOlder([
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'stale q1',
        timestamp: 1,
        serverTurnNumber: 1,
      },
    ])
    await act(async () => {
      await pendingOlder
    })

    expect(result.current.chatMessages.map(message => message.id)).toEqual(['turn-10-user'])
    expect(result.current.olderMessagesLoading).toBe(false)
  })

  it('adds a server-only chat to the sidebar when switched to directly (S4)', async () => {
    // chatList starts empty (default getIndex → no chats); simulate opening a
    // notification for a chat the local list doesn't know about.
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'from-other-device',
      state: 'idle',
      turns: [turn(1, 'started elsewhere', 'reply')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'from-other-device')
    })

    expect(clerum.chat.create).toHaveBeenCalledWith('agent-x', 'from-other-device')
    // Upserted into the sidebar, not silently dropped.
    expect(result.current.chatList.some(c => c.id === 'from-other-device')).toBe(true)
  })

  it('Phase 3 rejoins the tracker when the server reports a running task', async () => {
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c3',
      state: 'processing',
      activeTaskId: 'task-running',
      turns: [],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c3')
    })

    // Rejoin → tracker opens the SSE for the active task.
    await waitFor(() => expect(clerum.hasProgressHandler('task-running')).toBe(true))
    expect(clerum.rpc.subscribeTaskProgress).toHaveBeenCalledWith(
      'agent-x',
      'task-running',
      expect.any(Function)
    )
  })

  it('Phase 3 rejoin is idempotent — switching back to a still-running chat does not re-subscribe', async () => {
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c4',
      state: 'processing',
      activeTaskId: 'task-dup',
      turns: [],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c4')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-dup')).toBe(true))

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c4')
    })

    const subsForTask = clerum.rpc.subscribeTaskProgress.mock.calls.filter(
      (c: unknown[]) => c[1] === 'task-dup'
    )
    expect(subsForTask).toHaveLength(1)
  })

  it('Phase 2 exposes a pending approval so the Approve button can render without waiting for SSE', async () => {
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c5',
      state: 'awaiting_approval',
      activeTaskId: 'task-appr',
      pendingApproval: { requestId: 'req-1', displayName: 'Run shell' },
      turns: [],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c5')
    })

    expect(result.current.sessionStateByChatKey['agent-x::c5']).toMatchObject({
      state: 'awaiting_approval',
      activeTaskId: 'task-appr',
      pendingApproval: { requestId: 'req-1', displayName: 'Run shell' },
      syncing: false,
    })
  })

  it('Phase 3 re-establishes the approval gate on rejoin WITHOUT re-notifying (§4.7.3 dedupe)', async () => {
    // Fase 5c (spec-v2 §4.7.3 / §8-R2): opening a chat whose task is awaiting
    // approval establishes the gate from the `SERVER_SNAPSHOT` (badge +
    // pendingApproval), which PRE-ARMS the (taskId,requestId) dedupe AND is the
    // immediate optimistic paint of the in-chat approve/deny affordance
    // (`seedSuspended` is gone — §8-R2). The rejoined SSE's replayed sticky
    // `suspended` (V2) is the definitive gate. A gate the user is actively
    // opening must NOT spam a desktop / in-app notification: only a genuinely
    // live STREAM_SUSPENDED (no prior snapshot) notifies.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'c5b',
      state: 'awaiting_approval',
      activeTaskId: 'task-appr2',
      pendingApproval: { requestId: 'req-9', displayName: 'Run shell' },
      turns: [],
    })
    const { result, spies } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c5b')
    })

    await waitFor(() => expect(clerum.hasProgressHandler('task-appr2')).toBe(true))
    // Gate established from the snapshot: badge + pendingApproval visible.
    expect(result.current.sessionStateByChatKey['agent-x::c5b']).toMatchObject({
      state: 'awaiting_approval',
      activeTaskId: 'task-appr2',
      pendingApproval: { requestId: 'req-9', displayName: 'Run shell' },
    })
    // No approval notification: the snapshot pre-armed the dedupe.
    expect(spies.pushNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval_required' })
    )
  })

  it('P1-A: Phase 3 rejoin lands live progress on the rendered user bubble, not the orphan key', async () => {
    // Repro of P1-A: the rejoin must carry the in-flight turn's user message id
    // (`turn-1-user` here) so the subscription effect writes the suspended
    // approval to a key a rendered message owns — never `'<unknown>'`. Fase 5c
    // (§8-R2): `suspendedInfo` now comes from the FSM projection's
    // `pendingApproval` (the reconcile's `SERVER_SNAPSHOT` optimistic paint) via
    // the progress-mirror fallback, not `seedSuspended` — the anchoring invariant
    // is unchanged (keyed by the rendered user bubble, no orphan `'<unknown>'`).
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'p1a',
      state: 'awaiting_approval',
      activeTaskId: 'task-p1a',
      pendingApproval: { requestId: 'req-p1a', displayName: 'Run shell' },
      turns: [turn(1, 'do the thing')], // in-flight turn → rendered as turn-1-user
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'p1a')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-p1a')).toBe(true))

    // Progress (incl. the suspended approval) must be keyed by the rendered user
    // message id, not the orphan `'<unknown>'`.
    await waitFor(() =>
      expect(result.current.progressByMessageId['turn-1-user']?.suspendedInfo).toMatchObject({
        requestId: 'req-p1a',
        displayName: 'Run shell',
      })
    )
    expect(result.current.progressByMessageId['<unknown>']).toBeUndefined()
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'p1a',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-1-user' })]),
      {
        activeTaskIds: ['task-p1a'],
      }
    )
  })

  it('P1-B: a processing-snapshot rejoin does not loop and settles within the cap', async () => {
    // Repro of P1-B: the server stays `processing` and each rejoined SSE drops
    // (network stress) — modelled here by an immediate stream `error` event,
    // which fires the same stream-loss terminal the watchdog would, deterministic
    // without timers. Each terminal → reconcile → re-rejoin, until the bounded
    // counter stops the loop and settles without re-subscribing forever.
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'p1b',
      state: 'processing',
      activeTaskId: 'task-p1b',
      turns: [turn(1, 'long running')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'p1b')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-p1b')).toBe(true))

    // Drive many drop→reconcile→re-rejoin cycles. The cap must stop re-rejoining
    // long before this many iterations — the subscription count stays bounded.
    for (let i = 0; i < 10; i++) {
      if (!clerum.hasProgressHandler('task-p1b')) break
      await act(async () => {
        clerum.emitTaskProgress('task-p1b', { type: 'error', message: 'stream dropped' })
        await Promise.resolve()
      })
    }

    const subsForTask = clerum.rpc.subscribeTaskProgress.mock.calls.filter(
      (c: unknown[]) => c[1] === 'task-p1b'
    )
    // 1 initial rejoin + at most MAX_REJOIN_ATTEMPTS (3) re-rejoins = 4. The key
    // point: it does NOT keep climbing with each of the 10 drop cycles.
    expect(subsForTask.length).toBeLessThanOrEqual(4)
    // And it has settled: no live handler is left looping.
    expect(clerum.hasProgressHandler('task-p1b')).toBe(false)
  })

  it('P1-stall: a capped rejoin on the active chat flips to offlineMode, and reopening clears it', async () => {
    // Repro of the P1 follow-up: when onTrackerTerminal's automatic
    // stream-loss → rejoin cycle exhausts MAX_REJOIN_ATTEMPTS while the server is
    // still `processing`, nothing follows the task anymore and the stepper would
    // freeze. The cap-exhaustion must instead surface the offline banner, and
    // reopening the chat (resetRejoinAttempts) must clear it on a clean reconcile.
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'stall',
      state: 'processing',
      activeTaskId: 'task-stall',
      turns: [turn(1, 'long running')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'stall')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-stall')).toBe(true))

    // Drive the drop→reconcile→re-rejoin cycle past the cap while the chat is open
    // and the server stays `processing`.
    for (let i = 0; i < 10; i++) {
      if (!clerum.hasProgressHandler('task-stall')) break
      await act(async () => {
        clerum.emitTaskProgress('task-stall', { type: 'error', message: 'stream dropped' })
        await Promise.resolve()
      })
    }

    // Capped: no live handler is left, and the active chat shows the offline
    // affordance instead of a frozen `processing` stepper.
    expect(clerum.hasProgressHandler('task-stall')).toBe(false)
    await waitFor(() =>
      expect(result.current.sessionStateByChatKey['agent-x::stall']).toMatchObject({
        offlineMode: true,
        syncing: false,
      })
    )

    // Reopen the chat: switchToChat resets the rejoin quota; the server now reports
    // idle with the durable reply → reconcile succeeds and offlineMode clears.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'stall',
      state: 'idle',
      turns: [turn(1, 'long running', 'done')],
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', 'stall')
    })

    expect(result.current.sessionStateByChatKey['agent-x::stall']?.offlineMode).toBeFalsy()
    expect(result.current.chatMessages.length).toBeGreaterThanOrEqual(2)
  })

  it('P2: a zombie tracker entry no longer blocks the replace once the server reports idle', async () => {
    // Repro of bug-report Problema 2. First switch finds the task still
    // `processing` server-side → Phase 3 rejoins, leaving a tracker entry. The
    // rejoined SSE never reaches a clean terminal (stream still down), so the
    // entry lingers as a "zombie". When the user comes back, the server has long
    // since persisted the durable reply (`idle`, 2 messages) but the old guard
    // `!tracker.get(key)` blocked the replace. The fix: when the server confirms
    // `idle`, ack the residual entry and let the replace land.
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])

    // First reconcile: task still running.
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'z1',
      state: 'processing',
      activeTaskId: 'task-z1',
      turns: [turn(1, 'q1')],
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'z1')
    })
    // Phase 3 rejoined → a tracker entry (zombie) now exists for the key.
    await waitFor(() => expect(clerum.hasProgressHandler('task-z1')).toBe(true))
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()

    // Second reconcile (user comes back): the durable reply is persisted, server idle.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'z1',
      state: 'idle',
      turns: [turn(1, 'q1', 'a1')], // 2 messages > 1 cached
    })

    await act(async () => {
      await result.current.switchToChat('agent-x', 'z1')
    })

    // With the zombie acked, the missing durable assistant message is persisted.
    expect(result.current.chatMessages).toHaveLength(2)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'z1',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-1-assistant' })])
    )
  })

  it('P2 regression: a LIVE local task (server non-idle) still blocks the replace', async () => {
    // The fix must only unblock on `state === 'idle'`. With a task genuinely
    // alive (server still `processing`), the optimistic local turn must be
    // preserved — the replace stays guarded.
    // First switch: cache already matches the server (1 turn, in flight) so
    // nothing to replace; Phase 3 rejoins and leaves a LIVE tracker entry.
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'z2',
      state: 'processing',
      activeTaskId: 'task-z2',
      turns: [turn(1, 'q1')], // server has 1 (in flight), cache has 1 → no replace
    })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'z2')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-z2')).toBe(true))
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()

    // Switch back while the task is STILL running server-side, now reporting more
    // turns. Because the entry is a live task (server non-idle), the optimistic
    // local turn must be preserved → the replace must NOT fire.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'z2',
      state: 'processing',
      activeTaskId: 'task-z2',
      turns: [turn(1, 'q1', 'a1')], // server has 2, cache has 1
    })

    await act(async () => {
      await result.current.switchToChat('agent-x', 'z2')
    })

    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
    expect(result.current.chatMessages).toHaveLength(1)
  })

  it('P2-A: a network blip on the return reconcile is RETRIED, and once it clears the durable reply replaces the cache + acks the zombie', async () => {
    // Repro of P2-A. First switch finds the task `processing` → Phase 3 rejoins,
    // leaving a tracker entry (zombie). On return the reconcile fetch hits the
    // same transient blip TWICE, then succeeds (server idle, durable reply
    // persisted). The retry must let the reply land instead of parking offline.
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'pa',
      state: 'processing',
      activeTaskId: 'task-pa',
      turns: [turn(1, 'q1')],
    })
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.switchToChat('agent-x', 'pa')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-pa')).toBe(true))
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()

    // Return reconcile: 2 transient network failures, then idle with the reply.
    clerum.rpc.loadSessionMessages
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({
        agent: 'agent-x',
        chatId: 'pa',
        state: 'idle',
        turns: [turn(1, 'q1', 'a1')], // 2 messages > 1 cached
      })

    await act(async () => {
      await result.current.switchToChat('agent-x', 'pa')
    })

    // The retry landed the durable reply: merged window persisted, zombie acked, NOT offline.
    expect(result.current.chatMessages).toHaveLength(2)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'pa',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-1-assistant' })])
    )
    expect(result.current.sessionStateByChatKey['agent-x::pa']?.offlineMode).toBeFalsy()
    expect(clerum.hasProgressHandler('task-pa')).toBe(false)
  })

  it('P2-A: the reconcile retry is BOUNDED — a sustained outage settles into offline mode', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'm', role: 'user' as const, content: 'cached', timestamp: 1 },
    ])
    // Every attempt fails with a network error → exhausts the bounded retries.
    clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('fetch failed'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'pa2')
    })

    // Bounded: 1 initial + 2 retries = 3 attempts, then offline (no infinite loop).
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledTimes(3)
    expect(result.current.chatMessages).toHaveLength(1)
    expect(result.current.sessionStateByChatKey['agent-x::pa2']).toMatchObject({
      syncing: false,
      offlineMode: true,
    })
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
  })

  it('P2-A: a chat switch DURING the retry loop cancels it — no replace for the chat the user left', async () => {
    clerum.chat.loadMessages.mockImplementation(async (_a: string, chatId: string) =>
      chatId === 'pa3'
        ? [{ id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 }]
        : []
    )
    // pa3's reconcile keeps network-failing so we stay inside the retry loop; the
    // user switches to pa3b mid-loop, superseding it. Even if pa3 would later have
    // "succeeded", the aborted loop must not replace pa3's messages.
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_h: string, _a: string, chatId: string) => {
        if (chatId === 'pa3') throw new Error('fetch failed')
        return { agent: 'agent-x', chatId, state: 'idle', turns: [] }
      }
    )
    const { result } = renderController()
    await settleMount()

    // Don't await: the retry loop is in flight (backoff between failed attempts).
    let firstSwitch: Promise<void>
    await act(async () => {
      firstSwitch = result.current.switchToChat('agent-x', 'pa3')
      // Supersede before the loop can exhaust its retries.
      await result.current.switchToChat('agent-x', 'pa3b')
      await firstSwitch
    })

    // The active chat is pa3b; pa3's aborted loop never wrote pa3 offline/replaced.
    expect(result.current.activeChatId).toBe('pa3b')
    expect(clerum.chat.replaceMessages).not.toHaveBeenCalled()
    expect(result.current.sessionStateByChatKey['agent-x::pa3']?.offlineMode).toBeFalsy()
  })

  it('P2-B: a stream loss DURING a switch reconcile coalesces onto it and still lands the durable reply (single-flight, §4.3)', async () => {
    // Fase 5c: `onTrackerTerminal`'s stream-loss recovery now routes through the
    // SINGLE-FLIGHT `reconcileChat` gate. When a switch reconcile for the same key
    // is already in flight, the stream-loss reconcile COALESCES onto it (§4.3:
    // "una segunda invocación mientras corre una se coalesce") instead of running
    // an independent re-rejoin. The P2-B invariant is unchanged and observable in
    // the END state: onTrackerTerminal acks the zombie before coalescing, and the
    // switch reconcile (its `zombieBefore` taskId hint = task-pb) settles idle and
    // lands the durable reply — no residual blocks the replace.
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])
    // Switch 1: processing → Phase 3 rejoins (records task-pb as the recovering task).
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'pb',
      state: 'processing',
      activeTaskId: 'task-pb',
      turns: [turn(1, 'q1')],
    })
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.switchToChat('agent-x', 'pb')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-pb')).toBe(true))

    // Acking switch: the reconcile fetch is DEFERRED. While it's pending we drop
    // the stream (error event) → onTrackerTerminal acks task-pb then coalesces onto
    // this same in-flight reconcile. When it resolves idle, the residual is already
    // gone and the durable reply replaces the cache.
    let resolveOuter!: (v: unknown) => void
    const outer = new Promise(res => {
      resolveOuter = res
    })
    // Only ONE fetch runs now (the coalesced switch reconcile) — onTrackerTerminal
    // no longer issues its own.
    clerum.rpc.loadSessionMessages.mockImplementationOnce(() => outer as Promise<never>)

    await act(async () => {
      const sw = result.current.switchToChat('agent-x', 'pb')
      // Fire the stream-loss while the outer reconcile is still pending.
      await Promise.resolve()
      clerum.emitTaskProgress('task-pb', { type: 'error', message: 'stream dropped' })
      await Promise.resolve()
      // Now resolve the outer reconcile as idle with the durable reply.
      resolveOuter({
        agent: 'agent-x',
        chatId: 'pb',
        state: 'idle',
        turns: [turn(1, 'q1', 'a1')],
      })
      await sw
    })

    // The residual was acked and the durable reply was persisted to the cache.
    expect(result.current.chatMessages).toHaveLength(2)
    expect(clerum.chat.replaceMessages).toHaveBeenCalledWith(
      'agent-x',
      'pb',
      expect.arrayContaining([expect.objectContaining({ id: 'turn-1-assistant' })])
    )
  })

  it('P2-B: a live fresh task on the same chat is never torn down by a later reconcile (over-heal regression)', async () => {
    // Guard against over-healing. After a recovery records `task-OLD`, the user
    // starts a brand-new task (`task-NEW`) on the same chat once the recovery has
    // settled. The fresh send clears the recovering marker, and because the server
    // reports task-NEW as live (`state !== 'idle'`) the replace stays guarded and
    // the live task is never acked. (Note: this proves the live-task regression via
    // the `state !== 'idle'` guard. The complementary "task started DURING the
    // reconcile await with a non-matching taskId" edge is covered by code review +
    // the matching-case test above; it requires mid-await send injection the
    // harness can't drive, so it is not asserted here.)
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
    ])
    // Switch 1: processing on task-OLD → records recovering id = task-OLD, rejoins.
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'pc',
      state: 'processing',
      activeTaskId: 'task-OLD',
      turns: [turn(1, 'q1')],
    })
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.switchToChat('agent-x', 'pc')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-OLD')).toBe(true))

    // The OLD task's stream drops and the server confirms idle → onTrackerTerminal
    // acks task-OLD, lands its reply, and clears the recovering marker. No entry
    // is left, so a fresh send is allowed.
    clerum.rpc.loadSessionMessages.mockResolvedValueOnce({
      agent: 'agent-x',
      chatId: 'pc',
      state: 'idle',
      turns: [turn(1, 'q1', 'a1')],
    })
    await act(async () => {
      clerum.emitTaskProgress('task-OLD', { type: 'error', message: 'stream dropped' })
      await waitFor(() => expect(clerum.hasProgressHandler('task-OLD')).toBe(false))
    })

    // User sends a brand-new task on the same chat (different taskId, live).
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-NEW' })
    await act(async () => {
      await result.current.handleSendAgentMessage('a brand new task')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-NEW')).toBe(true))

    // Return reconcile: server still PROCESSING task-NEW (it's genuinely live). The
    // replace must stay guarded — the live task's optimistic turn is preserved.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'pc',
      state: 'processing',
      activeTaskId: 'task-NEW',
      turns: [turn(1, 'q1', 'a1'), turn(2, 'a brand new task')],
    })
    const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length

    await act(async () => {
      await result.current.switchToChat('agent-x', 'pc')
    })

    // task-NEW is live (server non-idle) → not acked, replace stays guarded.
    expect(clerum.chat.replaceMessages.mock.calls.length).toBe(replaceCallsBefore)
    expect(clerum.hasProgressHandler('task-NEW')).toBe(true)
  })

  it('404 evicts the stale local chat and resets the active selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    clerum.chat.loadMessages.mockResolvedValue([])
    clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('404 Not Found'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'gone')
    })

    expect(clerum.chat.delete).toHaveBeenCalledWith('agent-x', 'gone')
    expect(result.current.activeChatId).toBeNull()
    expect(result.current.sessionStateByChatKey['agent-x::gone']).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('network error keeps the Phase-1 cache and flags offline mode', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'm', role: 'user' as const, content: 'cached', timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('fetch failed'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c6')
    })

    expect(result.current.activeChatId).toBe('c6')
    expect(result.current.chatMessages).toHaveLength(1)
    expect(clerum.chat.delete).not.toHaveBeenCalled()
    expect(result.current.sessionStateByChatKey['agent-x::c6']).toMatchObject({
      syncing: false,
      offlineMode: true,
    })
  })
})
