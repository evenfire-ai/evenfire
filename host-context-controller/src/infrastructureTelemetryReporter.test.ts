import { describe, expect, it, vi } from 'vitest'
import {
  BoundedInfrastructureTelemetryReporter,
  createInfrastructureTelemetryReporter,
  hccReconcileOutcomeSourceId,
} from './infrastructureTelemetryReporter'
import { infrastructureTelemetryGapsTotal, infrastructureTelemetryRetriesTotal } from './metrics'

const projection = {
  sourceEventId: 'hcc-health-transition:mcp-host:chatllm:7:active:1',
  occurredAt: '2026-07-11T12:00:00.000Z',
  hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
  payload: { transition: 'lifecycle:active', state: 'active' },
} as const

const reconcileProjection = {
  occurredAt: '2026-07-11T12:00:01.000Z',
  telemetryType: 'reconcile_outcome',
  hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
  payload: {
    resource_class: 'Host',
    reason_code: 'ready',
    status: 'succeeded',
    phase: 'deployed',
    state: 'ready',
  },
} as const

const reconcileSourceEventId = hccReconcileOutcomeSourceId(reconcileProjection)

describe('BoundedInfrastructureTelemetryReporter', () => {
  it('does not instantiate when governed tracing is disabled', () => {
    const reporter = createInfrastructureTelemetryReporter(false, {
      baseUrl: 'http://control-api.test:8090',
    })

    expect(reporter).toBeUndefined()
  })

  it('instantiates when governed tracing is enabled', () => {
    const reporter = createInfrastructureTelemetryReporter(true, {
      baseUrl: 'http://control-api.test:8090',
    })

    expect(reporter).toBeInstanceOf(BoundedInfrastructureTelemetryReporter)
  })

  it('keeps enqueue synchronous and submits the health projection off-path', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090/',
      signToken: () => 'signed-request',
      fetchFn,
    })

    reporter.enqueueHealthTransition(projection)

    expect(fetchFn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!
    expect(url).toBe(
      'http://control-api.test:8090/api/v1/internal/tracing/infrastructure-telemetry-events'
    )
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer signed-request' })
    expect(JSON.parse(String(init?.body))).toEqual({
      events: [{ ...projection, telemetryType: 'health_transition' }],
    })
  })

  it('submits Host-backed reconcile telemetry with server-observed lookup reference', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
    })

    reporter.enqueue(reconcileProjection)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1]?.body))).toEqual({
      events: [{ ...reconcileProjection, sourceEventId: reconcileSourceEventId }],
    })
  })

  it('derives reconcile identity only after enqueue returns', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const deriveReconcileSourceEventId = vi.fn(hccReconcileOutcomeSourceId)
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
      deriveReconcileSourceEventId,
    })

    reporter.enqueue(reconcileProjection)

    expect(deriveReconcileSourceEventId).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deriveReconcileSourceEventId).toHaveBeenCalledOnce()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('derives reconcile identity once and reuses it across transport retries', async () => {
    infrastructureTelemetryRetriesTotal.reset()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true }) as unknown as typeof fetch
    const deriveReconcileSourceEventId = vi.fn(() => 'hcc-reconcile-outcome:stable')
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
      deriveReconcileSourceEventId,
      retryLimit: 1,
      random: () => 0,
    })

    reporter.enqueue(reconcileProjection)
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(deriveReconcileSourceEventId).toHaveBeenCalledOnce()
    expect((await infrastructureTelemetryRetriesTotal.get()).values[0]?.value).toBe(1)
    const sourceIds = vi.mocked(fetchFn).mock.calls.map(call => {
      const body = JSON.parse(String(call[1]?.body)) as { events: Array<{ sourceEventId: string }> }
      return body.events[0]!.sourceEventId
    })
    expect(sourceIds).toEqual(['hcc-reconcile-outcome:stable', 'hcc-reconcile-outcome:stable'])
  })

  it('keeps reconcile identity stable for equivalent state and changes it with the outcome', () => {
    expect(hccReconcileOutcomeSourceId(reconcileProjection)).toMatch(
      /^hcc-reconcile-outcome-v2:[0-9a-f]{64}$/
    )
    expect(hccReconcileOutcomeSourceId(reconcileProjection)).toBe(
      hccReconcileOutcomeSourceId({ ...reconcileProjection })
    )
    expect(hccReconcileOutcomeSourceId(reconcileProjection)).not.toBe(
      hccReconcileOutcomeSourceId({
        ...reconcileProjection,
        payload: {
          ...reconcileProjection.payload,
          reason_code: 'not_ready',
          status: 'failed',
        },
      })
    )
  })

  it('isolates a blackholed submission and continues flushing later telemetry', async () => {
    infrastructureTelemetryGapsTotal.reset()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
      retryLimit: 0,
    })

    reporter.enqueue({
      ...reconcileProjection,
      payload: { ...reconcileProjection.payload, status: 'failed', state: 'not_ready' },
    })
    reporter.enqueue(reconcileProjection)

    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect((await infrastructureTelemetryGapsTotal.get()).values[0]).toMatchObject({
      labels: { telemetry_type: 'reconcile_outcome', reason: 'retry_exhausted' },
      value: 1,
    })
    expect(JSON.parse(String(vi.mocked(fetchFn).mock.calls[1]![1]?.body))).toEqual({
      events: [{ ...reconcileProjection, sourceEventId: reconcileSourceEventId }],
    })
  })

  it('flushes queued telemetry during stop without waiting for the scheduled microtask', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
    })

    reporter.enqueue(reconcileProjection)
    await reporter.stop()

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1]?.body))).toEqual({
      events: [{ ...reconcileProjection, sourceEventId: reconcileSourceEventId }],
    })
  })

  it('bounds stop when a telemetry submission never settles', async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
    const reporter = new BoundedInfrastructureTelemetryReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed-request',
      fetchFn,
      timeoutMs: 1,
    })

    reporter.enqueueHealthTransition(projection)
    const start = Date.now()
    await reporter.stop(10)

    expect(Date.now() - start).toBeLessThan(250)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})
