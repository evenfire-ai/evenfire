// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ModelStepRetryNotice } from '@components/agents/ModelStepRetryNotice'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'
import {
  CHECKPOINT_ID,
  CONTINUATION_TASK_ID,
  FAILED_TERMINAL,
  ORIGIN_PROMPT,
  checkpointView,
  continueAnswer,
  sendAndFail,
  sessionWith,
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
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function pendingRetry() {
  const harness = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
  const answer = deferred<ReturnType<typeof continueAnswer>>()
  clerum.rpc.continueModelStep.mockReturnValue(answer.promise)
  let retry!: Promise<void>
  await act(async () => {
    retry = harness.result.current.handleRetryModelStep()
  })
  expect(clerum.rpc.continueModelStep).toHaveBeenCalledTimes(1)
  expect(harness.result.current.modelStepRetry?.pending).toBe(true)
  return { ...harness, answer, retry }
}

describe('model-step Retry operation identity (#1048 H1/H2)', () => {
  it.each([false, true])(
    'binds a pending Retry to A across A -> B (return to A: %s)',
    async returnToA => {
      const harness = await pendingRetry()
      const { result, answer, retry } = harness
      const chatA = result.current.activeChatId!
      const userA = result.current.chatMessages.find(message => message.role === 'user')!.id
      await clerum.chat.create('agent-x', 'chat-b')
      await clerum.chat.appendMessages('agent-x', 'chat-b', [
        { id: 'user-b', role: 'user', content: 'B request', timestamp: 1 },
      ])
      clerum.rpc.loadSessionMessages.mockImplementation(
        async (_host: string, _agent: string, chatId: string) =>
          sessionWith(
            chatId === chatA ? checkpointView('session-view.resumable.json') : undefined,
            chatId
          )
      )
      await act(async () => {
        await result.current.switchToChat('agent-x', 'chat-b')
      })
      expect(result.current.chatMessages.some(message => message.id === 'user-b')).toBe(true)
      if (returnToA) {
        await act(async () => {
          await result.current.switchToChat('agent-x', chatA)
        })
        expect(result.current.chatMessages.some(message => message.id === userA)).toBe(true)
      }
      await act(async () => {
        answer.resolve(continueAnswer('continue-response.claimed.json'))
        await retry
      })
      await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
      expect(result.current.progressByAgentMessage['agent-x']?.[userA]?.taskId).toBe(
        CONTINUATION_TASK_ID
      )
      expect(result.current.progressByAgentMessage['agent-x']?.['user-b']).toBeUndefined()
      await act(async () => {
        clerum.emitTaskProgress(CONTINUATION_TASK_ID, {
          type: 'suspended',
          data: { reason: 'approval', requestId: 'approval-a', displayName: 'Approve A tool' },
        })
      })
      await waitFor(() =>
        expect(
          result.current.sessionFsmStore.getState(makeTaskKey('agent-x', chatA))?.pendingApproval
            ?.requestId
        ).toBe('approval-a')
      )
      if (returnToA) {
        expect(
          result.current.progressByAgentMessage['agent-x']?.[userA]?.suspendedInfo?.requestId
        ).toBe('approval-a')
      }
      expect(
        result.current.progressByAgentMessage['agent-x']?.['user-b']?.suspendedInfo
      ).toBeUndefined()
      expect(
        result.current.sessionFsmStore.getState(makeTaskKey('agent-x', 'chat-b'))?.pendingApproval
      ).toBeUndefined()
      expect(
        (await clerum.persistedMessages('agent-x', 'chat-b')).map(message => message.id)
      ).toEqual(['user-b'])
    }
  )

  it.each([
    'continue-response.claimed.json',
    'continue-response.completed.json',
    'continue-response.not-found.json',
    'continue-response.blocked.json',
    'continue-response.version-mismatch.json',
  ])('discards %s after a newer send and reconciles without replacing it', async fixture => {
    const { result, answer, retry, spies } = await pendingRetry()
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-new' })
    await act(async () => {
      await result.current.handleSendAgentMessage('new turn')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-new')).toBe(true))
    const userNew = result.current.chatMessages.find(message => message.content === 'new turn')!.id
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      ...sessionWith(undefined, result.current.activeChatId!),
      state: 'processing',
      activeTaskId: 'task-new',
    })
    const readsBefore = clerum.rpc.loadSessionMessages.mock.calls.length
    const toastsBefore = spies.pushToast.mock.calls.length
    await act(async () => {
      answer.resolve(continueAnswer(fixture))
      await retry
    })
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.length).toBeGreaterThan(readsBefore)
    )
    expect(clerum.hasProgressHandler('task-new')).toBe(true)
    expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(false)
    expect(result.current.progressByAgentMessage['agent-x']?.[userNew]?.taskId).toBe('task-new')
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.modelStepRetry).toBeNull()
    expect(spies.pushToast.mock.calls.length).toBe(toastsBefore)
    expect(
      result.current.sessionFsmStore.getState(makeTaskKey('agent-x', result.current.activeChatId!))
        ?.activeTaskId
    ).toBe('task-new')
  })

  it('discards a rejected Retry after a newer send', async () => {
    const { result, answer, retry } = await pendingRetry()
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-new' })
    await act(async () => {
      await result.current.handleSendAgentMessage('new turn')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-new')).toBe(true))
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      ...sessionWith(undefined, result.current.activeChatId!),
      state: 'processing',
      activeTaskId: 'task-new',
    })
    const readsBefore = clerum.rpc.loadSessionMessages.mock.calls.length
    await act(async () => {
      answer.reject(new Error('late request failure'))
      await retry
    })
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.length).toBeGreaterThan(readsBefore)
    )
    expect(clerum.hasProgressHandler('task-new')).toBe(true)
    expect(result.current.modelStepRetry).toBeNull()
  })

  it('clears its pending state when the checkpoint version changes during Retry', async () => {
    const { result, answer, retry } = await pendingRetry()
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith(
        { ...checkpointView('session-view.resumable.json'), version: 2 },
        result.current.activeChatId!
      )
    )
    await act(async () => {
      await result.current.reconcileChat(makeTaskKey('agent-x', result.current.activeChatId!), {
        reason: 'checkpoint_updated',
      })
    })
    expect(result.current.modelStepCheckpoint?.version).toBe(2)
    const readsBefore = clerum.rpc.loadSessionMessages.mock.calls.length
    await act(async () => {
      answer.resolve(continueAnswer('continue-response.claimed.json'))
      await retry
    })
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.length).toBeGreaterThan(readsBefore)
    )
    expect(result.current.modelStepRetry).toBeNull()
    expect(result.current.modelStepCheckpoint?.retryAvailable).toBe(true)
    expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(false)
  })
})

describe('model-step continuation completion and rejoin (#1048 H3/M1)', () => {
  it('captures the origin from a reopened server turn without a task id', async () => {
    await clerum.chat.create('agent-x', 'reopened-chat')
    await clerum.chat.appendMessages('agent-x', 'reopened-chat', [
      { id: 'turn-1-user', role: 'user', content: ORIGIN_PROMPT, timestamp: 1 },
    ])
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith(checkpointView('session-view.resumable.json'), 'reopened-chat')
    )
    const { result } = renderController()
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await act(async () => {
      await result.current.switchToChat('agent-x', 'reopened-chat')
    })
    expect(result.current.modelStepCheckpoint?.retryAvailable).toBe(true)
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(result.current.progressByAgentMessage['agent-x']?.['turn-1-user']?.taskId).toBe(
      CONTINUATION_TASK_ID
    )
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  })

  it.each(['task-result', 'session-turn'])(
    'releases the origin after SSE loss and idle recovery from %s',
    async recovery => {
      const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
      clerum.rpc.continueModelStep.mockResolvedValue(
        continueAnswer('continue-response.claimed.json')
      )
      await act(async () => {
        await result.current.handleRetryModelStep()
      })
      await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
      const session = sessionWith(undefined, result.current.activeChatId!)
      clerum.rpc.loadSessionMessages.mockResolvedValue({
        ...session,
        turns:
          recovery === 'session-turn'
            ? [
                {
                  number: 1,
                  user_input: ORIGIN_PROMPT,
                  response: 'recovered continuation',
                  started_at: new Date().toISOString(),
                },
              ]
            : [],
      })
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'recovered continuation' })
      await act(async () => {
        clerum.emitTaskProgress(CONTINUATION_TASK_ID, { type: 'closed' })
      })
      await waitFor(() =>
        expect(
          result.current.chatMessages.some(message => message.content === 'recovered continuation')
        ).toBe(true)
      )
      expect(result.current.modelStepCheckpoint).toBeNull()
      await waitFor(() => expect(result.current.failedAgentSend).toBeNull())
      const sendsBefore = clerum.rpc.invokeHostMessage.mock.calls.length
      await act(async () => {
        await result.current.handleRetryFailedAgentSend()
      })
      expect(clerum.rpc.invokeHostMessage.mock.calls.length).toBe(sendsBefore)
    }
  )

  it('follows a claimed current checkpoint in a version mismatch', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    const current = checkpointView('session-view.claimed.json')
    clerum.rpc.continueModelStep.mockResolvedValue({
      outcome: 'version_mismatch',
      body: { code: 'model_step_checkpoint_version_mismatch', current },
    })
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    expect(result.current.modelStepCheckpoint?.continuationTaskId).toBe(CONTINUATION_TASK_ID)
    await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
    expect(result.current.failedAgentSend).toBeNull()
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it.each(['version-mismatch', 'idle-rejoin'])(
    'releases the origin after a %s claim loses SSE',
    async claim => {
      const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
      const current = checkpointView('session-view.claimed.json')
      if (claim === 'version-mismatch') {
        clerum.rpc.continueModelStep.mockResolvedValue({
          outcome: 'version_mismatch',
          body: { code: 'model_step_checkpoint_version_mismatch', current },
        })
        await act(async () => {
          await result.current.handleRetryModelStep()
        })
      } else {
        clerum.rpc.loadSessionMessages.mockResolvedValue(
          sessionWith(current, result.current.activeChatId!)
        )
        await act(async () => {
          await result.current.reconcileChat(makeTaskKey('agent-x', result.current.activeChatId!), {
            reason: 'reopen_claimed',
          })
        })
      }
      await waitFor(() => expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true))
      clerum.rpc.loadSessionMessages.mockResolvedValue(
        sessionWith(undefined, result.current.activeChatId!)
      )
      clerum.rpc.getTaskResult.mockResolvedValue({ response: 'rejoined continuation completed' })
      await act(async () => {
        clerum.emitTaskProgress(CONTINUATION_TASK_ID, { type: 'closed' })
      })
      await waitFor(() =>
        expect(
          result.current.chatMessages.some(
            message => message.content === 'rejoined continuation completed'
          )
        ).toBe(true)
      )
      await waitFor(() => expect(result.current.failedAgentSend).toBeNull())
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    }
  )
})

describe('safe Retry notice and acknowledged sends (#1048 M3/M4/L1)', () => {
  it('retires Retry after an acknowledged synchronous send succeeds', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    expect(result.current.modelStepCheckpoint?.retryAvailable).toBe(true)
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'synchronous answer' })
    await act(async () => {
      await result.current.handleSendAgentMessage('new synchronous turn')
    })
    expect(
      result.current.chatMessages.some(message => message.content === 'synchronous answer')
    ).toBe(true)
    expect(result.current.modelStepCheckpoint).toBeNull()
    expect(result.current.modelStepRetry).toBeNull()
  })

  it('keeps Retry while a send is pending and after it fails before acknowledgement', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    const send = deferred<never>()
    clerum.rpc.invokeHostMessage.mockReturnValue(send.promise)
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.handleSendAgentMessage('send that fails')
    })
    await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2))
    expect(result.current.modelStepCheckpoint?.retryAvailable).toBe(true)
    await act(async () => {
      send.reject(new Error('send rejected'))
      await pending
    })
    expect(result.current.modelStepCheckpoint?.retryAvailable).toBe(true)
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    expect(clerum.rpc.continueModelStep).toHaveBeenCalledWith(
      'agent-x',
      'agent-x',
      result.current.activeChatId,
      CHECKPOINT_ID,
      1
    )
    expect(clerum.hasProgressHandler(CONTINUATION_TASK_ID)).toBe(true)
  })

  it('does not log an upstream body canary when the checkpoint read fails', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    clerum.rpc.loadSessionMessages.mockRejectedValue(
      new Error('CANARY_UPSTREAM_BODY checkpoint read')
    )
    await act(async () => {
      clerum.emitTaskProgress(CONTINUATION_TASK_ID, FAILED_TERMINAL)
    })
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[useAgentChatController] model step checkpoint read failed',
        expect.any(Object)
      )
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CANARY_UPSTREAM_BODY')
  })

  it('does not expose an upstream body canary in the Retry notice', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockRejectedValue(
      new Error('CANARY_UPSTREAM_BODY continuation POST')
    )
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    render(
      <ModelStepRetryNotice
        checkpoint={result.current.modelStepCheckpoint}
        retry={result.current.modelStepRetry}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry model step' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(
      'The model step could not be retried. Try again.'
    )
    expect(screen.getByTestId('model-step-retry-notice').textContent).not.toContain(
      'CANARY_UPSTREAM_BODY'
    )
  })

  it('shows a reference-specific notice after a continuation fails its file check', async () => {
    const { result } = await sendAndFail(clerum, checkpointView('session-view.resumable.json'))
    clerum.rpc.continueModelStep.mockResolvedValue(continueAnswer('continue-response.claimed.json'))
    await act(async () => {
      await result.current.handleRetryModelStep()
    })
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      sessionWith({ ...checkpointView('session-view.resumable.json'), version: 2 })
    )
    await act(async () => {
      clerum.emitTaskProgress(CONTINUATION_TASK_ID, {
        type: 'terminal',
        data: {
          status: 'failed',
          error: { message: 'File check failed', code: 'FILE_REFERENCE_CHECK_FAILED' },
        },
      })
    })
    await waitFor(() => expect(result.current.modelStepCheckpoint?.version).toBe(2))
    render(
      <ModelStepRetryNotice
        checkpoint={result.current.modelStepCheckpoint}
        retry={result.current.modelStepRetry}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry model step' })).toBeTruthy()
    const notice = screen.getByTestId('model-step-retry-notice').textContent
    expect(notice).toContain(
      'A file reference could not be verified. Check that the referenced file is available before retrying.'
    )
    expect(notice).not.toContain('The provider was unavailable')
  })
})
