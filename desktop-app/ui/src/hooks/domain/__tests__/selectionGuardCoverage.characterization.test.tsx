// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { parseSessionsListResult } from '../../../../../src/rpcProxyClient'
import { makeTaskKey } from '../../../contexts/AgentTaskTrackerContext/types'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { deferred, serverSessionMessages } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const remoteCatalog = () =>
  parseSessionsListResult({
    items: [
      {
        agent: 'agent-x',
        chatId: 'catalog-latest',
        turnCount: 1,
        lastActivityAt: '2099-05-03T00:00:00Z',
      },
      {
        agent: 'agent-x',
        chatId: 'catalog-older',
        turnCount: 1,
        lastActivityAt: '2098-05-03T00:00:00Z',
      },
    ],
  })

const imageForNextAgent: ComposerImageAttachment = {
  id: 'agent-y-image',
  name: 'agent-y.png',
  mimeType: 'image/png',
  dataBase64: 'eQ==',
  sizeBytes: 1,
  previewDataUrl: 'data:image/png;base64,eQ==',
}

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

async function waitForListIdle(controller: ReturnType<typeof renderController>) {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
}

async function startSpecificIndexLoad(
  controller: ReturnType<typeof renderController>,
  chatId: string
) {
  const callCount = clerum.chat.getIndex.mock.calls.length
  const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
  clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
  await act(async () => {
    controller.result.current.setPendingChatSelection('agent-x', chatId)
    controller.rerender({ navItem: 'chat' })
  })
  await waitFor(() => expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(callCount))
  return { heldIndex, chatIndex: await clerum.readIndex('agent-x') }
}

function holdSessionMessages(chatId: string) {
  const original = clerum.rpc.loadSessionMessages.getMockImplementation()
  if (!original) throw new Error('Expected the loadSessionMessages test mock implementation')
  const entered = deferred<void>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let held = false
  clerum.rpc.loadSessionMessages.mockImplementation(async (...args) => {
    const requestedChatId = args[2]
    if (requestedChatId === chatId && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    const result = await original(...args)
    if (held && requestedChatId === chatId) returned.resolve()
    return result
  })
  return { entered, release, returned }
}

function holdLastActive(chatId: string) {
  const original = clerum.chat.setLastActive.getMockImplementation()
  if (!original) throw new Error('Expected the setLastActive test mock implementation')
  const entered = deferred<void>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let held = false
  clerum.chat.setLastActive.mockImplementation(async (agentRef, selectedChatId) => {
    if (agentRef === 'agent-x' && selectedChatId === chatId && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    await original(agentRef, selectedChatId)
    if (held && selectedChatId === chatId) returned.resolve()
  })
  return { entered, release, returned }
}

function holdLocalMessages(chatId: string) {
  const original = clerum.chat.loadMessages.getMockImplementation()
  if (!original) throw new Error('Expected the ChatStore loadMessages producer')
  const entered = deferred<void>()
  const release = deferred<void>()
  const returned = deferred<void>()
  let held = false
  clerum.chat.loadMessages.mockImplementation(async (agentRef, requestedChatId, limit, offset) => {
    if (agentRef === 'agent-x' && requestedChatId === chatId && !held) {
      held = true
      entered.resolve()
      await release.promise
    }
    const messages = await original(agentRef, requestedChatId, limit, offset)
    if (held && requestedChatId === chatId) returned.resolve()
    return messages
  })
  return { entered, release, returned }
}

describe('selection intent and continuation guards', () => {
  it.each(['latest', 'implicit'] as const)(
    'keeps a requested chat loading when an older %s auto-select finishes late',
    async mode => {
      await clerum.chat.create('agent-x', 'chat-b')
      await clerum.chat.upsertMessages('agent-x', 'chat-b', [
        { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 1 },
      ])
      await clerum.chat.create('agent-x', 'chat-a')
      await clerum.chat.upsertMessages('agent-x', 'chat-a', [
        { id: 'chat-a-message', role: 'user', content: 'chat A history', timestamp: 2 },
      ])
      clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
      const heldAutoSelect = holdLastActive('chat-a')
      const heldRequestedHistory = holdLocalMessages('chat-b')
      const controller = renderController({
        navItem: mode === 'latest' ? 'agents' : 'chat',
        loadMenuData: false,
      })
      let requestedSwitch: Promise<void> | undefined

      try {
        if (mode === 'latest') {
          await waitForListIdle(controller)
          await act(async () => {
            controller.result.current.setPendingChatSelection('agent-x', null, {
              selectLatest: true,
            })
            controller.rerender({ navItem: 'chat' })
          })
        }

        await act(async () => {
          await heldAutoSelect.entered.promise
        })
        await waitFor(() => {
          expect(controller.result.current.activeChatId).toBe('chat-a')
          expect(controller.result.current.chatMessagesLoading).toBe(true)
        })

        act(() => {
          requestedSwitch = controller.result.current.handleSelectChat('chat-b')
        })
        await act(async () => {
          await heldRequestedHistory.entered.promise
        })
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual([])
        expect(controller.result.current.chatMessagesLoading).toBe(true)

        await act(async () => {
          heldAutoSelect.release.resolve()
          await heldAutoSelect.returned.promise
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual([])
        expect(controller.result.current.chatMessagesLoading).toBe(true)

        if (!requestedSwitch) throw new Error('Expected the requested chat switch')
        await act(async () => {
          heldRequestedHistory.release.resolve()
          await heldRequestedHistory.returned.promise
          await requestedSwitch
        })
        await waitFor(() => {
          expect(controller.result.current.activeChatId).toBe('chat-b')
          expect(controller.result.current.chatMessages).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
          )
          expect(controller.result.current.chatMessagesLoading).toBe(false)
        })
      } finally {
        heldAutoSelect.release.resolve()
        heldRequestedHistory.release.resolve()
        await act(async () => {
          await heldAutoSelect.returned.promise
          await requestedSwitch?.catch(() => undefined)
        })
        controller.unmount()
      }
    }
  )

  it('keeps a matching pending selection across a direct switch and route change', async () => {
    await clerum.chat.create('agent-x', 'requested-chat')
    await clerum.chat.upsertMessages('agent-x', 'requested-chat', [
      { id: 'requested-message', role: 'user', content: 'requested history', timestamp: 1 },
    ])
    clerum.rpc.listSessions.mockResolvedValue(remoteCatalog())

    const controller = renderController({ navItem: 'sandbox-ui' })
    await waitForListIdle(controller)
    const callCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)

    let directSwitch!: Promise<void>
    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', 'requested-chat')
      directSwitch = controller.result.current.switchToChat('agent-x', 'requested-chat')
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() => expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(callCount))
    await act(async () => {
      await directSwitch
    })
    expect(controller.result.current.activeChatId).toBe('requested-chat')

    await act(async () => {
      heldIndex.resolve(await clerum.readIndex('agent-x'))
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await waitFor(() =>
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'requested-message', content: 'requested history' }),
        ])
      )
    )
    expect(controller.result.current.activeChatId).toBe('requested-chat')
    controller.unmount()
  })

  it('lets a newer pending specific selection supersede the old list request', async () => {
    await clerum.chat.create('agent-x', 'older-selection')
    await clerum.chat.create('agent-x', 'newer-selection')
    const controller = renderController({ navItem: 'agents' })
    await waitForListIdle(controller)
    const { heldIndex, chatIndex } = await startSpecificIndexLoad(controller, 'older-selection')

    act(() => controller.result.current.setPendingChatSelection('agent-x', 'newer-selection'))
    expect(controller.result.current.activeChatId).toBe('newer-selection')
    expect(controller.result.current.chatMessagesLoading).toBe(true)

    await act(async () => {
      heldIndex.resolve(chatIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    expect(controller.result.current.activeChatId).toBe('newer-selection')
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(true)
    controller.unmount()
  })

  it('keeps clearActiveChat blank when a prior specific index resolves', async () => {
    await clerum.chat.create('agent-x', 'cleared-chat')
    const controller = renderController({ navItem: 'agents' })
    await waitForListIdle(controller)
    const { heldIndex, chatIndex } = await startSpecificIndexLoad(controller, 'cleared-chat')

    act(() => controller.result.current.clearActiveChat())
    await act(async () => {
      heldIndex.resolve(chatIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    expect(controller.result.current.activeChatId).toBeNull()
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    controller.unmount()
  })

  it('keeps resetChat blank when a prior specific index resolves', async () => {
    await clerum.chat.create('agent-x', 'reset-chat')
    const controller = renderController({ navItem: 'agents' })
    await waitForListIdle(controller)
    const { heldIndex, chatIndex } = await startSpecificIndexLoad(controller, 'reset-chat')

    act(() => controller.result.current.resetChat())
    await act(async () => {
      heldIndex.resolve(chatIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    expect(controller.result.current.activeChatId).toBeNull()
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    controller.unmount()
  })

  it.each(['latest', 'implicit'] as const)(
    'does not let an older %s completion clear a newer selection spinner',
    async mode => {
      clerum.rpc.listSessions.mockResolvedValue(remoteCatalog())
      clerum.rpc.loadSessionMessages.mockResolvedValue(
        await serverSessionMessages('agent-x', 'catalog-latest')
      )
      const heldSession = holdSessionMessages('catalog-latest')
      const observedLoading: boolean[] = []
      const controller = renderController(
        {
          navItem: mode === 'latest' ? 'agents' : 'chat',
          loadMenuData: false,
        },
        { onLayoutCommit: view => observedLoading.push(view.chatMessagesLoading) }
      )
      if (mode === 'latest') {
        await waitForListIdle(controller)
        await act(async () => {
          controller.result.current.setPendingChatSelection('agent-x', null, {
            selectLatest: true,
          })
          controller.rerender({ navItem: 'chat' })
        })
      }
      try {
        await heldSession.entered.promise
        const latestKey = makeTaskKey('agent-x', 'catalog-latest')
        expect(controller.result.current.sessionStateByChatKey[latestKey]?.syncing).toBe(true)
        expect(controller.result.current.activeChatId).toBe('catalog-latest')
        expect(controller.result.current.chatMessagesLoading).toBe(false)

        const loadingObservationStart = observedLoading.length
        act(() => controller.result.current.setPendingChatSelection('agent-x', 'newer-chat'))
        expect(controller.result.current.activeChatId).toBe('newer-chat')
        expect(controller.result.current.chatMessagesLoading).toBe(true)

        await act(async () => {
          heldSession.release.resolve()
          await heldSession.returned.promise
        })
        await waitFor(() =>
          expect(controller.result.current.sessionStateByChatKey[latestKey]?.syncing).toBe(false)
        )
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(controller.result.current.activeChatId).toBe('newer-chat')
        expect(controller.result.current.chatMessages).toEqual([])
        expect(controller.result.current.chatMessagesLoading).toBe(true)
        expect(observedLoading.slice(loadingObservationStart)).not.toContain(false)
      } finally {
        heldSession.release.resolve()
        controller.unmount()
      }
    }
  )

  it('skips stale local history after a newer selection wins during setLastActive', async () => {
    await clerum.chat.create('agent-x', 'slow-chat')
    await clerum.chat.create('agent-x', 'newer-chat')
    const heldLastActive = holdLastActive('slow-chat')
    const controller = renderController()
    await waitForListIdle(controller)

    let switchPromise!: Promise<void>
    act(() => {
      switchPromise = controller.result.current.switchToChat('agent-x', 'slow-chat')
    })
    await heldLastActive.entered.promise
    act(() => controller.result.current.setPendingChatSelection('agent-x', 'newer-chat'))
    expect(controller.result.current.activeChatId).toBe('newer-chat')

    await act(async () => {
      heldLastActive.release.resolve()
      await switchPromise
    })
    expect(controller.result.current.activeChatId).toBe('newer-chat')
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(true)
    expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
    controller.unmount()
  })

  it('does not expose cached history when Host authority becomes uncertain after setLastActive', async () => {
    await clerum.chat.create('agent-x', 'guarded-chat')
    await clerum.chat.upsertMessages('agent-x', 'guarded-chat', [
      {
        id: 'protected-local-message',
        role: 'user',
        content: 'cached history under review',
        timestamp: 1,
      },
    ])
    const heldLastActive = holdLastActive('guarded-chat')
    const controller = renderController()
    await waitForListIdle(controller)

    let switchPromise!: Promise<void>
    act(() => {
      switchPromise = controller.result.current.switchToChat('agent-x', 'guarded-chat')
    })
    await heldLastActive.entered.promise
    controller.hostAuthority.hold('agent-x', 'uncertain')
    expect(controller.hostAuthority.isBlocked('agent-x')).toBe(true)

    await act(async () => {
      heldLastActive.release.resolve()
      await switchPromise
    })
    expect(controller.result.current.activeChatId).toBe('guarded-chat')
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(true)
    expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
    controller.unmount()
  })

  it('preserves the next agent attachment when the prior agent send finishes', async () => {
    await clerum.chat.create('agent-x', 'agent-x-chat')
    const controller = renderController({ agentNames: ['agent-x', 'agent-y'] })
    await waitForListIdle(controller)
    await act(async () => {
      await controller.result.current.switchToChat('agent-x', 'agent-x-chat')
    })

    const originalUpsert = clerum.chat.upsertMessages.getMockImplementation()
    if (!originalUpsert) throw new Error('Expected the real ChatStore upsertMessages producer')
    const enteredUpsert = deferred<void>()
    const releaseUpsert = deferred<void>()
    clerum.chat.upsertMessages.mockImplementation(async (agentRef, chatId, messages) => {
      if (agentRef === 'agent-x' && chatId === 'agent-x-chat') {
        enteredUpsert.resolve()
        await releaseUpsert.promise
      }
      return originalUpsert(agentRef, chatId, messages)
    })

    act(() => setComposerDraft('agent-x-chat', 'send from agent x', 'agent-x'))
    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = controller.result.current.handleSendAgentMessage('send from agent x')
    })
    try {
      await enteredUpsert.promise
      controller.rerender({ selectedAgent: 'agent-y', agentNames: ['agent-x', 'agent-y'] })
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => controller.result.current.handleAddComposerImageAttachments([imageForNextAgent]))
      expect(controller.result.current.composerImageAttachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: imageForNextAgent.id })])
      )

      await act(async () => {
        releaseUpsert.resolve()
        await sendPromise
      })
      expect(getComposerDraft('agent-x-chat', 'agent-x')).toBe('')
      expect(controller.result.current.composerImageAttachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: imageForNextAgent.id })])
      )
    } finally {
      releaseUpsert.resolve()
      await act(async () => {
        await sendPromise.catch(() => undefined)
      })
      controller.unmount()
    }
  })
})
