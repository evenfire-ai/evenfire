// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import { deferred, localIndex } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cachedMessages = [
  { id: 'cached-user', role: 'user' as const, content: 'Cached question', timestamp: 1 },
  { id: 'cached-assistant', role: 'assistant' as const, content: 'Cached answer', timestamp: 2 },
]

beforeEach(() => {
  clerum = installMockClerum()
  clerum.chat.loadMessages.mockResolvedValue(cachedMessages)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetComposerDraftStore()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

describe('switchToChat last-active persistence', () => {
  it('loads and renders cached messages before last-active persistence resolves, then waits for it', async () => {
    const lastActive = deferred<void>()
    clerum.chat.setLastActive.mockReturnValueOnce(lastActive.promise)
    const { result } = renderController()
    await settleMount()
    let selection!: Promise<void>
    let completed = false

    await act(async () => {
      selection = result.current.switchToChat('agent-x', 'chat-a').then(() => {
        completed = true
      })
    })
    try {
      await waitFor(() => {
        expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'chat-a', 80, undefined)
        expect(result.current.activeChatId).toBe('chat-a')
        expect(result.current.chatMessages).toEqual(cachedMessages)
        expect(result.current.chatMessagesLoading).toBe(false)
      })
      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'chat-a')
      expect(completed).toBe(false)
    } finally {
      await act(async () => {
        lastActive.resolve()
        await selection
      })
    }

    expect(completed).toBe(true)
    expect(result.current.chatMessages).toEqual(cachedMessages)
  })

  it('rejects the selection with a deferred persistence error after its cached messages render', async () => {
    const lastActive = deferred<void>()
    const failure = new Error('Last-active index is not writable')
    clerum.chat.setLastActive.mockReturnValueOnce(lastActive.promise)
    const { result } = renderController()
    await settleMount()
    let selection!: Promise<void>

    await act(async () => {
      selection = result.current.switchToChat('agent-x', 'chat-a')
    })
    const rejection = expect(selection).rejects.toBe(failure)
    try {
      await waitFor(() => expect(result.current.chatMessages).toEqual(cachedMessages))
      expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'chat-a', 80, undefined)
      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'chat-a')
    } finally {
      await act(async () => {
        lastActive.reject(failure)
        await rejection
      })
    }

    expect(result.current.activeChatId).toBe('chat-a')
    expect(result.current.chatMessages).toEqual(cachedMessages)
    expect(result.current.chatMessagesLoading).toBe(false)
  })

  it('observes an early persistence rejection while the cache read is still pending', async () => {
    const lastActive = deferred<void>()
    const cache = deferred<typeof cachedMessages>()
    const failure = new Error('Last-active write failed before the cache read')
    clerum.chat.setLastActive.mockReturnValueOnce(lastActive.promise)
    clerum.chat.loadMessages.mockReturnValueOnce(cache.promise)
    const { result } = renderController()
    await settleMount()
    let selection!: Promise<void>
    let rejected = false
    let rejection!: Promise<void>

    await act(async () => {
      selection = result.current.switchToChat('agent-x', 'chat-a')
      rejection = expect(selection)
        .rejects.toBe(failure)
        .then(() => {
          rejected = true
        })
      lastActive.reject(failure)
    })
    try {
      expect(clerum.chat.loadMessages).toHaveBeenCalledWith('agent-x', 'chat-a', 80, undefined)
      expect(rejected).toBe(false)
      expect(result.current.chatMessagesLoading).toBe(true)
    } finally {
      await act(async () => {
        cache.resolve(cachedMessages)
        await rejection
      })
    }

    expect(rejected).toBe(true)
    expect(result.current.chatMessages).toEqual(cachedMessages)
  })

  it('keeps a superseded selection persistence error attached to its own promise', async () => {
    const lastActive = deferred<void>()
    const failure = new Error('Chat A last-active write failed')
    const chatBMessages = [{ id: 'b-user', role: 'user' as const, content: 'Chat B', timestamp: 3 }]
    clerum.chat.setLastActive.mockReturnValueOnce(lastActive.promise)
    clerum.chat.loadMessages.mockImplementation(async (_agentRef: string, chatId: string) =>
      chatId === 'chat-a' ? cachedMessages : chatBMessages
    )
    const { result } = renderController()
    await settleMount()
    let selectionA!: Promise<void>

    await act(async () => {
      selectionA = result.current.switchToChat('agent-x', 'chat-a')
    })
    const rejection = expect(selectionA).rejects.toBe(failure)
    try {
      await waitFor(() => expect(result.current.chatMessages).toEqual(cachedMessages))
      await act(async () => {
        await result.current.switchToChat('agent-x', 'chat-b')
      })
      expect(result.current.activeChatId).toBe('chat-b')
      expect(result.current.chatMessages).toEqual(chatBMessages)
      expect(clerum.chat.setLastActive.mock.calls.map(call => call.slice(0, 2))).toEqual([
        ['agent-x', 'chat-a'],
        ['agent-x', 'chat-b'],
      ])
    } finally {
      await act(async () => {
        lastActive.reject(failure)
        await rejection
      })
    }

    expect(result.current.activeChatId).toBe('chat-b')
    expect(result.current.chatMessages).toEqual(chatBMessages)
  })

  it('checks a blocked Host before reading cached messages', async () => {
    const isHostAccessBlocked = vi.fn(() => false)
    const { result } = renderController({ isHostAccessBlocked })
    await settleMount()
    isHostAccessBlocked.mockReturnValue(true)
    isHostAccessBlocked.mockClear()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-a')
    })

    expect(isHostAccessBlocked).toHaveBeenCalledWith('agent-x')
    expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
  })

  it('checks a durable deleted-chat tombstone before reading cached messages', async () => {
    const isHostAccessBlocked = vi.fn(() => false)
    clerum.chat.getIndex.mockResolvedValue(
      localIndex([{ id: 'chat-b', title: 'Chat B' }], ['chat-a'])
    )
    const { result } = renderController({ isHostAccessBlocked })
    await waitFor(() => expect(result.current.chatList.map(chat => chat.id)).toEqual(['chat-b']))
    expect(clerum.chat.getIndex).toHaveBeenCalledWith('agent-x')
    isHostAccessBlocked.mockClear()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-a')
    })

    expect(isHostAccessBlocked).toHaveBeenCalledWith('agent-x')
    expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
  })

  it('rechecks Host access after starting persistence and awaits it even when the guard returns', async () => {
    const isHostAccessBlocked = vi.fn(() => false)
    const lastActive = deferred<void>()
    clerum.chat.setLastActive.mockImplementationOnce(() => {
      isHostAccessBlocked.mockReturnValue(true)
      return lastActive.promise
    })
    const { result } = renderController({ isHostAccessBlocked })
    await settleMount()
    let selection!: Promise<void>
    let completed = false

    await act(async () => {
      selection = result.current.switchToChat('agent-x', 'chat-a').then(() => {
        completed = true
      })
    })
    try {
      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'chat-a')
      expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
      expect(completed).toBe(false)
    } finally {
      await act(async () => {
        lastActive.resolve()
        await selection
      })
    }

    expect(completed).toBe(true)
  })
})
