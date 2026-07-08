// @vitest-environment jsdom
/**
 * D.4 AC11 / D.5 — a "ghost" terminal (progress stream closes without a terminal
 * event; the task may have died unreported) offers a one-click Resend of the
 * original input via the composer's failedAgentSend affordance.
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

describe('ghost-terminal Resend (D.4 AC11)', () => {
  it('exposes failedAgentSend with the original input when the stream closes without a terminal', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-ghost' })
    // Ghost terminal = task died unreported with NO durable per-task result, so
    // the Fix B durable-result fallback can't recover it → Resend affordance.
    clerum.rpc.getTaskResult.mockRejectedValue(new Error('404 not found'))
    const { result } = renderController()
    await settleMount()

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('please summarize the doc')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-ghost')).toBe(true))
    await sendPromise

    // Stream closes with no terminal event → tracker fires a 'stream' terminal.
    await act(async () => {
      clerum.emitTaskProgress('task-ghost', { type: 'closed' })
    })

    await waitFor(() => expect(result.current.failedAgentSend).not.toBeNull())
    expect(result.current.failedAgentSend?.content).toBe('please summarize the doc')
    expect(result.current.agentError).toBeTruthy()
  })

  it('does not append a ghost assistant message (stream terminal stays silent)', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-ghost-2' })
    // Ghost terminal = task died unreported with NO durable per-task result.
    clerum.rpc.getTaskResult.mockRejectedValue(new Error('404 not found'))
    const { result } = renderController()
    await settleMount()

    const sendPromise = act(async () => {
      await result.current.handleSendAgentMessage('hello')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-ghost-2')).toBe(true))
    await sendPromise

    const appendCallsBefore = clerum.chat.appendMessages.mock.calls.length
    await act(async () => {
      clerum.emitTaskProgress('task-ghost-2', { type: 'closed' })
    })
    await waitFor(() => expect(result.current.failedAgentSend).not.toBeNull())

    // No assistant reply persisted for the ghost terminal (D.3 behavior preserved).
    expect(clerum.chat.appendMessages.mock.calls.length).toBe(appendCallsBefore)
  })
})
