// @vitest-environment jsdom
/**
 * Characterization tests for the agent-selection effect that consumes
 * `pendingChatSelectionByAgentRef` (latest / none / specific). Includes the B9
 * fix: a `specific` selection that never materialises in the merged list must
 * clear the chat spinner (empty-state) instead of spinning forever.
 *
 * See .specs/refactor-useAgentChatController/plan.md Fase 0 + spec.md B.4.
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

const chatMeta = (id: string, title = id) => ({
  id,
  title,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  messageCount: 1,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('pendingChatSelection effect', () => {
  it('opens the newest server session after first paint when the local index is empty', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 3,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'server-latest',
          turnCount: 2,
          messageCount: 4,
          lastActivityAt: '2026-05-01T00:00:00Z',
        },
      ],
    })

    const { result } = renderController({ navItem: 'chat' })

    await waitFor(() => expect(result.current.activeChatId).toBe('server-latest'))
  })

  it('does not fabricate message totals for summaries from older servers', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 3,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'legacy-summary',
          turnCount: 7,
          lastActivityAt: '2026-05-01T00:00:00Z',
        },
      ],
    })

    const { result } = renderController({ navItem: 'chat' })

    await waitFor(() =>
      expect(result.current.chatList).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'legacy-summary',
            messageCount: 0,
            turnCount: 7,
          }),
        ])
      )
    )
  })

  it('latest → switches to the most recent chat', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-latest')],
    })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
    })
    // Re-run the selection effect by flipping navItem.
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() => expect(result.current.activeChatId).toBe('c-latest'))
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-latest',
      undefined,
      { limit: 40 }
    )
  })

  it('latest → overrides an older visible chat when explicitly requested', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-older')],
    })
    const { result, rerender } = renderController({ navItem: 'chat' })

    await waitFor(() => expect(result.current.activeChatId).toBe('c-older'))

    clerum.chat.getIndex.mockResolvedValue({
      version: 2,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-newest'), chatMeta('c-older')],
    })
    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
    })
    await act(async () => {
      rerender({ navItem: 'agents' })
    })

    await waitFor(() => expect(result.current.activeChatId).toBe('c-newest'))
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-newest',
      undefined,
      { limit: 40 }
    )
  })

  it('latest → does not override a chat auto-created while the list load is in flight', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-latest-race' })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    const index = deferred<{
      version: number
      lastActiveChatId: string | null
      onboardingDismissed: boolean
      chats: ReturnType<typeof chatMeta>[]
    }>()
    clerum.chat.getIndex.mockReturnValue(index.promise)

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { selectLatest: true })
    })
    await act(async () => {
      rerender({ navItem: 'chat' })
    })
    await waitFor(() => expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(1))

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('keep latest from stealing this chat')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-latest-race')).toBe(true))
    const createdChatId = result.current.activeChatId
    expect(createdChatId).toBeTruthy()

    await act(async () => {
      index.resolve({
        version: 2,
        lastActiveChatId: null,
        onboardingDismissed: false,
        chats: [chatMeta('older-chat')],
      })
    })

    await sendPromise
    expect(result.current.activeChatId).toBe(createdChatId)
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'older-chat'
    )
  })

  it('none → selects nothing and clears the spinner', async () => {
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'must-not-auto-select',
          turnCount: 1,
          messageCount: 2,
          lastActivityAt: '2026-05-01T00:00:00Z',
        },
      ],
    })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', null, { suppressAutoSelect: true })
    })
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() => expect(result.current.chatMessagesLoading).toBe(false))
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    expect(result.current.activeChatId).toBeNull()
  })

  it('specific (found) → switches to the requested chat', async () => {
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [chatMeta('c-specific', 'Specific chat')],
    })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', 'c-specific', { title: 'Specific chat' })
    })
    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-specific',
        undefined,
        { limit: 40 }
      )
    )
    await waitFor(() => expect(result.current.activeChatId).toBe('c-specific'))
    expect(result.current.chatMessagesLoading).toBe(false)
  })

  it('B9: specific (not found) clears the spinner instead of spinning forever', async () => {
    // A server-only chat surfaced by a notification while listSessions silently
    // returns items:[] — the requested chat never appears in the merged list.
    clerum.chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    clerum.rpc.listSessions.mockResolvedValue({ items: [] })
    const { result, rerender } = renderController({ navItem: 'agents' })
    await settleMount()

    await act(async () => {
      result.current.setPendingChatSelection('agent-x', 'c-missing', { title: 'Missing' })
    })
    // Optimistic set turns the spinner on for the requested chat.
    expect(result.current.activeChatId).toBe('c-missing')
    expect(result.current.chatMessagesLoading).toBe(true)

    await act(async () => {
      rerender({ navItem: 'chat' })
    })

    // The chat never materialised → no switchToChat reconcile fired for it, and
    // the spinner is cleared (empty-state) rather than left spinning forever.
    await waitFor(() => expect(result.current.chatMessagesLoading).toBe(false))
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'c-missing'
    )
  })

  it('does not let a late chat-list load clear a chat auto-created by send', async () => {
    const index = deferred<{
      version: number
      lastActiveChatId: string | null
      onboardingDismissed: boolean
      chats: ReturnType<typeof chatMeta>[]
    }>()
    clerum.chat.getIndex.mockReturnValue(index.promise)
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-race' })
    const { result } = renderController({ navItem: 'chat' })

    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('keep this visible')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-race')).toBe(true))
    const createdChatId = result.current.activeChatId
    expect(createdChatId).toBeTruthy()

    await act(async () => {
      index.resolve({
        version: 1,
        lastActiveChatId: null,
        onboardingDismissed: false,
        chats: [chatMeta('older-chat')],
      })
    })

    await sendPromise
    expect(result.current.activeChatId).toBe(createdChatId)
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'older-chat'
    )
  })
})
