// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  uninstallMockClerum()
})

describe('failed New chat selection ownership', () => {
  it('does not restore an older target after the user selects a newer chat', async () => {
    await clerum.chat.create('agent-x', 'target')
    await clerum.chat.upsertMessages('agent-x', 'target', [
      { id: 'target-message', role: 'user', content: 'old target', timestamp: 1 },
    ])
    await clerum.chat.create('agent-x', 'newer-click')
    await clerum.chat.upsertMessages('agent-x', 'newer-click', [
      { id: 'newer-message', role: 'user', content: 'newer navigation', timestamp: 2 },
    ])
    const targetIndex = await clerum.readIndex('agent-x')
    const controller = renderController({ navItem: 'agents', loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))

    const indexCallCount = clerum.chat.getIndex.mock.calls.length
    const heldIndex = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(heldIndex.promise)
    await act(async () => {
      controller.result.current.setPendingChatSelection('agent-x', 'target')
      controller.rerender({ navItem: 'chat' })
    })
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(indexCallCount)
    )

    const createFailure = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
    clerum.chat.create.mockReturnValueOnce(createFailure.promise)
    let createPromise!: Promise<void>
    act(() => {
      createPromise = controller.result.current.handleCreateChat()
    })
    await waitFor(() => expect(clerum.chat.create).toHaveBeenCalled())

    await act(async () => {
      await controller.result.current.handleSelectChat('newer-click')
    })
    expect(controller.result.current.activeChatId).toBe('newer-click')
    expect(controller.result.current.chatMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'newer-message' })])
    )

    const createError = new Error('local chat creation failed')
    await act(async () => {
      createFailure.reject(createError)
      await createPromise.catch(error => expect(error).toBe(createError))
      heldIndex.resolve(targetIndex)
    })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))

    expect(controller.result.current.activeChatId).toBe('newer-click')
    expect(controller.result.current.chatMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'newer-message' })])
    )
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    controller.unmount()
  })
})
