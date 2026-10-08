// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

function holdLastActive(chatId: string) {
  const original = clerum.chat.setLastActive.getMockImplementation()
  if (!original) throw new Error('Expected the setLastActive test implementation')
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

describe('Round 7 selection loading ownership', () => {
  it('settles a held implicit switch when a newer no-chat intent arrives', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const heldSwitch = holdLastActive('chat-a')
    const controller = renderController({ navItem: 'chat', loadMenuData: false })

    try {
      await act(async () => {
        await heldSwitch.entered.promise
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      act(() => controller.result.current.setPendingChatSelection('agent-x', null))

      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(controller.result.current.chatMessages).toEqual([])

      await act(async () => {
        heldSwitch.release.resolve()
        await heldSwitch.returned.promise
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(controller.result.current.chatMessages).toEqual([])
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await heldSwitch.returned.promise
      })
      controller.unmount()
    }
  })
  it('loads a newer specific chat when it supersedes a held implicit switch', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    await clerum.chat.create('agent-x', 'chat-a')
    clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
    const heldSwitch = holdLastActive('chat-a')
    const controller = renderController({ navItem: 'chat', loadMenuData: false })

    try {
      await act(async () => {
        await heldSwitch.entered.promise
      })
      act(() => controller.result.current.setPendingChatSelection('agent-x', 'chat-b'))

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      await act(async () => {
        heldSwitch.release.resolve()
        await heldSwitch.returned.promise
      })
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
      )
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await heldSwitch.returned.promise
      })
      controller.unmount()
    }
  })

  it('settles the current spinner when a newer chat switch is Host-blocked', async () => {
    await clerum.chat.create('agent-x', 'chat-a')
    await clerum.chat.create('agent-x', 'chat-b')
    const heldSwitch = holdLastActive('chat-a')
    let hostBlocked = false
    const controller = renderController(
      {
        isHostAccessBlocked: () => hostBlocked,
        loadMenuData: false,
      },
      {}
    )
    let switchPromise!: Promise<void>

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        switchPromise = controller.result.current.switchToChat('agent-x', 'chat-a')
      })
      await act(async () => {
        await heldSwitch.entered.promise
      })
      expect(controller.result.current.chatMessagesLoading).toBe(true)

      hostBlocked = true
      await act(async () => {
        await controller.result.current.switchToChat('agent-x', 'chat-b')
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessagesLoading).toBe(false)

      await act(async () => {
        heldSwitch.release.resolve()
        await switchPromise
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(clerum.chat.loadMessages).not.toHaveBeenCalled()
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })

  it('restores a same-tick chat switch when New chat creation fails', async () => {
    await clerum.chat.create('agent-x', 'chat-b')
    await clerum.chat.upsertMessages('agent-x', 'chat-b', [
      { id: 'chat-b-message', role: 'user', content: 'chat B history', timestamp: 2 },
    ])
    const heldSwitch = holdLastActive('chat-b')
    const controller = renderController({ loadMenuData: false })
    const createError = new Error('local chat creation failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    let switchPromise!: Promise<void>
    let createPromise!: Promise<void>
    let observedError: unknown

    try {
      await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
      act(() => {
        switchPromise = controller.result.current.handleSelectChat('chat-b')
        createPromise = controller.result.current.handleCreateChat().catch(error => {
          observedError = error
        })
      })
      await act(async () => {
        await heldSwitch.entered.promise
      })
      await act(async () => {
        await createPromise
      })
      expect(observedError).toBe(createError)

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-b')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'chat-b-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })

      await act(async () => {
        heldSwitch.release.resolve()
        await switchPromise
      })
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    } finally {
      heldSwitch.release.resolve()
      await act(async () => {
        await switchPromise?.catch(() => undefined)
      })
      controller.unmount()
    }
  })
})
