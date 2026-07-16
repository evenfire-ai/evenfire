/**
 * IncomingMessageHandler — duplicate-delivery suppression contract.
 *
 * Proven-live failure class (wake-recovery E2E): a message redelivered by
 * rpc-proxy AFTER the first delivery was successfully answered was executed a
 * second time (fresh uuid), hit an approval request, and wedged the host
 * non-idle. The handler must consult the admission sink (MessageQueue.admit)
 * and NEVER start a second execution:
 *   - prior task completed → replay the recorded outcome
 *   - prior task failed    → replay the recorded terminal error
 *   - prior task in flight → attach/no-op (pending + prior task id)
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { IncomingMessageHandler, PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import { isUndeliveredResult, markResultDelivered } from '../runtime/resultDelivery'
import type { IncomingMessage } from '../server'

function createTestMessage(messageId: string, content = 'Hello'): IncomingMessage {
  return {
    sender: 'user-1',
    content,
    channelType: 'telegram',
    channelId: 'test-channel',
    messageId,
    timestamp: new Date().toISOString(),
    hostRef: 'test-host',
  }
}

function createMockDeps() {
  const messageQueue = new MessageQueue()
  const agent = new EventEmitter() as any
  const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
  const taskLifecycle = new TaskLifecycle()
  messageQueue.setLifecycle(taskLifecycle)
  return {
    messageQueue,
    agent,
    pendingTaskResults,
    getModel: () => 'test-model',
    sanitizeAttachments: (a: any) => a,
    timeoutMs: 500,
    taskLifecycle,
  }
}

describe('IncomingMessageHandler — duplicate delivery suppression', () => {
  it('replays the recorded outcome for a duplicate of a COMPLETED task (no second execution)', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-dup-completed')

    // First delivery runs to completion.
    const first = new IncomingMessageHandler(message, deps)
    const firstPromise = first.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!
    task.result = { response: 'first answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'first answer' })
    const firstResult = await firstPromise
    expect(firstResult.response).toBe('first answer')

    // Second delivery of the SAME message (rpc-proxy redelivery — fresh uuid).
    const warn = vi.spyOn(console, 'warn')
    const second = new IncomingMessageHandler(message, deps)
    const secondResult = await second.execute()

    expect(secondResult.success).toBe(true)
    expect(secondResult.status).toBe('completed')
    expect(secondResult.response).toBe('first answer')
    expect(secondResult.taskId).toBe(task.id)
    // No second execution: nothing new in the queue, only one lifecycle record.
    expect(deps.messageQueue.dequeue()).toBeNull()
    expect(deps.taskLifecycle.getStats().total).toBe(1)
    expect(
      warn.mock.calls.some(args => String(args[0]).includes('duplicate delivery suppressed'))
    ).toBe(true)
    warn.mockRestore()
  })

  it('replays the recorded error for a duplicate of a FAILED task', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-dup-failed')

    const first = new IncomingMessageHandler(message, deps)
    const firstPromise = first.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!
    deps.messageQueue.failTask(task, {
      code: 'LLM_INSUFFICIENT_QUOTA',
      message: 'out of credit',
      retryable: false,
      provider: 'openai',
    })
    await firstPromise

    const second = new IncomingMessageHandler(message, deps)
    const secondResult = await second.execute()

    expect(secondResult.success).toBe(false)
    expect(secondResult.error?.code).toBe('LLM_INSUFFICIENT_QUOTA')
    expect(secondResult.taskId).toBe(task.id)
    expect(deps.messageQueue.dequeue()).toBeNull()
  })

  it('attaches (pending + prior task id) for a duplicate while the original is still processing', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-dup-inflight')

    const first = new IncomingMessageHandler(message, deps)
    const firstPromise = first.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()! // pending → processing

    const second = new IncomingMessageHandler(message, deps)
    const secondResult = await second.execute()

    expect(secondResult.success).toBe(true)
    expect(secondResult.status).toBe('pending')
    expect(secondResult.taskId).toBe(task.id)
    // No second queue entry — the in-flight execution answers.
    expect(deps.messageQueue.dequeue()).toBeNull()
    expect(deps.taskLifecycle.getStats().total).toBe(1)

    // Let the first delivery finish so its promise settles cleanly.
    await task.responseCallback!({ response: 'done' })
    const firstResult = await firstPromise
    expect(firstResult.response).toBe('done')
  })

  it('a suppressed in-flight sync duplicate returns a taskId whose result is pollable (C3)', async () => {
    // C3: the SYNC path binds the outcome to the first request's socket. When
    // rpc-proxy wake-retries the same messageId after a socket death, the
    // duplicate is suppressed and returns { status:'pending', taskId:priorId }.
    // The prior result MUST be recoverable via pendingTaskResults (the poll
    // endpoint's source) — otherwise the turn's answer is lost (not re-executed,
    // but unpollable).
    const deps = createMockDeps()
    const message = createTestMessage('msg-c3-recoverable')

    // First delivery is in flight (dequeued → processing), socket still open.
    const first = new IncomingMessageHandler(message, deps)
    const firstPromise = first.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()! // pending → processing

    // Wake-retry of the SAME messageId is suppressed, points at the prior task.
    const second = new IncomingMessageHandler(message, deps)
    const secondResult = await second.execute()
    expect(secondResult.status).toBe('pending')
    expect(secondResult.taskId).toBe(task.id)

    // First delivery completes on its (now-dead) socket.
    task.result = { response: 'the real answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'the real answer' })
    const firstResult = await firstPromise
    expect(firstResult.response).toBe('the real answer')

    // Result-recoverability: the taskId the duplicate returned is pollable and
    // yields the prior result (not lost with the dead socket).
    const stored = deps.pendingTaskResults.get(secondResult.taskId!)
    expect(stored).toBeDefined()
    expect(stored!.status).toBe('completed')
    expect(stored!.response).toBe('the real answer')
    // The C3 recoverability entry is tagged deliveredInline: it was already
    // delivered on the first socket and lives here only for poll recovery.
    // It stays pollable (above) but must NOT pin the pendingResults gauge.
    expect(stored!.deliveredInline).toBe(true)
    // No second execution — a single lifecycle record throughout.
    expect(deps.taskLifecycle.getStats().total).toBe(1)
  })

  it('executeAsync also suppresses duplicates and replays the outcome', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-dup-async')

    const first = new IncomingMessageHandler(message, deps)
    first.executeAsync()
    const task = deps.messageQueue.dequeue()!
    task.result = { response: 'async answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'async answer' })

    const second = new IncomingMessageHandler(message, deps)
    const secondResult = second.executeAsync()

    expect(secondResult.success).toBe(true)
    expect(secondResult.status).toBe('completed')
    expect(secondResult.response).toBe('async answer')
    expect(secondResult.taskId).toBe(task.id)
    expect(deps.messageQueue.dequeue()).toBeNull()
  })

  it('fresh messageIds are unaffected — each delivery gets its own execution', () => {
    const deps = createMockDeps()
    const h1 = new IncomingMessageHandler(createTestMessage('msg-fresh-a'), deps)
    const h2 = new IncomingMessageHandler(createTestMessage('msg-fresh-b'), deps)

    const r1 = h1.executeAsync()
    const r2 = h2.executeAsync()

    expect(r1.status).toBe('pending')
    expect(r2.status).toBe('pending')
    expect(r1.taskId).not.toBe(r2.taskId)
    expect(deps.messageQueue.dequeue()).not.toBeNull()
    expect(deps.messageQueue.dequeue()).not.toBeNull()
    expect(deps.taskLifecycle.getStats().total).toBe(2)
  })
})

/**
 * Regression: stateless `pendingResults` idle gauge vs C3 recoverability cache.
 *
 * The C3 fix (commit ca462c6d2) began storing EVERY sync turn's terminal
 * outcome in pendingTaskResults for poll recovery. main.ts's stateless idle
 * gauge computed `pendingResults: pendingTaskResults.size() > 0`, so after ANY
 * sync turn the gauge was pinned true forever (nothing deletes an
 * inline-delivered entry until TTL) → HCC's D8 gate set SuspendBlocked and the
 * stateless host NEVER drained/suspended. The gauge must count only
 * genuinely-pending work: `countWhere(e => !e.deliveredInline)`. These tests
 * mirror that exact predicate so reverting the fix fails them.
 */
describe('IncomingMessageHandler — pendingResults idle gauge decoupling', () => {
  // The main.ts stateless heartbeat gauge for pendingTaskResults, using the
  // IMPORTED production predicate (not a replica) — reverting the
  // delivered-on-read refinement in runtime/resultDelivery.ts fails these.
  const gaugePending = (deps: ReturnType<typeof createMockDeps>): boolean =>
    deps.pendingTaskResults.countWhere(isUndeliveredResult) > 0

  it('a completed SYNC turn does NOT pin the pendingResults idle gauge', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-gauge-sync')

    const handler = new IncomingMessageHandler(message, deps)
    const promise = handler.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!
    task.result = { response: 'sync answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'sync answer' })
    const result = await promise
    expect(result.response).toBe('sync answer')

    // The outcome IS persisted for C3 poll recovery...
    const stored = deps.pendingTaskResults.get(task.id)
    expect(stored).toBeDefined()
    expect(stored!.deliveredInline).toBe(true)
    // ...but it is inline-delivered, so it must NOT keep the host non-idle.
    // This is the exact regression: with size()-backed gauge this was true.
    expect(gaugePending(deps)).toBe(false)
  })

  it('a genuinely-pending ASYNC turn DOES set the pendingResults idle gauge', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-gauge-async')

    const handler = new IncomingMessageHandler(message, deps)
    handler.executeAsync()
    const task = deps.messageQueue.dequeue()!
    task.result = { response: 'async answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    // executeAsync stores the result WITHOUT deliveredInline — nobody consumed
    // it inline, so it is genuinely pending until polled/consumed.
    await task.responseCallback!({ response: 'async answer' })

    const stored = deps.pendingTaskResults.get(task.id)
    expect(stored).toBeDefined()
    expect(stored!.deliveredInline).toBeUndefined()
    // Don't over-correct: async results MUST still pin the gauge.
    expect(gaugePending(deps)).toBe(true)
  })

  it('a POLLED async result unpins the gauge immediately and stays pollable (delivered-on-read)', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-gauge-async-polled')

    const handler = new IncomingMessageHandler(message, deps)
    handler.executeAsync()
    const task = deps.messageQueue.dequeue()!
    task.result = { response: 'async answer', model: 'test-model' }
    deps.messageQueue.completeTask(task)
    await task.responseCallback!({ response: 'async answer' })
    // Undelivered: pins — the spec's hard block for results that would be
    // LOST on suspend applies until somebody actually fetches it.
    expect(gaugePending(deps)).toBe(true)

    // The owner polls GET /v1/runtime/tasks/:id/result — main.ts's
    // handleTaskResult stamps the entry delivered-on-read (NO delete).
    const stored = deps.pendingTaskResults.get(task.id)!
    markResultDelivered(stored)

    // Unpinned immediately — not after the 10-minute TTL.
    expect(gaugePending(deps)).toBe(false)
    // Multi-reader idempotency preserved: repeat polls still return it…
    const again = deps.pendingTaskResults.get(task.id)
    expect(again).toBeDefined()
    expect(again!.response).toBe('async answer')
    // …and the FIRST read's stamp wins (re-polls do not re-stamp).
    const firstStamp = again!.deliveredAt
    expect(firstStamp).toBeGreaterThan(0)
    markResultDelivered(again!)
    expect(deps.pendingTaskResults.get(task.id)!.deliveredAt).toBe(firstStamp)
  })

  it('a post-approval async FAILURE is stored with status failed (not hardcoded completed)', async () => {
    const deps = createMockDeps()
    const message = createTestMessage('msg-post-approval-failed')

    const handler = new IncomingMessageHandler(message, deps)
    const promise = handler.execute()
    await new Promise(r => setTimeout(r, 10))
    const task = deps.messageQueue.dequeue()!

    // First callback resolves the sync socket (handler.resolved = true)…
    await task.responseCallback!({ response: 'inline answer' })
    await promise

    // …then a later (post-approval) callback carries an ERROR. The stored
    // entry must compute its status from the payload — the handler used to
    // hardcode 'completed' here, so the poll reported success:false with a
    // contradictory status.
    await task.responseCallback!({
      response: undefined,
      error: {
        code: 'LLM_INSUFFICIENT_QUOTA',
        message: 'boom',
        retryable: false,
        provider: 'openai',
      },
    })
    const stored = deps.pendingTaskResults.get(task.id)!
    expect(stored.status).toBe('failed')
    expect(stored.error?.message).toBe('boom')
  })
})
