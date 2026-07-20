import { describe, expect, it, vi } from 'vitest'
import {
  BoundedGovernedTraceReporter,
  type WorkflowInfrastructureTelemetryProjection,
  type WorkflowLifecycleProjection,
  createGovernedTraceReporter,
} from './governedTraceReporter'
import { governedTraceGapsTotal, governedTraceRetriesTotal } from './metrics'

function okResponse(): Response {
  return { ok: true, status: 202 } as Response
}

function rejectedResponse(): Response {
  return { ok: false, status: 503 } as Response
}

function lifecycleProjection(
  overrides: Partial<WorkflowLifecycleProjection> = {}
): WorkflowLifecycleProjection {
  return {
    sourceEventId: 'workflow-run:run-1:start',
    occurredAt: '2026-07-11T10:00:00.000Z',
    runId: 'run-1',
    eventType: 'run_start',
    payload: { phase: 'Running' },
    ...overrides,
  }
}

function telemetryProjection(
  overrides: Partial<WorkflowInfrastructureTelemetryProjection> = {}
): WorkflowInfrastructureTelemetryProjection {
  return {
    sourceEventId: 'workflow-reconcile:recipe-1:ok',
    occurredAt: '2026-07-11T10:00:01.000Z',
    runId: '00000000-0000-4000-8000-000000000001',
    telemetryType: 'reconcile_outcome',
    payload: { phase: 'Ready', status: 'ok' },
    ...overrides,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BoundedGovernedTraceReporter', () => {
  it('does not instantiate when governed tracing is disabled', () => {
    expect(createGovernedTraceReporter(false)).toBeNull()
  })

  it('instantiates when governed tracing is enabled', () => {
    expect(createGovernedTraceReporter(true)).toBeInstanceOf(BoundedGovernedTraceReporter)
  })

  it('keeps enqueue synchronous and offloads signing, serialization, and HTTP work', async () => {
    const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const signToken = vi.fn(() => 'wrc-token')
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090/',
      fetchFn,
      signToken,
    })

    reporter.enqueueWorkflowLifecycle(lifecycleProjection())

    expect(signToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()

    await flushMicrotasks()

    expect(signToken).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('allows only one in-flight flush and schedules the next entry after it settles', async () => {
    let resolveFirst!: (value: Response) => void
    const firstFetch = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValue(okResponse()) as unknown as typeof fetch
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090',
      fetchFn,
      signToken: () => 'wrc-token',
    })

    reporter.enqueueWorkflowLifecycle(lifecycleProjection({ runId: 'run-1' }))
    reporter.enqueueWorkflowLifecycle(
      lifecycleProjection({ sourceEventId: 'workflow-run:run-2:start', runId: 'run-2' })
    )

    await flushMicrotasks()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    resolveFirst(okResponse())
    await flushMicrotasks()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('drops entries beyond capacity without awaiting or expanding the bounded queue', async () => {
    const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090',
      capacity: 1,
      fetchFn,
      signToken: () => 'wrc-token',
    })

    reporter.enqueueWorkflowLifecycle(lifecycleProjection({ runId: 'run-1' }))
    reporter.enqueueWorkflowLifecycle(
      lifecycleProjection({ sourceEventId: 'workflow-run:run-2:start', runId: 'run-2' })
    )

    await flushMicrotasks()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetchFn).mock.calls[0]
    expect(JSON.parse(String(init?.body)).events[0].runId).toBe('run-1')
  })

  it('retries a failed submit within the configured bound and then drops it', async () => {
    vi.useFakeTimers()
    try {
      governedTraceRetriesTotal.reset()
      governedTraceGapsTotal.reset()
      const fetchFn = vi.fn(async () => rejectedResponse()) as unknown as typeof fetch
      const reporter = new BoundedGovernedTraceReporter({
        baseUrl: 'http://control-api:8090',
        fetchFn,
        random: () => 0,
        retryLimit: 2,
        signToken: () => 'wrc-token',
      })

      reporter.enqueueWorkflowLifecycle(lifecycleProjection())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchFn).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(25)
      expect(fetchFn).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(50)
      expect(fetchFn).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect((await governedTraceRetriesTotal.get()).values[0]?.value).toBe(2)
      expect((await governedTraceGapsTotal.get()).values[0]).toMatchObject({
        labels: { family: 'agent_run', type: 'run_start', reason: 'retry_exhausted' },
        value: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('POSTs lifecycle and infrastructure events to the exact WRC bearer submit paths', async () => {
    const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090/',
      fetchFn,
      signToken: () => 'wrc-token',
    })

    reporter.enqueueWorkflowLifecycle(lifecycleProjection())
    reporter.enqueueInfrastructureTelemetry(telemetryProjection())

    await flushMicrotasks()
    await flushMicrotasks()

    expect(vi.mocked(fetchFn).mock.calls.map(([url]) => String(url))).toEqual([
      'http://control-api:8090/api/v1/internal/tracing/agent-run-events',
      'http://control-api:8090/api/v1/internal/tracing/infrastructure-telemetry-events',
    ])
    for (const [, init] of vi.mocked(fetchFn).mock.calls) {
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer wrc-token',
        'Content-Type': 'application/json',
      })
    }
  })

  it('submits only normalized event fields and excludes raw projection data', async () => {
    const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090',
      fetchFn,
      signToken: () => 'wrc-token',
    })
    const projection = {
      ...lifecycleProjection(),
      rawProjection: { privateField: 'omit-me' },
      callerAuth: 'omit-me',
      payload: { phase: 'Running' },
    } as WorkflowLifecycleProjection & { rawProjection: unknown; callerAuth: string }

    reporter.enqueueWorkflowLifecycle(projection)
    await flushMicrotasks()

    const [, init] = vi.mocked(fetchFn).mock.calls[0]
    const bodyText = String(init?.body)
    expect(bodyText).not.toContain('rawProjection')
    expect(bodyText).not.toContain('omit-me')
    expect(JSON.parse(bodyText)).toEqual({
      events: [
        {
          sourceEventId: 'workflow-run:run-1:start',
          occurredAt: '2026-07-11T10:00:00.000Z',
          eventType: 'run_start',
          runId: 'run-1',
          payload: { phase: 'Running' },
        },
      ],
    })
  })

  it('drains already queued lifecycle events and rejects new enqueues after stop starts', async () => {
    const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const reporter = new BoundedGovernedTraceReporter({
      baseUrl: 'http://control-api:8090',
      fetchFn,
      signToken: () => 'wrc-token',
    })

    reporter.enqueueWorkflowLifecycle(lifecycleProjection({ runId: 'run-before-stop' }))

    const drain = reporter.stopAndDrain()
    reporter.enqueueWorkflowLifecycle(
      lifecycleProjection({
        sourceEventId: 'workflow-run:run-after-stop:start',
        runId: 'run-after-stop',
      })
    )

    await expect(drain).resolves.toEqual({ drained: true, dropped: 0 })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetchFn).mock.calls[0]
    expect(JSON.parse(String(init?.body)).events[0].runId).toBe('run-before-stop')
  })

  it('bounds shutdown drain and cancels retry backoff without later submissions', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn(async () => rejectedResponse()) as unknown as typeof fetch
      const reporter = new BoundedGovernedTraceReporter({
        baseUrl: 'http://control-api:8090',
        fetchFn,
        random: () => 0,
        retryLimit: 2,
        signToken: () => 'wrc-token',
      })

      reporter.enqueueWorkflowLifecycle(lifecycleProjection())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const drain = reporter.stopAndDrain(10)
      await vi.advanceTimersByTimeAsync(10)
      await expect(drain).resolves.toEqual({ drained: false, dropped: 1 })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
