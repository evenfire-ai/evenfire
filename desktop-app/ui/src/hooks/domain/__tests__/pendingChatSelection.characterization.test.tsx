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
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  resetComposerDraftStore()
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetComposerDraftStore()
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

    // Keep the index pending while the send finishes, and close this act scope
    // before waiting for progress or resolving the list in another scope.
    await act(async () => {
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

    expect(result.current.activeChatId).toBe(createdChatId)
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      'older-chat'
    )
  })

  it('keeps a send-created chat selected when a retried list request finishes later', async () => {
    const releaseIndexFailure = deferred<void>()
    clerum.chat.getIndex
      .mockImplementationOnce(async () => {
        await releaseIndexFailure.promise
        throw new Error('Not authenticated during store rebind')
      })
      .mockImplementation(agentRef => clerum.readIndex(agentRef))
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'prior-server',
          turnCount: 1,
          messageCount: 2,
          lastActivityAt: '2026-05-03T00:00:00Z',
        },
      ],
    })
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'prior-server',
      state: 'idle',
      turns: [],
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'accepted reply' })

    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const created = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    const releaseCreate = deferred<void>()
    let holdCreate = true
    clerum.chat.create.mockImplementation(async (agentRef, chatId) => {
      const meta = await createChat(agentRef, chatId)
      if (holdCreate) {
        holdCreate = false
        created.resolve(meta)
        await releaseCreate.promise
      }
      return meta
    })

    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    let sendPromise: Promise<void> | undefined
    let createdChat: Awaited<ReturnType<typeof clerum.chat.create>> | undefined
    try {
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(1))
      await act(async () => {
        sendPromise = controller.result.current.handleSendAgentMessage('newer blank send')
        createdChat = await created.promise
      })
      if (!createdChat) throw new Error('Expected the real ChatStore create producer to resolve')

      const indexBeforeRetry = await clerum.readIndex('agent-x')
      expect(indexBeforeRetry.chats.map(chat => chat.id)).toContain(createdChat.id)
      await act(async () => {
        releaseIndexFailure.resolve()
      })
      await waitFor(() =>
        expect(controller.result.current.chatList.map(chat => chat.id)).toContain('prior-server')
      )

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
          expect.objectContaining({ role: 'user', content: 'newer blank send' }),
          expect.objectContaining({ role: 'assistant', content: 'accepted reply' }),
        ])
      )
      expect(controller.result.current.activeChatId).toBe(createdChat.id)
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'newer blank send' }),
          expect.objectContaining({ content: 'accepted reply' }),
        ])
      )
    } finally {
      releaseIndexFailure.resolve()
      releaseCreate.resolve()
      await act(async () => {
        await sendPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('still auto-selects the latest server chat after a retry with no newer intent', async () => {
    const releaseIndexFailure = deferred<void>()
    clerum.chat.getIndex
      .mockImplementationOnce(async () => {
        await releaseIndexFailure.promise
        throw new Error('Not authenticated during store rebind')
      })
      .mockImplementation(agentRef => clerum.readIndex(agentRef))
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'server-latest-after-retry',
          turnCount: 2,
          messageCount: 4,
          lastActivityAt: '2026-05-01T00:00:00Z',
        },
      ],
    })

    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    try {
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(1))
      await act(async () => {
        releaseIndexFailure.resolve()
      })

      await waitFor(() =>
        expect(controller.result.current.activeChatId).toBe('server-latest-after-retry')
      )
      expect(clerum.chat.getIndex).toHaveBeenCalledTimes(2)
    } finally {
      releaseIndexFailure.resolve()
      controller.unmount()
    }
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

    await act(async () => {
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
    const acceptedDraft = 'accepted before New chat'
    act(() => setComposerDraft(null, acceptedDraft, 'agent-x'))
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage(getComposerDraft(null, 'agent-x'))
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
          expect.objectContaining({ role: 'user', content: acceptedDraft }),
          expect.objectContaining({ role: 'assistant', content: 'sent reply' }),
        ])
      )
      expect(controller.result.current.activeChatId).toBeNull()
      expect(getComposerDraft(null, 'agent-x')).toBe('')

      await act(async () => {
        await actions.result.current.handleSendAgentMessage(getComposerDraft(null, 'agent-x'))
      })
      expect(clerum.chat.create).toHaveBeenCalledTimes(1)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    } finally {
      releaseCreate.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      actions.unmount()
      controller.unmount()
    }
  })

  it('preserves newer blank-chat text while consuming the accepted origin revision', async () => {
    const controller = renderController({ navItem: 'chat' })
    await settleMount()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const releaseCreate = deferred<void>()
    const created = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    const releaseSecondCreate = deferred<void>()
    const secondCreated = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    let createNumber = 0
    clerum.chat.create.mockImplementation(async (agentRef, chatId) => {
      const meta = await createChat(agentRef, chatId)
      createNumber += 1
      if (createNumber === 1) {
        created.resolve(meta)
        await releaseCreate.promise
      } else {
        secondCreated.resolve(meta)
        await releaseSecondCreate.promise
      }
      return meta
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'sent reply' })

    const actions = renderHook(() =>
      useAgentChatActionsValue(
        controller.result.current as unknown as ReturnType<typeof useAppController>
      )
    )
    const acceptedDraft = 'accepted before New chat'
    const newerDraft = 'typed after New chat'
    const acceptedFileId = '0123456789abcdef0123456789abcdef'
    const acceptedReference = {
      id: `global-file:main:${acceptedFileId}`,
      type: 'global_file' as const,
      resourceId: acceptedFileId,
      drive: 'main',
      gfsUri: `gfs://main/${acceptedFileId}`,
      label: 'accepted-file.md',
      version: 1,
      bytes: 1,
    }
    act(() => {
      setComposerDraft(null, acceptedDraft, 'agent-x')
      controller.result.current.handleAddComposerReferenceAttachments([acceptedReference])
    })
    act(() => actions.rerender())
    let sendPromise!: Promise<void>
    let secondSendPromise: Promise<void> | undefined
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage(getComposerDraft(null, 'agent-x'))
    })
    const createdChat = await created.promise

    try {
      act(() => {
        controller.result.current.setPendingChatSelection('agent-x', null, {
          suppressAutoSelect: true,
        })
        controller.result.current.clearActiveChat()
        setComposerDraft(null, newerDraft, 'agent-x')
      })

      await act(async () => {
        releaseCreate.resolve()
        await sendPromise
      })

      const request = clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1] as
        | { threadId?: string; fileReferences?: unknown[] }
        | undefined
      expect(request?.threadId).toBe(createdChat.id)
      expect(request?.fileReferences).toHaveLength(1)
      expect(getComposerDraft(null, 'agent-x')).toBe(newerDraft)
      expect(controller.result.current.composerReferenceAttachments).toEqual([])
      expect(await clerum.persistedMessages('agent-x', createdChat.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user', content: acceptedDraft })])
      )

      act(() => actions.rerender())
      act(() => {
        secondSendPromise = actions.result.current.handleSendAgentMessage(
          getComposerDraft(null, 'agent-x')
        )
      })
      const secondCreatedChat = await secondCreated.promise
      act(() => {
        setComposerDraft(null, '', 'agent-x')
        setComposerDraft(null, newerDraft, 'agent-x')
      })
      await act(async () => {
        releaseSecondCreate.resolve()
        await secondSendPromise
      })
      expect(getComposerDraft(null, 'agent-x')).toBe(newerDraft)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
      expect(clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1]).toMatchObject({
        threadId: secondCreatedChat.id,
      })
    } finally {
      releaseCreate.resolve()
      releaseSecondCreate.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
        await secondSendPromise?.catch(() => undefined)
      })
      actions.unmount()
      controller.unmount()
    }
  })

  it('clears only the captured draft when the accepted destination becomes visible', async () => {
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
    const acceptedDraft = 'accepted from blank chat'
    const destinationDraft = 'new draft in the destination'
    act(() => setComposerDraft(null, acceptedDraft, 'agent-x'))
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage(getComposerDraft(null, 'agent-x'))
    })
    const createdChat = await created.promise

    try {
      await act(async () => {
        controller.result.current.setPendingChatSelection('agent-x', null, {
          suppressAutoSelect: true,
        })
        controller.result.current.clearActiveChat()
        await controller.result.current.switchToChat('agent-x', createdChat.id)
      })
      act(() => setComposerDraft(createdChat.id, destinationDraft))

      await act(async () => {
        releaseCreate.resolve()
        await sendPromise
      })

      expect(controller.result.current.activeChatId).toBe(createdChat.id)
      expect(getComposerDraft(null, 'agent-x')).toBe('')
      expect(getComposerDraft(createdChat.id)).toBe(destinationDraft)
      expect(clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1]).toMatchObject({
        threadId: createdChat.id,
      })
    } finally {
      releaseCreate.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      actions.unmount()
      controller.unmount()
    }
  })

  it('consumes the accepted chat origin without clearing the newly selected chat draft', async () => {
    const createChat = clerum.chat.create.getMockImplementation()
    if (!createChat) throw new Error('Expected the real ChatStore create producer')
    const sourceChat = await createChat('agent-x', 'source-chat')
    const destinationChat = await createChat('agent-x', 'destination-chat')
    clerum.chat.getIndex.mockResolvedValue(await clerum.readIndex('agent-x'))

    const controller = renderController({ navItem: 'agents' })
    await settleMount()
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await act(async () => {
      await controller.result.current.switchToChat('agent-x', sourceChat.id)
    })
    expect(controller.result.current.activeChatId).toBe(sourceChat.id)

    const upsertMessages = clerum.chat.upsertMessages.getMockImplementation()
    if (!upsertMessages) throw new Error('Expected the real ChatStore upsert producer')
    const firstWriteStarted = deferred<void>()
    const releaseFirstWrite = deferred<void>()
    let firstWrite = true
    clerum.chat.upsertMessages.mockImplementation(async (...args) => {
      const result = await upsertMessages(...args)
      if (firstWrite) {
        firstWrite = false
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      return result
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'sent reply' })

    const actions = renderHook(() =>
      useAgentChatActionsValue(
        controller.result.current as unknown as ReturnType<typeof useAppController>
      )
    )
    const acceptedDraft = 'accepted in source chat'
    const destinationDraft = 'new text in destination chat'
    act(() => setComposerDraft(sourceChat.id, acceptedDraft))
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage(getComposerDraft(sourceChat.id))
    })

    try {
      await firstWriteStarted.promise
      await act(async () => {
        await controller.result.current.switchToChat('agent-x', destinationChat.id)
      })
      act(() => setComposerDraft(destinationChat.id, destinationDraft))

      await act(async () => {
        releaseFirstWrite.resolve()
        await sendPromise
      })

      expect(controller.result.current.activeChatId).toBe(destinationChat.id)
      expect(getComposerDraft(sourceChat.id)).toBe('')
      expect(getComposerDraft(destinationChat.id)).toBe(destinationDraft)
      expect(clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1]).toMatchObject({
        threadId: sourceChat.id,
      })
      expect(await clerum.persistedMessages('agent-x', sourceChat.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user', content: acceptedDraft })])
      )
    } finally {
      releaseFirstWrite.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      actions.unmount()
      controller.unmount()
    }
  })

  it('consumes accepted text without clearing references added after send start', async () => {
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
    const acceptedDraft = 'accepted before New chat'
    const newerFileId = 'fedcba9876543210fedcba9876543210'
    const newerReference = {
      id: `global-file:main:${newerFileId}`,
      type: 'global_file' as const,
      resourceId: newerFileId,
      drive: 'main',
      gfsUri: `gfs://main/${newerFileId}`,
      label: 'new-file.md',
      version: 1,
      bytes: 1,
    }
    act(() => setComposerDraft(null, acceptedDraft, 'agent-x'))
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = actions.result.current.handleSendAgentMessage(getComposerDraft(null, 'agent-x'))
    })
    const createdChat = await created.promise

    try {
      act(() => {
        controller.result.current.setPendingChatSelection('agent-x', null, {
          suppressAutoSelect: true,
        })
        controller.result.current.clearActiveChat()
        actions.result.current.handleAddComposerReferenceAttachments([newerReference])
      })

      await act(async () => {
        releaseCreate.resolve()
        await sendPromise
      })

      const request = clerum.rpc.invokeHostMessage.mock.calls.at(-1)?.[1] as
        | { threadId?: string }
        | undefined
      expect(request?.threadId).toBe(createdChat.id)
      expect(getComposerDraft(null, 'agent-x')).toBe('')
      expect(controller.result.current.composerReferenceAttachments).toEqual([
        expect.objectContaining(newerReference),
      ])
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
