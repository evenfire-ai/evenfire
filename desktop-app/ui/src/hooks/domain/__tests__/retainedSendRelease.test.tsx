// @vitest-environment jsdom
/**
 * #654 M6 — every terminal outcome of an async send releases the payload the
 * controller retained for recovery. A snapshot that is held but carries no
 * failure is invisible through the public hook API (`failedAgentSend` only
 * surfaces snapshots with a failure), so these tests wrap the real store factory
 * to read the store the controller created. Each test asserts the snapshot was
 * held before the terminal outcome and is gone after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { readHostModelSelection, resetHostModelSelectionStore } from '@lib/hostModelSelectionStore'
import type { RetainedSendSnapshot } from '@lib/retainedSendStore'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

type RetainedSendStore = ReturnType<
  (typeof import('@lib/retainedSendStore'))['createRetainedSendStore']
>

const captured = vi.hoisted(() => ({
  stores: [] as RetainedSendStore[],
  retained: [] as RetainedSendSnapshot[],
}))

vi.mock('@lib/retainedSendStore', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/retainedSendStore')>()
  return {
    ...actual,
    createRetainedSendStore: (changed: () => void) => {
      const store = actual.createRetainedSendStore(changed)
      const retainSendSnapshot = (snapshot: RetainedSendSnapshot) => {
        captured.retained.push(snapshot)
        store.retainSendSnapshot(snapshot)
      }
      const wrapped = { ...store, retainSendSnapshot }
      captured.stores.push(wrapped)
      return wrapped
    },
  }
})

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  captured.stores.length = 0
  captured.retained.length = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetHostModelSelectionStore()
  uninstallMockClerum()
})

const image: ComposerImageAttachment = {
  id: 'input-image',
  name: 'input.png',
  mimeType: 'image/png',
  dataBase64: 'YWJj',
  sizeBytes: 3,
  previewDataUrl: 'data:image/png;base64,YWJj',
}

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

/** The snapshot the single send retained, read back from the live store. */
function heldSnapshot(): RetainedSendSnapshot | undefined {
  expect(captured.stores).toHaveLength(1)
  expect(captured.retained).toHaveLength(1)
  const [store] = captured.stores
  const [retained] = captured.retained
  return store!.getRetainedSendSnapshot(
    retained!.agentRef!,
    retained!.chatId,
    retained!.userMessageId!
  )
}

async function sendAsync(result: ReturnType<typeof renderController>['result'], taskId: string) {
  clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId })
  const send = act(async () => {
    await result.current.handleSendAgentMessage('keep this payload')
  })
  await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true))
  await send
  // Liveness: the send retained its payload and the task id is attached to it.
  expect(heldSnapshot()).toMatchObject({ content: 'keep this payload', taskId })
}

describe('retained send release on terminal outcomes (#654 M6)', () => {
  it('releases the retained send on a terminal reply', async () => {
    clerum.rpc.getTaskResult.mockResolvedValue({ status: 'completed', response: 'all done' })
    const { result } = renderController()
    await settleMount()
    await sendAsync(result, 'task-reply')

    await act(async () => {
      clerum.emitTaskProgress('task-reply', {
        type: 'terminal',
        data: { taskId: 'task-reply', status: 'completed' },
      })
    })

    // Witness that the reply branch ran: the durable reply was persisted.
    await waitFor(() =>
      expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'all done' }),
        ])
      )
    )
    expect(heldSnapshot()).toBeUndefined()
  })

  it('releases the retained send when a lost stream is reconciled to a durable reply', async () => {
    // The stream closes without a terminal; the reconcile finds the durable
    // per-task result and materializes it.
    clerum.rpc.getTaskResult.mockResolvedValue({ status: 'completed', response: 'recovered' })
    const { result } = renderController()
    await settleMount()
    await sendAsync(result, 'task-lost')

    await act(async () => {
      clerum.emitTaskProgress('task-lost', { type: 'closed' })
    })

    // Witness that the reconcile recovered the reply rather than falling
    // through to the Resend affordance.
    await waitFor(() =>
      expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'recovered' }),
        ])
      )
    )
    await waitFor(() => expect(heldSnapshot()).toBeUndefined())
    expect(result.current.failedAgentSend).toBeNull()
  })

  it('releases the retained send when the user cancels the task', async () => {
    const { result } = renderController()
    await settleMount()
    await sendAsync(result, 'task-cancel')

    await act(async () => {
      await result.current.cancelTask('task-cancel')
    })

    expect(clerum.rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-cancel')
    expect(heldSnapshot()).toBeUndefined()
  })

  it('releases the retained send when the task is already gone upstream (404 on cancel)', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('404 Not Found'))
    const { result } = renderController()
    await settleMount()
    await sendAsync(result, 'task-gone')

    await act(async () => {
      await result.current.cancelTask('task-gone')
    })

    expect(clerum.rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-gone')
    expect(heldSnapshot()).toBeUndefined()
  })

  it('keeps the payload when cancelling fails for another reason', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('500 upstream exploded'))
    const { result, spies } = renderController()
    await settleMount()
    await sendAsync(result, 'task-keep')

    await act(async () => {
      await result.current.cancelTask('task-keep')
    })

    // Witness: the failure path ran and told the user.
    expect(spies.pushToast).toHaveBeenCalledWith(
      expect.stringContaining('Failed to cancel task'),
      'error'
    )
    expect(heldSnapshot()).toMatchObject({ taskId: 'task-keep' })
  })
})

describe('older failures of a chat (#654 M2)', () => {
  /** Sends one message whose POST throws, leaving a retained failure. */
  async function sendFailing(result: ReturnType<typeof renderController>['result'], text: string) {
    clerum.rpc.invokeHostMessage.mockRejectedValueOnce(new Error('network down'))
    await act(async () => {
      await result.current.handleSendAgentMessage(text)
    })
    expect(result.current.failedAgentSend?.content).toBe(text)
  }

  /** Failed snapshots still held by the controller's store. */
  function heldFailures(): RetainedSendSnapshot[] {
    expect(captured.stores).toHaveLength(1)
    const [store] = captured.stores
    return captured.retained
      .map(retained =>
        store!.getRetainedSendSnapshot(retained.agentRef, retained.chatId, retained.userMessageId)
      )
      .filter((snapshot): snapshot is RetainedSendSnapshot => Boolean(snapshot?.failure))
  }

  it('hides an older failure once a later synchronous send succeeds', async () => {
    const { result, spies } = renderController()
    await settleMount()
    await sendFailing(result, 'first try')

    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ response: 'direct answer' })
    await act(async () => {
      await result.current.handleSendAgentMessage('second try')
    })

    // Witness: the second send reached the synchronous success branch.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
    expect(spies.pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
    expect(result.current.failedAgentSend).toBeNull()
    expect(heldFailures()).toEqual([])
  })

  it('hides an older failure once a later task replies, not before', async () => {
    clerum.rpc.getTaskResult.mockResolvedValue({ status: 'completed', response: 'all done' })
    const { result } = renderController()
    await settleMount()
    await sendFailing(result, 'first try')

    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ taskId: 'task-later' })
    const send = act(async () => {
      await result.current.handleSendAgentMessage('second try')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-later')).toBe(true))
    await send
    // The later send has not reached a terminal yet, so it supersedes nothing.
    expect(result.current.failedAgentSend?.content).toBe('first try')

    await act(async () => {
      clerum.emitTaskProgress('task-later', {
        type: 'terminal',
        data: { taskId: 'task-later', status: 'completed' },
      })
    })

    // Witness: the reply branch ran and persisted the durable reply.
    await waitFor(() =>
      expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'all done' }),
        ])
      )
    )
    await waitFor(() => expect(result.current.failedAgentSend).toBeNull())
    expect(heldFailures()).toEqual([])
  })

  it('does not resurface an older failure after the newest one is discarded', async () => {
    const { result } = renderController()
    await settleMount()
    await sendFailing(result, 'first try')
    await sendFailing(result, 'second try')
    // Witness: both failures are held, and the newest one is the visible one.
    expect(heldFailures().map(snapshot => snapshot.content)).toEqual(['first try', 'second try'])
    expect(result.current.failedAgentSend?.content).toBe('second try')

    act(() => {
      result.current.handleDiscardFailedAgentSend()
    })

    expect(result.current.failedAgentSend).toBeNull()
    expect(heldFailures()).toEqual([])
  })

  it('shows a fresh send-time error over an older retained failure', async () => {
    const { result } = renderController()
    await settleMount()
    await sendFailing(result, 'first try')

    // With no fresh error, the banner falls back to the retained failure.
    act(() => result.current.clearComposerSendError())
    expect(result.current.agentError).toBe('network down')

    // An image send is blocked before any POST: the model selection for this
    // chat was never loaded, so the send-time guard reports a fresh error.
    const chatId = result.current.activeChatId
    const blocker = readHostModelSelection('agent-x', chatId).imageBlockMessage
    expect(blocker).toEqual(expect.any(String))
    act(() => result.current.handleAddComposerImageAttachments([image]))
    await act(async () => {
      await result.current.handleSendAgentMessage('with an image')
    })

    // Witness: the older failure is still retained and visible as the Resend
    // target, and the blocked send never reached the Host.
    expect(heldFailures().map(snapshot => snapshot.content)).toEqual(['first try'])
    expect(result.current.failedAgentSend?.content).toBe('first try')
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(result.current.agentError).toBe(blocker)
  })
})
