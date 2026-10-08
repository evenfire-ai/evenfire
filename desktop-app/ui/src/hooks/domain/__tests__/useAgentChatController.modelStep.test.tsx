// @vitest-environment jsdom
/**
 * #1044 — the controller side of **Retry model step**. A failed or lost task
 * whose Host session read carries a resumable model-step checkpoint is offered
 * as a continuation, never as Resend; a blocked checkpoint says why; a claimed
 * continuation is followed by the tracker; every row of the continuation POST
 * has its own outcome. Views and POST answers come from the C0 contract
 * fixtures, parsed by the same reader the main process uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ModelStepCheckpointView } from '../../../../../src/types'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'
import {
  CHECKPOINT_ID,
  CONTINUATION_TASK_ID,
  FAILED_TERMINAL,
  ORIGIN_PROMPT,
  ORIGIN_TASK_ID,
  checkpointReads,
  continueAnswer,
  sendAndFail as sendAndFailWith,
  sessionWith,
  checkpointView as view,
} from './__fixtures__/modelStepCheckpoint'

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

const sendAndFail = (checkpoint: ModelStepCheckpointView | undefined) =>
  sendAndFailWith(clerum, checkpoint)

describe('model-step checkpoint in the controller (#1044)', () => {
  it('offers a resumable checkpoint instead of Resend after a failed terminal', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))

    expect(checkpointReads(clerum)).toHaveLength(1)
    expect(result.current.modelStepCheckpoint).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      status: 'resumable',
      retryAvailable: true,
      version: 1,
    })
    expect(result.current.failedAgentSend).toBeNull()
    expect(result.current.agentError).toBeNull()
  })

  it('keeps Resend for a failed terminal without a checkpoint (control case)', async () => {
    const { result } = await sendAndFail(undefined)

    expect(checkpointReads(clerum)).toHaveLength(1)
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.failedAgentSend?.content).toBe(ORIGIN_PROMPT)
  })

  it('shows a blocked checkpoint with its reason and keeps Resend available', async () => {
    const { result } = await sendAndFail(view('session-view.blocked.json'))

    expect(result.current.modelStepCheckpoint).toMatchObject({
      status: 'blocked',
      retryAvailable: false,
      blockedReason: 'model_unavailable',
    })
    expect(result.current.failedAgentSend?.content).toBe(ORIGIN_PROMPT)
  })

  it('settles a lost stream as model_step_resumable without consulting the task result', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: ORIGIN_TASK_ID })
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith(view('session-view.resumable.json'))
    )
    const { result } = renderController()
    await settleMount()
    await act(async () => {
      await result.current.handleSendAgentMessage(ORIGIN_PROMPT)
    })
    await waitFor(() => expect(clerum.hasProgressHandler(ORIGIN_TASK_ID)).toBe(true))

    await act(async () => {
      clerum.emitTaskProgress(ORIGIN_TASK_ID, { type: 'closed' })
    })

    await waitFor(() => expect(result.current.modelStepCheckpoint?.status).toBe('resumable'))
    // Witness: the reconcile read the session, which is where the checkpoint came from.
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled()
    expect(clerum.rpc.getTaskResult).not.toHaveBeenCalled()
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('follows a claimed continuation found when the chat is opened', async () => {
    clerum.chat.loadMessages.mockResolvedValue([
      { id: 'turn-1-user', role: 'user' as const, content: ORIGIN_PROMPT, timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith(view('session-view.claimed.json'), 'c1')
    )
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.switchToChat('agent-x', 'c1')
    })

    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(clerum.rpc.subscribeTaskProgress).toHaveBeenCalledWith(
      'agent-x',
      CONTINUATION_TASK_ID,
      expect.any(Function)
    )
    expect(result.current.modelStepCheckpoint?.status).toBe('claimed')
  })

  it('retries the model step, follows the continuation, and clears the checkpoint on completion', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    const chatId = result.current.activeChatId
    expect(chatId).toBeTruthy()
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))

    await act(async () => {
      await result.current.handleRetryModelStep()
    })

    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      chatId,
      CHECKPOINT_ID,
      1
    )
    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(result.current.modelStepCheckpoint).toMatchObject({
      status: 'claimed',
      continuationTaskId: CONTINUATION_TASK_ID,
    })
    expect(result.current.failedAgentSend).toBeNull()
    // Retry model step is not Resend: no second user message goes out.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)

    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'continued after 21 tool results' })
    await act(async () => {
      clerum.emitTaskProgress(CONTINUATION_TASK_ID, {
        type: 'terminal',
        data: { status: 'completed' },
      })
    })

    await waitFor(() =>
      expect(
        result.current.chatMessages.some(
          message =>
            message.role === 'assistant' && message.content === 'continued after 21 tool results'
        )
      ).toBe(true)
    )
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('sends one continuation POST for two retries pressed while the first is in flight', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    // Every POST that goes out is answered, so a missing guard fails on the
    // call count instead of leaving a request hanging.
    const answers: Array<(value: ReturnType<typeof continueAnswer>) => void> = []
    clerum.rpc.continueModelStep.mockImplementation(
      () =>
        new Promise(resolve => {
          answers.push(resolve)
        })
    )

    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = result.current.handleRetryModelStep()
      second = result.current.handleRetryModelStep()
    })
    // While the first POST is pending the button shows its in-progress state.
    expect(result.current.modelStepRetry).toEqual({ pending: true, error: null })
    await act(async () => {
      for (const answer of answers) answer(continueAnswer('continue-response.claimed.json'))
      await Promise.all([first, second])
    })

    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(result.current.modelStepCheckpoint?.status).toBe('claimed')
    expect(result.current.modelStepRetry).toBeNull()

    // A third press once the continuation runs has no checkpoint to retry.
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
  })

  it('offers Retry model step again when the continuation also stops on the provider', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(result.current.modelStepCheckpoint?.status).toBe('claimed')

    // The Host keeps the same checkpoint resumable at the next version.
    const readsBefore = checkpointReads(clerum).length
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith({ ...view('session-view.resumable.json'), version: 2 })
    )
    await act(async () => {
      clerum.emitTaskProgress(CONTINUATION_TASK_ID, FAILED_TERMINAL)
    })

    await waitFor(() =>
      expect(result.current.modelStepCheckpoint).toMatchObject({
        checkpointId: CHECKPOINT_ID,
        status: 'resumable',
        retryAvailable: true,
        version: 2,
      })
    )
    // Witness: the notice came from a fresh session read, not the stale view.
    expect(checkpointReads(clerum).length).toBeGreaterThan(readsBefore)
    expect(result.current.failedAgentSend).toBeNull()
    // The user sees the continuation's failure as its own error reply.
    expect(
      clerum.chat.appendMessages.mock.calls.some(call =>
        (call[2] as Array<{ isError?: boolean; task_id?: string }>).some(
          message => message.isError === true && message.task_id === CONTINUATION_TASK_ID
        )
      )
    ).toBe(true)

    clerum.rpc.continueModelStep.mockClear()
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      result.current.activeChatId,
      CHECKPOINT_ID,
      2
    )
    // Still a continuation, never Resend.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('clears the checkpoint and keeps saying so when the Host no longer has it', async () => {
    const harness = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(
      continueAnswer('continue-response.not-found.json')
    )
    const toastsBefore = harness.spies.pushToast.mock.calls.length

    await act(async () => {
      await harness.result.current.handleRetryModelStep()
    })

    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    expect(harness.result.current.modelStepCheckpoint).toBeNull()
    // The reason stays on the chat instead of a transient toast.
    expect(harness.result.current.modelStepRetry).toEqual({
      pending: false,
      error: null,
      unavailable: true,
    })
    expect(harness.spies.pushToast.mock.calls.length).toBe(toastsBefore)
    // No dead end: the origin turn is Resend-eligible again.
    expect(harness.result.current.failedAgentSend?.content).toBe(ORIGIN_PROMPT)

    // The next send retires the notice.
    clerum.rpc.invokeHostMessage.mockClear()
    await act(async () => {
      await harness.result.current.handleSendAgentMessage('next message')
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(harness.result.current.modelStepRetry).toBeNull()
  })

  it('adopts the current view of a version mismatch', async () => {
    const harness = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(
      continueAnswer('continue-response.version-mismatch.json')
    )

    await act(async () => {
      await harness.result.current.handleRetryModelStep()
    })

    expect(harness.result.current.modelStepCheckpoint).toMatchObject({
      status: 'resumable',
      version: 3,
    })
    expect(harness.spies.pushToast).toHaveBeenCalledWith(
      'The model step changed on the Host. Review it and retry again.',
      'info'
    )
  })

  it('shows the blocked reason a continuation answer carries', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.blocked.json'))

    await act(async () => {
      await result.current.handleRetryModelStep()
    })

    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    expect(result.current.modelStepCheckpoint).toMatchObject({
      status: 'blocked',
      retryAvailable: false,
      blockedReason: 'budget_exhausted',
    })
    // The blocked origin turn is Resend-eligible again.
    expect(result.current.failedAgentSend?.content).toBe(ORIGIN_PROMPT)
  })

  it('reconciles the chat when the continuation already completed', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.loadSessionMessages.mockResolvedValue(sessionWith(undefined))
    const readsBefore = clerum.rpc.loadSessionMessages.mock.calls.length
    clerum.rpc.continueModelStep.mockResolvedValue(
      continueAnswer('continue-response.completed.json')
    )

    await act(async () => {
      await result.current.handleRetryModelStep()
    })

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.length).toBeGreaterThan(readsBefore)
    )
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('keeps the notice with the request error when the POST gets no contract answer', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockRejectedValue(new Error('Host is draining (503)'))

    await act(async () => {
      await result.current.handleRetryModelStep()
    })

    expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
    expect(result.current.modelStepRetry).toEqual({
      pending: false,
      error: 'Host is draining (503)',
    })
    expect(result.current.modelStepCheckpoint?.status).toBe('resumable')
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('drops the checkpoint when a new message is sent in the chat', async () => {
    const { result } = await sendAndFail(view('session-view.resumable.json'))
    expect(result.current.modelStepCheckpoint?.status).toBe('resumable')
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-next' })

    await act(async () => {
      await result.current.handleSendAgentMessage('start over')
    })

    await waitFor(() => expect(clerum.hasProgressHandler('task-next')).toBe(true))
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.modelStepRetry).toBeNull()
    // The abandoned turn falls back to the ordinary failed-send state, like any
    // failed turn without a checkpoint: its Resend stays available.
    expect(result.current.failedAgentSend?.content).toBe(ORIGIN_PROMPT)
    expect(result.current.agentError).toBe('The provider is unavailable.')
  })
})
