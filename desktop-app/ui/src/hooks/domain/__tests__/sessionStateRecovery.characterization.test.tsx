// @vitest-environment jsdom
/**
 * Characterization tests for session-state recovery wiring not covered by the
 * SR-* suite:
 *  - onResumed → the per-chat badge settles awaiting_approval → processing
 *    (controller-level wiring of the tracker callback);
 *  - a stream loss on a chat that is NOT visible → setIdle + unread badge
 *    (deferred recovery), never a foreground rejoin;
 *  - recoverFromDurableTaskResult reached via the reconcile CATCH branch (the
 *    session-messages fetch throws a non-404) — distinct from SR-7/SR-8 which
 *    reach it via the idle-no-turn branch.
 *
 * See .specs/refactor-useAgentChatController/plan.md Fase 0 + spec.md A.4.6/A.4.7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
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

describe('onResumed wiring (controller)', () => {
  it('settles the per-chat badge awaiting_approval → processing when the tool resumes', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-res' })
    const { result } = renderController()
    await settleMount()

    const sendPromise = result.current.handleSendAgentMessage('run shell').catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-res')).toBe(true))
    const chatId = result.current.activeChatId!
    const key = makeTaskKey('agent-x', chatId)

    await act(async () => {
      clerum.emitTaskProgress('task-res', { type: 'open', taskId: 'task-res', hostRef: 'agent-x' })
      clerum.emitTaskProgress('task-res', {
        type: 'suspended',
        data: { taskId: 'task-res', requestId: 'req-1', displayName: 'Shell', reason: 'approval' },
      })
    })
    await waitFor(() =>
      expect(result.current.sessionStateByChatKey[key]?.state).toBe('awaiting_approval')
    )

    // The approval is decided somewhere → the stream resumes with a tool_start.
    await act(async () => {
      clerum.emitTaskProgress('task-res', {
        type: 'tool_start',
        data: {
          toolCallId: 'tc-1',
          toolName: 'shell',
          displayName: 'Shell',
          iteration: 1,
          stepIndex: 0,
          totalSteps: 1,
        },
      })
    })

    await waitFor(() => expect(result.current.sessionStateByChatKey[key]?.state).toBe('processing'))
    expect(result.current.sessionStateByChatKey[key]?.pendingApproval).toBeUndefined()

    await act(async () => {
      clerum.emitTaskProgress('task-res', {
        type: 'terminal',
        data: { taskId: 'task-res', status: 'cancelled', reason: 'cleanup' },
      })
    })
    await sendPromise
  })
})

describe('onTrackerTerminal — chat not visible', () => {
  it('a stream loss on a background chat sets idle + marks it unread (no foreground rejoin)', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-bg' })
    const { result } = renderController()
    await settleMount()

    // Send on chat A (auto-created), leaving a live task.
    const sendPromise = result.current.handleSendAgentMessage('bg work').catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-bg')).toBe(true))
    const chatA = result.current.activeChatId!
    await sendPromise

    // Switch to another chat so A is no longer the visible chat.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'chat-b',
      state: 'idle',
      turns: [],
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
    })
    expect(result.current.activeChatId).toBe('chat-b')

    const subsBefore = clerum.rpc.subscribeTaskProgress.mock.calls.filter(
      (c: unknown[]) => c[1] === 'task-bg'
    ).length

    // Stream loss on the background task.
    await act(async () => {
      clerum.emitTaskProgress('task-bg', { type: 'error', message: 'stream dropped' })
    })

    // Deferred recovery: unread badge, no rejoin subscription, session idle.
    await waitFor(() =>
      expect(clerum.chat.markUnreadTerminal).toHaveBeenCalledWith('agent-x', chatA)
    )
    const subsAfter = clerum.rpc.subscribeTaskProgress.mock.calls.filter(
      (c: unknown[]) => c[1] === 'task-bg'
    ).length
    expect(subsAfter).toBe(subsBefore) // no foreground rejoin
    expect(result.current.sessionStateByChatKey[makeTaskKey('agent-x', chatA)]?.state).toBe('idle')
  })

  it('re-marks unread on a SECOND hidden terminal after the chat was opened in between (CHAT_OPENED resets the FSM flag)', async () => {
    // Regression (Fase 2b): the FSM `unreadTerminal` flag gates the mark_unread
    // effect. Without CHAT_OPENED resetting it on open, the flag stayed
    // write-once-true and a later hidden terminal never re-marked the badge.
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'done' })
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ taskId: 'task-1' })
    const { result } = renderController()
    await settleMount()

    // Send on chat A (auto-created), leaving a live task.
    const send1 = result.current.handleSendAgentMessage('first').catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-1')).toBe(true))
    const chatA = result.current.activeChatId!
    await send1

    // Switch away so A is hidden, then terminate task-1 → first unread mark.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'chat-b',
      state: 'idle',
      turns: [],
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
    })
    await act(async () => {
      clerum.emitTaskProgress('task-1', {
        type: 'terminal',
        data: { taskId: 'task-1', status: 'completed' },
      })
    })
    await waitFor(() =>
      expect(clerum.chat.markUnreadTerminal).toHaveBeenCalledWith('agent-x', chatA)
    )
    const marksAfterFirst = clerum.chat.markUnreadTerminal.mock.calls.filter(
      (c: unknown[]) => c[1] === chatA
    ).length

    // Open chat A (CHAT_OPENED resets the FSM unread flag), then send again and
    // switch away so A is hidden for a SECOND terminal.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: chatA,
      state: 'idle',
      turns: [],
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', chatA)
    })
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ taskId: 'task-2' })
    const send2 = result.current.handleSendAgentMessage('second').catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-2')).toBe(true))
    await send2
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: 'agent-x',
      chatId: 'chat-b',
      state: 'idle',
      turns: [],
    })
    await act(async () => {
      await result.current.switchToChat('agent-x', 'chat-b')
    })
    await act(async () => {
      clerum.emitTaskProgress('task-2', {
        type: 'terminal',
        data: { taskId: 'task-2', status: 'completed' },
      })
    })

    // The badge is re-marked: the flag was reset on open, so the second hidden
    // terminal is not suppressed.
    await waitFor(() =>
      expect(
        clerum.chat.markUnreadTerminal.mock.calls.filter((c: unknown[]) => c[1] === chatA).length
      ).toBeGreaterThan(marksAfterFirst)
    )
  })
})

describe('onTrackerTerminal — recover via reconcile catch', () => {
  it('renders a durable error when the session-messages reconcile throws (non-404)', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-catch' })
    // The reconcile fetch fails outright (not a 404) → the catch branch tries the
    // durable per-task result instead of the "Resend" UX.
    clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('boom'))
    clerum.rpc.getTaskResult.mockResolvedValue({
      status: 'completed',
      success: false,
      error: { code: 'BUDGET_EXCEEDED', message: 'Budget exceeded', provider: 'anthropic' },
    })
    const { result, spies } = renderController()
    await settleMount()

    const sendPromise = result.current.handleSendAgentMessage('spend').catch(() => undefined)
    await waitFor(() => expect(clerum.hasProgressHandler('task-catch')).toBe(true))
    await act(async () => {
      clerum.emitTaskProgress('task-catch', {
        type: 'open',
        taskId: 'task-catch',
        hostRef: 'agent-x',
      })
      clerum.emitTaskProgress('task-catch', { type: 'error', message: 'stream dropped' })
    })

    await waitFor(() => {
      const last = clerum.chat.appendMessages.mock.calls.at(-1)?.[2]?.[0] as
        | { isError?: boolean }
        | undefined
      expect(last?.isError).toBe(true)
    })
    const appended = clerum.chat.appendMessages.mock.calls.at(-1)?.[2] as
      | Array<{ isError?: boolean; errorCode?: string; content?: string }>
      | undefined
    expect(appended?.[0]?.errorCode).toBe('BUDGET_EXCEEDED')
    expect(appended?.[0]?.content).toBe('Budget exceeded')
    expect(spies.pushToast).toHaveBeenCalledWith(
      'Message to agent-x failed: Budget exceeded',
      'error'
    )
    // Recovered (not lost) → no scary Resend affordance.
    expect(result.current.failedAgentSend).toBeNull()
    await sendPromise
  })
})
