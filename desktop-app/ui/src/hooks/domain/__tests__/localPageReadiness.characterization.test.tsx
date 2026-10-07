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
  vi.useRealTimers()
  uninstallMockClerum()
})

describe('same-chat local page readiness', () => {
  it('keeps the transcript when same-chat reopen starts before passive ref synchronization', async () => {
    const chatId = 'same-chat'
    await clerum.chat.create('agent-x', chatId)
    await clerum.chat.upsertMessages('agent-x', chatId, [
      {
        id: 'local-turn-5',
        role: 'user',
        content: 'visible cached question',
        timestamp: 5,
        serverTurnNumber: 5,
      },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId,
      state: 'idle',
      totalTurns: 5,
      turns: [],
    })

    const originalSetLastActive = clerum.chat.setLastActive.getMockImplementation()
    if (!originalSetLastActive) throw new Error('Expected the ChatStore setLastActive producer')
    const secondCallEntered = deferred<void>()
    const releaseSecondCall = deferred<void>()
    let setLastActiveCalls = 0
    clerum.chat.setLastActive.mockImplementation(async (agentRef, selectedChatId) => {
      setLastActiveCalls += 1
      if (agentRef === 'agent-x' && selectedChatId === chatId && setLastActiveCalls === 2) {
        secondCallEntered.resolve()
        queueMicrotask(() => releaseSecondCall.resolve())
        await releaseSecondCall.promise
      }
      await originalSetLastActive(agentRef, selectedChatId)
    })

    let reopened = false
    let secondSwitch: Promise<void> | undefined
    const controller = renderController(
      {},
      {
        onLayoutCommit: view => {
          if (
            !reopened &&
            view.activeChatId === chatId &&
            view.chatMessages.some(message => message.id === 'local-turn-5')
          ) {
            reopened = true
            secondSwitch = view.switchToChat('agent-x', chatId)
          }
        },
      }
    )
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())

    await act(async () => {
      await controller.result.current.switchToChat('agent-x', chatId)
    })
    await secondCallEntered.promise
    if (!secondSwitch) throw new Error('Expected the layout observer to request a second switch')
    await secondSwitch

    expect(controller.result.current.activeChatId).toBe(chatId)
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'local-turn-5', content: 'visible cached question' }),
    ])
    expect(clerum.chat.loadMessages).toHaveBeenCalledTimes(2)
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      chatId,
      undefined,
      { limit: 40, afterTurn: 4 }
    )
    controller.unmount()
  })
})
