/**
 * Duplicate-admission suppression at the sink (MessageQueue.admit).
 *
 * Proven-live failure class (wake-recovery E2E): a message delivered twice
 * through rpc-proxy was admitted and EXECUTED twice — the second run hit an
 * approval request and wedged the host non-idle (SuspendBlocked: activeTask).
 * The sink must reject duplicates:
 *   - by task id (re-admission of an already-registered task), and
 *   - by delivery identity (the same channelType:channelId:sender:messageId
 *     re-delivered under a fresh uuid).
 * The route-level half of the fenced-503 contract (a fenced intake never
 * reaches the handler, so nothing registers) is pinned by
 * src/__tests__/server.drainingFence.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { IncomingMessage } from '../../server'
import { MessageQueue } from '../messageQueue'

function message(messageId: string, content = 'hello'): IncomingMessage {
  return {
    content,
    channelType: 'telegram',
    channelId: 'chan-1',
    sender: 'user-1',
    timestamp: new Date().toISOString(),
    messageId,
    hostRef: 'test-host',
  }
}

function wiredQueue() {
  const lifecycle = new TaskLifecycle()
  const queue = new MessageQueue()
  queue.setLifecycle(lifecycle)
  return { queue, lifecycle }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MessageQueue.admit — duplicate suppression sink', () => {
  it('admits genuinely new ids and messageIds unchanged', () => {
    const { queue, lifecycle } = wiredQueue()
    const t1 = queue.createTaskFromMessage(message('m-1'))
    const t2 = queue.createTaskFromMessage(message('m-2'))

    expect(queue.admit(t1)).toEqual({ admitted: true })
    expect(queue.admit(t2)).toEqual({ admitted: true })
    expect(lifecycle.getStatus(t1.id)).toBe('pending')
    expect(lifecycle.getStatus(t2.id)).toBe('pending')
    expect(queue.dequeue()?.id).toBe(t1.id)
    expect(queue.dequeue()?.id).toBe(t2.id)
  })

  it('rejects re-admission of an already-registered task id — no second queue entry, loud log', () => {
    const { queue, lifecycle } = wiredQueue()
    const warn = vi.spyOn(console, 'warn')
    const task = queue.createTaskFromMessage(message('m-readmit'))
    expect(queue.admit(task)).toEqual({ admitted: true })

    let created = 0
    lifecycle.on('transition', ev => {
      if (ev.from === null && ev.to === 'pending') created++
    })

    const outcome = queue.admit(task)
    expect(outcome).toEqual({
      admitted: false,
      reason: 'duplicate_task_id',
      priorTaskId: task.id,
      priorStatus: 'pending',
    })
    // No re-registration, no second created transition, no second queue entry.
    expect(created).toBe(0)
    expect(queue.dequeue()?.id).toBe(task.id)
    expect(queue.dequeue()).toBeNull()
    expect(
      warn.mock.calls.some(args => String(args[0]).includes('duplicate delivery suppressed'))
    ).toBe(true)
  })

  it('rejects a duplicate delivery (same messageId, fresh uuid) while the original is still in flight', () => {
    const { queue } = wiredQueue()
    const warn = vi.spyOn(console, 'warn')
    const first = queue.createTaskFromMessage(message('m-inflight'))
    expect(queue.admit(first)).toEqual({ admitted: true })
    expect(queue.dequeue()?.id).toBe(first.id) // pending → processing

    const duplicate = queue.createTaskFromMessage(message('m-inflight'))
    expect(duplicate.id).not.toBe(first.id) // fresh uuid — id-keyed dedupe alone cannot stop this
    const outcome = queue.admit(duplicate)
    expect(outcome).toEqual({
      admitted: false,
      reason: 'duplicate_delivery',
      priorTaskId: first.id,
      priorStatus: 'processing',
    })
    // No new queue entry, and the never-to-run duplicate Task is not leaked
    // in the instance index (it has no lifecycle record to evict it later).
    expect(queue.dequeue()).toBeNull()
    expect(queue.getTask(duplicate.id)).toBeNull()
    expect(queue.getTask(first.id)?.id).toBe(first.id)
    expect(
      warn.mock.calls.some(args => String(args[0]).includes('duplicate delivery suppressed'))
    ).toBe(true)
  })

  it('rejects a duplicate delivery of a COMPLETED task and surfaces the prior terminal state', () => {
    const { queue, lifecycle } = wiredQueue()
    const first = queue.createTaskFromMessage(message('m-completed'))
    expect(queue.admit(first)).toEqual({ admitted: true })
    queue.dequeue()
    first.result = { response: 'first answer', model: 'test-model' }
    queue.completeTask(first)
    expect(lifecycle.getStatus(first.id)).toBe('completed')

    const duplicate = queue.createTaskFromMessage(message('m-completed'))
    const outcome = queue.admit(duplicate)
    expect(outcome).toEqual({
      admitted: false,
      reason: 'duplicate_delivery',
      priorTaskId: first.id,
      priorStatus: 'completed',
    })
    // The recorded outcome stays available for replay by the caller.
    expect(lifecycle.get(first.id)?.response).toBe('first answer')
    expect(queue.dequeue()).toBeNull()
  })

  it('a task created but never admitted does not poison the delivery identity (fenced-503 analogue)', () => {
    // The DRAINING fence rejects intake at the route BEFORE any task exists
    // (server.ts, pinned by server.drainingFence.test.ts). The equivalent sink
    // property: delivery identity is recorded at ADMISSION, not at factory
    // time — a rejected/fenced attempt leaves no trace, so a later legitimate
    // delivery of the same messageId is NOT treated as a duplicate.
    const { queue, lifecycle } = wiredQueue()
    const fencedAttempt = queue.createTaskFromMessage(message('m-fenced'))
    expect(lifecycle.getStatus(fencedAttempt.id)).toBeNull() // never registered

    const redelivery = queue.createTaskFromMessage(message('m-fenced'))
    expect(queue.admit(redelivery)).toEqual({ admitted: true })
    expect(lifecycle.getStatus(redelivery.id)).toBe('pending')
  })

  it('an empty messageId never participates in delivery dedupe', () => {
    const { queue } = wiredQueue()
    const t1 = queue.createTaskFromMessage(message('', 'one'))
    const t2 = queue.createTaskFromMessage(message('', 'two'))
    expect(queue.admit(t1)).toEqual({ admitted: true })
    expect(queue.admit(t2)).toEqual({ admitted: true })
  })

  it('an rpc/desktop delivery with a stable messageId dedups the wake-retry (P1-1)', () => {
    // P1-1: rpc-proxy now stamps a stable messageId on the rpc envelope so the
    // wake-and-hold retry re-delivers the SAME identity. Two admissions of that
    // identity (fresh uuids, as mcp-host mints one per delivery) must dedup —
    // the second is duplicate_delivery, never a second execution.
    const { queue, lifecycle } = wiredQueue()
    const rpcMessage = (messageId: string): IncomingMessage => ({
      content: 'do the thing',
      channelType: 'rpc',
      channelId: 'chatllm',
      sender: 'legit-user',
      timestamp: new Date().toISOString(),
      messageId,
      hostRef: 'chatllm',
      threadId: 'chat-1',
    })

    const first = queue.createTaskFromMessage(rpcMessage('stable-delivery-id'))
    expect(queue.admit(first)).toEqual({ admitted: true })

    const retry = queue.createTaskFromMessage(rpcMessage('stable-delivery-id'))
    expect(retry.id).not.toBe(first.id) // fresh uuid per delivery
    const outcome = queue.admit(retry)
    expect(outcome).toMatchObject({ admitted: false, reason: 'duplicate_delivery' })
    // The retry never registered — no second execution path.
    expect(lifecycle.getStatus(retry.id)).toBeNull()
  })

  it('records the delivery identity for a queue_full task so a same-messageId retry dedups (C1)', () => {
    // C1: queue_full is NOT a no-op. messageHandler still registers the task's
    // lifecycle record and dispatches it via SessionProcessor, so it EXECUTES.
    // admit() must record its delivery identity too; otherwise a wake-retry of
    // the same messageId finds no deliveryIndex entry, admits as new work, and
    // runs a SECOND execution (incl. tool side-effects).
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue(100, 1) // maxQueueSize = 1
    queue.setLifecycle(lifecycle)

    // Fill the single queue slot with an unrelated admitted task.
    const filler = queue.createTaskFromMessage(message('m-filler'))
    expect(queue.admit(filler)).toEqual({ admitted: true })

    // Next admission trips queue_full. The task still executes downstream, so
    // the caller registers its lifecycle record (mirrors messageHandler).
    const overflow = queue.createTaskFromMessage(message('m-overflow'))
    const outcome = queue.admit(overflow)
    expect(outcome).toEqual({ admitted: false, reason: 'queue_full' })
    lifecycle.register(overflow) // caller's Invariant-I12 registration for queue_full

    // A same-messageId wake-retry (fresh uuid) must now be deduped, NOT admitted
    // as a second execution.
    const warn = vi.spyOn(console, 'warn')
    const retry = queue.createTaskFromMessage(message('m-overflow'))
    expect(retry.id).not.toBe(overflow.id)
    const retryOutcome = queue.admit(retry)
    expect(retryOutcome).toEqual({
      admitted: false,
      reason: 'duplicate_delivery',
      priorTaskId: overflow.id,
      priorStatus: 'pending',
    })
    // The retry never registered — no second execution path.
    expect(lifecycle.getStatus(retry.id)).toBeNull()
    expect(
      warn.mock.calls.some(args => String(args[0]).includes('duplicate delivery suppressed'))
    ).toBe(true)
  })

  it('a TTL-evicted prior record releases the delivery identity for re-admission', () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-01-01T00:00:00Z').getTime()
    vi.setSystemTime(t0)

    const { queue, lifecycle } = wiredQueue()
    const first = queue.createTaskFromMessage(message('m-evicted'))
    expect(queue.admit(first)).toEqual({ admitted: true })
    queue.dequeue()
    first.result = { response: 'old answer', model: 'test-model' }
    queue.completeTask(first)

    // Past TERMINAL_RECORD_TTL_MS (5 min) — the next state-touching call
    // evicts the record, which must also purge the delivery index.
    vi.setSystemTime(t0 + 5 * 60 * 1000 + 1000)
    lifecycle.getStats()
    expect(lifecycle.getStatus(first.id)).toBeNull()

    const redelivery = queue.createTaskFromMessage(message('m-evicted'))
    expect(queue.admit(redelivery)).toEqual({ admitted: true })
  })
})
