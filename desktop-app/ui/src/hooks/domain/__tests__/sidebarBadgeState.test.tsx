// @vitest-environment jsdom
/**
 * D.5 review #1 — the sidebar "Running"/"Awaiting" badge must reflect a LIVE
 * local task immediately (the tracker bridges into sessionStateByChatId), not
 * only stale server snapshots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
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

describe('sidebar session-state bridge (D.5 review #1)', () => {
  it('flips the chat to processing on send and back to idle on terminal', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-live' })
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('hi')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-live')).toBe(true))
    await sendPromise

    const chatId = result.current.activeChatId!
    expect(chatId).toBeTruthy()
    // Live task → sidebar state is 'processing' (drives the Running badge).
    expect(result.current.sessionStateByChatId[chatId]?.state).toBe('processing')

    await act(async () => {
      clerum.emitTaskProgress('task-live', {
        type: 'open',
        taskId: 'task-live',
        hostRef: 'agent-x',
      })
      clerum.emitTaskProgress('task-live', {
        type: 'terminal',
        data: { taskId: 'task-live', status: 'completed' },
      })
    })

    await waitFor(() => expect(result.current.sessionStateByChatId[chatId]?.state).toBe('idle'))
  })
})
