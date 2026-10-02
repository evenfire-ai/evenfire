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
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAgentChatActionsValue } from '@hooks/useAgentChatActionsValue'
import type { useAppController } from '@hooks/useAppController'
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
    // The remote load follows the local store read, which crosses IPC (here, the
    // real ChatStore's disk read), so it lands after the selection flips.
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-latest',
        undefined,
        { limit: 40 }
      )
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
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'c-newest',
        undefined,
        { limit: 40 }
      )
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

  it('keeps New chat authoritative when an older specific selection load resolves', async () => {
    const priorChatId = 'prior-chat'
    await clerum.chat.create('agent-x', priorChatId)
    await clerum.chat.upsertMessages('agent-x', priorChatId, [
      {
        id: 'prior-message',
        role: 'user',
        content: 'keep this in the previous chat',
        timestamp: Date.now(),
      },
    ])
    const priorChatIndex = await clerum.readIndex('agent-x')

    const controller = renderController({ navItem: 'agents' })
    await settleMount()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const indexCallsBeforeSelection = clerum.chat.getIndex.mock.calls.length
    const index = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(index.promise)
    const cachedMessages = deferred<Awaited<ReturnType<typeof clerum.chat.loadMessages>>>()
    const loadMessages = clerum.chat.loadMessages.getMockImplementation()
    if (!loadMessages) throw new Error('Expected the real ChatStore loadMessages producer')
    clerum.chat.loadMessages.mockImplementation((agentRef, chatId, limit, offset) =>
      agentRef === 'agent-x' && chatId === priorChatId
        ? cachedMessages.promise
        : loadMessages(agentRef, chatId, limit, offset)
    )
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'fresh reply' })

    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', priorChatId)
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallsBeforeSelection)
    )
    expect(controller.result.current.chatListLoading).toBe(true)

    const actions = renderHook(() =>
      useAgentChatActionsValue(
        controller.result.current as unknown as ReturnType<typeof useAppController>
      )
    )

    try {
      // Match the New chat selection transition in useAppController. Its blank
      // state is committed while the older specific selection still awaits IPC.
      await act(async () => {
        controller.result.current.setPendingChatSelection('agent-x', null, {
          suppressAutoSelect: true,
        })
        controller.result.current.clearActiveChat()
        actions.rerender()
      })
      expect(controller.result.current.activeChatId).toBeNull()
      expect(controller.result.current.chatMessages).toEqual([])

      await act(async () => {
        index.resolve(priorChatIndex)
      })
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      if (controller.result.current.activeChatId === priorChatId) {
        await waitFor(() =>
          expect(clerum.chat.loadMessages).toHaveBeenCalledWith(
            'agent-x',
            priorChatId,
            expect.any(Number),
            undefined
          )
        )
      }

      // ComposerPanel receives this stable action from the production action-value
      // factory. Calling it now models a send after the New chat commit and the
      // older index response, while the re-opened chat's cache read stays pending.
      await act(async () => {
        actions.rerender()
        await actions.result.current.handleSendAgentMessage('start the next conversation')
      })

      const request = clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1] as
        | { threadId?: string }
        | undefined
      expect(request?.threadId).not.toBe(priorChatId)

      const priorMessages = await clerum.persistedMessages('agent-x', priorChatId)
      expect(priorMessages).toEqual([
        expect.objectContaining({ id: 'prior-message', content: 'keep this in the previous chat' }),
      ])
      const newChatId = request?.threadId
      expect(newChatId).toBeTruthy()
      expect(await clerum.persistedMessages('agent-x', newChatId!)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'start the next conversation' }),
          expect.objectContaining({ role: 'assistant', content: 'fresh reply' }),
        ])
      )
    } finally {
      await act(async () => {
        cachedMessages.resolve(await loadMessages('agent-x', priorChatId, undefined, undefined))
      })
      controller.unmount()
      actions.unmount()
    }
  })

  it('keeps a newer selection while retaining a delayed New chat in the list', async () => {
    await clerum.chat.create('agent-x', 'selected-chat')
    const controller = renderController({ navItem: 'agents' })
    await settleMount()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const releaseCreate = deferred<void>()
    const created = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    clerum.chat.create.mockImplementation(async (agentRef, chatId) => {
      const meta = await createChat(agentRef, chatId)
      created.resolve(meta)
      await releaseCreate.promise
      return meta
    })

    let createPromise!: Promise<void>
    act(() => {
      createPromise = controller.result.current.handleCreateChat()
    })
    const createdChat = await created.promise

    await act(async () => {
      await controller.result.current.switchToChat('agent-x', 'selected-chat')
    })

    await act(async () => {
      releaseCreate.resolve()
      await createPromise
    })

    expect(controller.result.current.activeChatId).toBe('selected-chat')
    expect(controller.result.current.chatList).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdChat.id })])
    )
    controller.unmount()
  })

  it('keeps an accepted blank-chat send bound when New chat arrives during creation', async () => {
    const controller = renderController({ navItem: 'chat' })
    await settleMount()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const releaseCreate = deferred<void>()
    const created = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    clerum.chat.create.mockImplementation(async (agentRef, chatId) => {
      const meta = await createChat(agentRef, chatId)
      created.resolve(meta)
      await releaseCreate.promise
      return meta
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'sent reply' })

    const actions = renderHook(() =>
      useAgentChatActionsValue(
        controller.result.current as unknown as ReturnType<typeof useAppController>
      )
    )
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage('accepted before New chat')
    })
    const createdChat = await created.promise

    try {
      await act(async () => {
        controller.result.current.setPendingChatSelection('agent-x', null, {
          suppressAutoSelect: true,
        })
        controller.result.current.clearActiveChat()
        actions.rerender()
      })
      expect(controller.result.current.activeChatId).toBeNull()
      expect(controller.result.current.chatMessages).toEqual([])

      await act(async () => {
        releaseCreate.resolve()
        await sendPromise
      })

      const request = clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1] as
        | { threadId?: string }
        | undefined
      expect(request?.threadId).toBe(createdChat.id)
      expect(await clerum.persistedMessages('agent-x', createdChat.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'accepted before New chat' }),
          expect.objectContaining({ role: 'assistant', content: 'sent reply' }),
        ])
      )
      expect(controller.result.current.activeChatId).toBeNull()
    } finally {
      releaseCreate.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      actions.unmount()
      controller.unmount()
    }
  })
})
