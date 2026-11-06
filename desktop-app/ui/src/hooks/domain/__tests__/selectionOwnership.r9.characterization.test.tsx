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

describe('Round 9 selection ownership', () => {
  it('keeps an implicit latest load when a same-agent no-chat notification arrives first', async () => {
    await clerum.chat.create('agent-x', 'chat-newest')
    await clerum.chat.upsertMessages('agent-x', 'chat-newest', [
      { id: 'newest-message', role: 'user', content: 'newest history', timestamp: 1 },
    ])
    const index = await clerum.readIndex('agent-x')
    const indexLoad = deferred<Awaited<ReturnType<typeof clerum.chat.getIndex>>>()
    clerum.chat.getIndex.mockReturnValue(indexLoad.promise)
    const controller = renderController({ navItem: 'chat', loadMenuData: false })

    try {
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
      expect(controller.result.current.activeChatId).toBeNull()

      act(() => controller.result.current.setPendingChatSelection('agent-x', null))

      await act(async () => {
        indexLoad.resolve(index)
      })

      await waitFor(() => {
        expect(controller.result.current.activeChatId).toBe('chat-newest')
        expect(controller.result.current.chatMessages).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'newest-message' })])
        )
        expect(controller.result.current.chatMessagesLoading).toBe(false)
      })
    } finally {
      indexLoad.resolve(index)
      controller.unmount()
    }
  })
})
