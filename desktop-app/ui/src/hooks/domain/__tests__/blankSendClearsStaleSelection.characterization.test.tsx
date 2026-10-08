// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let controller: ReturnType<typeof renderController> | undefined
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
  clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
  clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'accepted reply' })
})

afterEach(() => {
  controller?.unmount()
  controller = undefined
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('blank send clears stale pending selection', () => {
  it('selects the send-created chat after leaving and returning to chat', async () => {
    const currentController = renderController({ navItem: 'chat', loadMenuData: false })
    controller = currentController
    await waitFor(() => expect(currentController.result.current.chatListLoading).toBe(false))

    act(() => {
      currentController.result.current.setPendingChatSelection('agent-x', null, {
        suppressAutoSelect: true,
      })
      currentController.result.current.clearActiveChat()
    })
    expect(currentController.result.current.activeChatId).toBeNull()

    await act(async () => {
      await currentController.result.current.handleSendAgentMessage('start the next conversation')
    })
    const createdChatId = currentController.result.current.activeChatId
    expect(createdChatId).toMatch(/^uuid-/)
    expect(await clerum.persistedMessages('agent-x', createdChatId!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'start the next conversation' }),
        expect.objectContaining({ role: 'assistant', content: 'accepted reply' }),
      ])
    )

    const routeIndex = await clerum.readIndex('agent-x')
    const indexCallCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
    currentController.rerender({ navItem: 'agents' })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )
    currentController.rerender({ navItem: 'chat' })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount + 1)
    )
    await act(async () => {
      heldIndex.resolve(routeIndex)
    })
    await waitFor(() =>
      expect(currentController.result.current.chatMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'start the next conversation' }),
          expect.objectContaining({ content: 'accepted reply' }),
        ])
      )
    )
    expect(currentController.result.current.activeChatId).toBe(createdChatId)
  })
})
