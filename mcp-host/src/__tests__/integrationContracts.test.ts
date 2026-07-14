/**
 * Integration contract tests for task-cancel v2.
 *
 * These tests verify cross-layer contracts that are not already covered by
 * the unit-level suites. They are intentionally distinct from:
 *   - lifecycle/__tests__/regressionBugs.test.ts  (BUG-1–6, unit-level)
 *   - __tests__/phaseC-contracts.test.ts          (MessageQueue 5-field shape + event sequence)
 *   - __tests__/server.cancel.contract.test.ts    (HTTP 204/404/501 status codes)
 *
 * Coverage added here:
 *   A. TaskLifecycle.getStats() v2 shape — 6 fields including `cancelled`.
 *      (phaseC covers MessageQueue.getStats() 5-field shape; this covers the
 *      underlying source-of-truth layer that drives /v1/runtime/status.)
 *   B. HTTP /v1/runtime/status response shape through the real RPCServer —
 *      verifies the onStatus wiring propagates the correct queue field names.
 *   C. Cancel-pending tombstone observed from the SessionProcessor.task:skipped
 *      perspective with enqueue-after-cancel ordering (vs. cancel-before-enqueue
 *      in regressionBugs BUG-1).
 */
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ---------------------------------------------------------------------------
// A. TaskLifecycle.getStats() — v2 shape (6 fields, includes `cancelled`)
// ---------------------------------------------------------------------------

describe('Integration contract A: TaskLifecycle.getStats() v2 shape', () => {
  it('returns all 6 fields including `cancelled` after a mixed-state lifecycle', async () => {
    const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
    const { buildTask } = await import('../lifecycle/__tests__/helpers')

    const lc = new TaskLifecycle()

    const pending = buildTask({ id: 'ic-a-pending' })
    const processing = buildTask({ id: 'ic-a-processing' })
    const completed = buildTask({ id: 'ic-a-completed' })
    const cancelled = buildTask({ id: 'ic-a-cancelled' })

    lc.register(pending)
    lc.register(processing)
    lc.register(completed)
    lc.register(cancelled)

    lc.transition('ic-a-processing', 'processing', 'dispatched')
    lc.transition('ic-a-completed', 'processing', 'dispatched')
    lc.transition('ic-a-completed', 'completed', 'natural')
    lc.transition('ic-a-cancelled', 'cancelled', 'user_requested')

    const stats = lc.getStats()

    // Exact 6-field v2 shape (lifecycle layer).
    expect(Object.keys(stats).sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'pending',
      'processing',
      'total',
    ])

    expect(stats.pending).toBe(1)
    expect(stats.processing).toBe(1)
    expect(stats.completed).toBe(1)
    expect(stats.cancelled).toBe(1)
    expect(stats.failed).toBe(0)
    expect(stats.total).toBe(4)
  })

  it('`cancelled` count is not exposed by MessageQueue.getStats() (no leak to legacy consumers)', async () => {
    const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
    const { MessageQueue } = await import('../queue/messageQueue')
    const { buildTask } = await import('../lifecycle/__tests__/helpers')

    const lc = new TaskLifecycle()
    const mq = new MessageQueue()
    mq.setLifecycle(lc)

    const task = buildTask({ id: 'ic-a-noleak' })
    lc.register(task)
    lc.transition('ic-a-noleak', 'cancelled', 'user_requested')

    // MessageQueue.getStats() strips the `cancelled` field for backward compatibility
    // (spec §4.2 — legacy consumers like /v1/runtime/status expect the 5-field shape).
    const mqStats = mq.getStats()
    expect(Object.keys(mqStats).sort()).toEqual([
      'completed',
      'failed',
      'pending',
      'processing',
      'total',
    ])
    expect((mqStats as unknown as Record<string, unknown>)['cancelled']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// B. HTTP /v1/runtime/status — wiring and field shape
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
})

describe('Integration contract B: GET /v1/runtime/status HTTP shape', () => {
  const rpcEdgeHeaders = {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-1',
  }

  async function startServerWithStatus(
    statusPayload: Record<string, unknown>
  ): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
    vi.resetModules()
    const { RPCServer } = await import('../server')
    const server = new RPCServer(0)
    server.onStatus(async () => statusPayload as any)
    await server.start()
    const address = (server as any).server.address() as AddressInfo
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      stop: () => server.stop(),
    }
  }

  it('returns the onStatus payload verbatim with 200', async () => {
    const payload = {
      agent: {
        state: 'idle',
        currentTaskId: null,
        tasksProcessed: 0,
        tasksSucceeded: 0,
        tasksFailed: 0,
        uptime: 42,
      },
      queue: { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 },
      cronJobs: 0,
    }
    const { baseUrl, stop } = await startServerWithStatus(payload)
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/status`, { headers: rpcEdgeHeaders })
      expect(res.status).toBe(200)
      const body = (await res.json()) as typeof payload
      // The queue sub-object must match the 5-field legacy shape.
      expect(Object.keys(body.queue).sort()).toEqual([
        'completed',
        'failed',
        'pending',
        'processing',
        'total',
      ])
      // Cancelled must NOT appear in the HTTP response's queue shape.
      expect((body.queue as Record<string, unknown>)['cancelled']).toBeUndefined()
      expect(body.agent.state).toBe('idle')
      expect(body.cronJobs).toBe(0)
    } finally {
      await stop()
    }
  })

  it('returns 200 with a fallback message when no status handler is wired', async () => {
    vi.resetModules()
    const { RPCServer } = await import('../server')
    const server = new RPCServer(0)
    // Intentionally do NOT call server.onStatus(...)
    await server.start()
    const address = (server as any).server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/status`, { headers: rpcEdgeHeaders })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      // Handler not configured → routes.ts returns { status: "ok", message: "..." }
      expect(body['status']).toBe('ok')
    } finally {
      await server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// C. Cancel-pending tombstone — enqueue-after-cancel ordering
// ---------------------------------------------------------------------------

describe('Integration contract C: Cancel-pending tombstone (enqueue-after-cancel)', () => {
  it('task cancelled BETWEEN enqueue and dispatch is skipped by SessionProcessor, executor not called', async () => {
    // This tests the *enqueue-then-cancel* interleaving:
    //   1. Session A occupies the single concurrency slot (blocker).
    //   2. Session B's task is enqueued — it queues because slot is taken.
    //   3. Cancel arrives while the task waits in session B's queue.
    //   4. When session A completes and the slot opens, SessionProcessor's
    //      check-before-dispatch sees task B is already terminal →
    //      emits task:skipped, executor is never called.
    //
    // The complementary test (cancel-BEFORE-enqueue) lives in
    // lifecycle/__tests__/regressionBugs.test.ts BUG-1.

    const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
    const { SessionProcessor } = await import('../session/sessionProcessor')
    const { buildTask } = await import('../lifecycle/__tests__/helpers')

    const lc = new TaskLifecycle()

    let resolveBlocker!: (value: boolean) => void
    const blockerDone = new Promise<boolean>(r => {
      resolveBlocker = r
    })

    const executorFn = vi.fn((task: any) => {
      // First call = blocker; returns a promise we control.
      // Second call = the to-be-cancelled task — should never happen.
      if (task.id === 'ic-c-blocker') return blockerDone
      return Promise.resolve(false)
    })

    // maxConcurrent=1 — only one session can run at a time.
    const sp = new SessionProcessor({ maxConcurrent: 1, executor: executorFn, lifecycle: lc })

    // Register + enqueue the blocker task to occupy the slot.
    const blocker = buildTask({ id: 'ic-c-blocker' })
    lc.register(blocker)
    sp.enqueue('session-a', blocker)
    // Slot is now occupied — blocker executor is running (holding blockerDone).

    // The to-be-cancelled task for session B.
    const target = buildTask({ id: 'ic-c-target' })
    lc.register(target)

    // Enqueue target in session B while slot is occupied → goes into queue, not dispatched yet.
    const skipped = new Promise<void>(r => sp.once('task:skipped', () => r()))
    sp.enqueue('session-b', target)

    // Cancel target now — it is pending in session B's queue (tombstone set).
    lc.transition('ic-c-target', 'cancelled', 'user_requested')

    // Release the blocker so the slot opens and SessionProcessor tries session B.
    resolveBlocker(false)

    // SessionProcessor check-before-dispatch finds target already_terminal → task:skipped.
    await skipped

    // Executor must only have been called for the blocker, never for target.
    expect(executorFn).toHaveBeenCalledTimes(1)
    expect(executorFn.mock.calls[0]?.[0]).toMatchObject({ id: 'ic-c-blocker' })
    expect(lc.getStatus('ic-c-target')).toBe('cancelled')
  })

  it('task:skipped event payload includes the outcome kind (already_terminal or illegal)', async () => {
    const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
    const { SessionProcessor } = await import('../session/sessionProcessor')
    const { buildTask } = await import('../lifecycle/__tests__/helpers')

    const lc = new TaskLifecycle()
    const executor = vi.fn().mockResolvedValue(false)
    const sp = new SessionProcessor({ maxConcurrent: 1, executor, lifecycle: lc })

    const task = buildTask({ id: 'ic-c-payload' })
    lc.register(task)
    lc.transition('ic-c-payload', 'cancelled', 'user_requested')

    const skippedEvent = new Promise<{ outcome: { kind: string } }>(r =>
      sp.once('task:skipped', (ev: any) => r(ev))
    )
    sp.enqueue('session-payload', task)
    const ev = await skippedEvent

    // The outcome kind tells callers WHY the task was skipped.
    expect(ev.outcome.kind).toBe('already_terminal')
  })
})
