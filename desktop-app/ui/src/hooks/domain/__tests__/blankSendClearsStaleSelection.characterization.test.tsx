// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { deferred } from './__fixtures__/catalogFixtures'
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
  clerum.chat.getIndex.mockImplementation(agentRef => clerum.readIndex(agentRef))
  clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'accepted reply' })
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('blank send clears stale pending selection', () => {
  it('selects the send-created chat after leaving and returning to chat', async () => {
    const controller = renderController({ navItem: 'chat', loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    act(() => {
      controller.result.current.setPendingChatSelection('agent-x', null, {
        suppressAutoSelect: true,
      })
      controller.result.current.clearActiveChat()
    })
    expect(controller.result.current.activeChatId).toBeNull()

    await act(async () => {
      await controller.result.current.handleSendAgentMessage('start the next conversation')
    })
    const createdChatId = controller.result.current.activeChatId
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
    controller.rerender({ navItem: 'agents' })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )
    controller.rerender({ navItem: 'chat' })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount + 1)
    )
    await act(async () => {
      heldIndex.resolve(routeIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await waitFor(() => expect(controller.result.current.activeChatId).toBe(createdChatId))
    expect(controller.result.current.chatMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'start the next conversation' }),
        expect.objectContaining({ content: 'accepted reply' }),
      ])
    )
    controller.unmount()
  })
})
