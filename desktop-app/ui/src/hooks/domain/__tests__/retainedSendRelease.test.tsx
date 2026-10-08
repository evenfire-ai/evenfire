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
import { act, cleanup, waitFor as rtlWaitFor } from '@testing-library/react'
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
  /** Task ids the controller asked the store to release as ended. */
  releasedTasks: [] as string[],
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
      const releaseRetainedSendsForTask = (taskId: string) => {
        captured.releasedTasks.push(taskId)
        store.releaseRetainedSendsForTask(taskId)
      }
      const wrapped = { ...store, retainSendSnapshot, releaseRetainedSendsForTask }
      captured.stores.push(wrapped)
      return wrapped
    },
  }
})

let clerum: MockClerum
let uuidCounter = 0
const ASYNC_WAIT_TIMEOUT_MS = 5_000
const WIRING_TIMEOUT_MS = 10_000

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  captured.stores.length = 0
  captured.retained.length = 0
  captured.releasedTasks.length = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  cleanup()
  expect(document.body.childElementCount).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetHostModelSelectionStore()
  uninstallMockClerum()
})

// Real ChatStore-backed effects can exceed Testing Library's 1-second default
// on loaded local/T0 runners. This follows the #958 wiring-timeout contract.
function waitFor<T>(callback: () => T | Promise<T>, options?: Parameters<typeof rtlWaitFor>[1]) {
  return rtlWaitFor(callback, { timeout: ASYNC_WAIT_TIMEOUT_MS, ...options })
}

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
  await act(async () => {
    await result.current.handleSendAgentMessage('keep this payload')
  })
  await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true), {
    timeout: WIRING_TIMEOUT_MS,
  })
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

describe('older failures of a chat (#654 M2)', () => {
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
    await act(async () => {
      await result.current.handleSendAgentMessage('second try')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-later')).toBe(true), {
      timeout: WIRING_TIMEOUT_MS,
    })
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

/**
 * jozer-rami review 5445124702 (A15 items 2 and 3) — documents the Host never
 * received exist nowhere else, so ending a task or dismissing a newer failure
 * must not drop them. The snapshot stays visible, offers Recover files, and
 * nothing is sent again.
 */
describe('documents the Host never received (#678 A15)', () => {
  type Result = ReturnType<typeof renderController>['result']

  /** Adds one document through the public action and waits until it is read. */
  async function addReadyFile(result: Result, name: string) {
    act(() => {
      result.current.handleAddComposerFiles(
        [new File([new TextEncoder().encode(`${name} body`)], name, { type: 'text/plain' })],
        ''
      )
    })
    await waitFor(() =>
      expect(result.current.composerFileAttachments.map(item => item.status)).toEqual(['ready'])
    )
    return result.current.composerFileAttachments[0]!
  }

  /** A synchronous send the Host answered without admitting its document. */
  async function sendDropped(result: Result, text: string, name: string) {
    const file = await addReadyFile(result, name)
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [],
    })
    await act(async () => {
      await result.current.handleSendAgentMessage(text)
    })
    expect(result.current.failedAgentSend).toMatchObject({
      content: text,
      answeredWithoutFiles: true,
    })
    return file
  }

  /** An async task the Host accepted without admitting its document. */
  async function sendAsyncDropped(result: Result, taskId: string) {
    const file = await addReadyFile(result, 'notes.txt')
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ taskId, acceptedAttachmentIds: [] })
    const send = act(async () => {
      await result.current.handleSendAgentMessage('keep this payload')
    })
    await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true), {
      timeout: WIRING_TIMEOUT_MS,
    })
    await send
    // Liveness: the drop was recorded on the task's snapshot.
    expect(heldSnapshot()).toMatchObject({ taskId, reason: 'host_files_dropped' })
    expect(result.current.failedAgentSend?.answeredWithoutFiles).toBe(true)
    return file
  }

  /** The kept snapshot offers its files back and never sends the text again. */
  async function expectFilesRecoverableAndNotResent(result: Result, fileId: string) {
    expect(result.current.failedAgentSend).toMatchObject({
      content: 'keep this payload',
      answeredWithoutFiles: true,
    })
    await act(async () => {
      await result.current.handleRetryFailedAgentSend()
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)

    act(() => result.current.handleRecoverFailedAgentSend())

    // Recover brings the document back and releases what it recovered.
    expect(result.current.composerFileAttachments.map(item => item.id)).toEqual([fileId])
    expect(heldSnapshot()).toBeUndefined()
    expect(result.current.failedAgentSend).toBeNull()
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  }

  it('a discard keeps an older snapshot whose documents never reached the Host', async () => {
    const { result } = renderController()
    await settleMount()
    const firstFile = await sendDropped(result, 'first drop', 'first.txt')
    await sendFailing(result, 'plain failure')
    await sendDropped(result, 'second drop', 'second.txt')
    expect(heldFailures().map(snapshot => snapshot.content)).toEqual([
      'first drop',
      'plain failure',
      'second drop',
    ])

    act(() => {
      result.current.handleDiscardFailedAgentSend()
    })

    // Witness: the visible drop and the plain failure behind it are released.
    expect(heldFailures().map(snapshot => snapshot.content)).toEqual(['first drop'])
    // The older drop is now the visible failure and still offers its file back.
    expect(result.current.failedAgentSend).toMatchObject({
      content: 'first drop',
      answeredWithoutFiles: true,
    })
    expect(result.current.failedAgentSend?.files.map(item => item.id)).toEqual([firstFile.id])
  })

  it('recovering the files of the newest drop keeps an older drop recoverable', async () => {
    const { result } = renderController()
    await settleMount()
    await sendDropped(result, 'first drop', 'first.txt')
    const secondFile = await sendDropped(result, 'second drop', 'second.txt')

    act(() => result.current.handleRecoverFailedAgentSend())

    // Witness: the recovered drop is released and its document is back.
    expect(result.current.composerFileAttachments.map(item => item.id)).toEqual([secondFile.id])
    expect(heldFailures().map(snapshot => snapshot.content)).toEqual(['first drop'])
    expect(result.current.failedAgentSend).toMatchObject({
      content: 'first drop',
      answeredWithoutFiles: true,
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
  })

  it('a cancel keeps the snapshot of a task whose documents never reached the Host', async () => {
    const { result } = renderController()
    await settleMount()
    const file = await sendAsyncDropped(result, 'task-cancel-doc')

    await act(async () => {
      await result.current.cancelTask('task-cancel-doc')
    })

    // Witness: the cancel succeeded and released the task in the store.
    expect(clerum.rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-cancel-doc')
    expect(captured.releasedTasks).toEqual(['task-cancel-doc'])
    expect(heldSnapshot()).toMatchObject({ reason: 'host_files_dropped' })
    await expectFilesRecoverableAndNotResent(result, file.id)
  })

  it('a cancel of a task already gone keeps the snapshot whose documents never reached the Host', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('404 Not Found'))
    const { result, spies } = renderController()
    await settleMount()
    const file = await sendAsyncDropped(result, 'task-gone-doc')

    await act(async () => {
      await result.current.cancelTask('task-gone-doc')
    })

    // Witness: the 404 branch ran and released the task in the store.
    expect(spies.pushToast).toHaveBeenCalledWith('That task is no longer active.', 'info')
    expect(captured.releasedTasks).toEqual(['task-gone-doc'])
    expect(heldSnapshot()).toMatchObject({ reason: 'host_files_dropped' })
    await expectFilesRecoverableAndNotResent(result, file.id)
  })

  it('a lost stream the turn already covered keeps the snapshot whose documents never reached the Host', async () => {
    const { result } = renderController()
    await settleMount()
    const file = await sendAsyncDropped(result, 'task-noop-doc')
    // The local transcript already holds the task's answer, so the reconcile
    // after the stream loss settles as `noop`.
    const chatId = result.current.activeChatId
    expect(chatId).toEqual(expect.any(String))
    await act(async () => {
      await clerum.chat.appendMessages('agent-x', chatId, [
        {
          id: 'covered-answer',
          role: 'assistant',
          content: 'already answered',
          timestamp: Date.now(),
          task_id: 'task-noop-doc',
        },
      ])
    })

    await act(async () => {
      clerum.emitTaskProgress('task-noop-doc', { type: 'closed' })
    })

    // Witness: the noop branch ran and released the task in the store.
    await waitFor(() => expect(captured.releasedTasks).toEqual(['task-noop-doc']))
    expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled()
    expect(heldSnapshot()).toMatchObject({ reason: 'host_files_dropped' })
    await expectFilesRecoverableAndNotResent(result, file.id)
  })
})
