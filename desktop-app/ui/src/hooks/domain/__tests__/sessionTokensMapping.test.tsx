// @vitest-environment jsdom
/**
 * Fase 2 — server-reported session token totals must flow from `listSessions`
 * (and `loadSessionMessages`) into `SessionStateLite.tokens`, surfaced per-chat
 * via `sessionStateByChatId`. The cache breakdown is present only when the
 * server included it (the model reports cache); absent otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('session token totals mapping (Fase 2)', () => {
  it('maps server tokens from listSessions into sessionStateByChatId', async () => {
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'chat-anthropic',
          turnCount: 2,
          lastActivityAt: new Date().toISOString(),
          state: 'idle',
          // model reports cache → 4 figures
          tokens: { input: 150, output: 60, cacheRead: 13, cacheWrite: 5 },
        },
        {
          agent: 'agent-x',
          chatId: 'chat-openai',
          turnCount: 1,
          lastActivityAt: new Date().toISOString(),
          state: 'idle',
          // provider without cache → 2 figures
          tokens: { input: 30, output: 10 },
        },
        {
          agent: 'agent-x',
          chatId: 'chat-fresh',
          turnCount: 0,
          lastActivityAt: new Date().toISOString(),
          state: 'idle',
          // no LLM call yet → no tokens object
        },
      ],
    })

    // The mount agent-selection effect runs `loadChatList` for `selectedAgent`,
    // seeding the FSM from `listSessions` (loadChatList is no longer a public
    // hook member — B18 dead contract). The waitFor below covers the seeding.
    const { result } = renderController()
    await settleMount()

    await waitFor(() =>
      expect(result.current.sessionStateByChatId['chat-anthropic']?.tokens).toEqual({
        input: 150,
        output: 60,
        cacheRead: 13,
        cacheWrite: 5,
      })
    )
    // provider without cache: only input/output, no cache keys
    expect(result.current.sessionStateByChatId['chat-openai']?.tokens).toEqual({
      input: 30,
      output: 10,
    })
    // no LLM call yet: tokens undefined (UI shows no counter)
    expect(result.current.sessionStateByChatId['chat-fresh']?.tokens).toBeUndefined()
  })
})
