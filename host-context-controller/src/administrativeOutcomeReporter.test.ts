import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AdministrativeHostOutcomeProjection,
  BoundedAdministrativeOutcomeReporter,
  createAdministrativeOutcomeReporter,
} from './administrativeOutcomeReporter'
import { administrativeOutcomeReporterTotal } from './metrics'

describe('createAdministrativeOutcomeReporter', () => {
  it('does not construct a reporter when governed tracing is disabled', () => {
    expect(
      createAdministrativeOutcomeReporter(false, {
        baseUrl: 'http://control-api.test:8090',
      })
    ).toBeUndefined()
  })

  it('constructs a reporter when governed tracing is enabled', () => {
    expect(
      createAdministrativeOutcomeReporter(true, {
        baseUrl: 'http://control-api.test:8090',
      })
    ).toBeInstanceOf(BoundedAdministrativeOutcomeReporter)
  })
})

describe('BoundedAdministrativeOutcomeReporter', () => {
  it('submits a typed linked outcome off-path', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedAdministrativeOutcomeReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed',
      fetchFn,
    })
    reporter.enqueueHostOutcome({
      sourceEventId: 'hcc-admin-outcome:op-1:7:succeeded',
      occurredAt: '2026-07-11T10:00:00.000Z',
      hostRef: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      outcome: 'succeeded',
      reasonCode: 'reconciled',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1]?.body))
    expect(body.events[0]).toEqual(
      expect.objectContaining({
        kind: 'linked_outcome',
        sourceStatusRef: 'host:mcp-host/chatllm:generation=7',
        payload: { resource_class: 'Host', status: 'succeeded' },
      })
    )
  })

  it('isolates a failed submission from enqueue and bounds retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('unreachable')) as unknown as typeof fetch
    const reporter = new BoundedAdministrativeOutcomeReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed',
      fetchFn,
      retryLimit: 0,
    })
    expect(() =>
      reporter.enqueueHostOutcome({
        sourceEventId: 'outcome-1',
        occurredAt: '2026-07-11T10:00:00.000Z',
        hostRef: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
        outcome: 'failed',
        reasonCode: 'reconcile_failed',
      })
    ).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('flushes a queued linked outcome during stop without waiting for the scheduled microtask', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = new BoundedAdministrativeOutcomeReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed',
      fetchFn,
    })

    reporter.enqueueHostOutcome({
      sourceEventId: 'outcome-queued',
      occurredAt: '2026-07-11T10:00:00.000Z',
      hostRef: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      outcome: 'succeeded',
      reasonCode: 'reconciled',
    })
    await reporter.stop()

    expect(fetchFn).toHaveBeenCalledOnce()
    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1]?.body))
    expect(body.events[0]).toEqual(
      expect.objectContaining({
        sourceEventId: 'outcome-queued',
        kind: 'linked_outcome',
        sourceStatusRef: 'host:mcp-host/chatllm:generation=7',
      })
    )
  })

  it('contains shutdown submission failures without scheduling retries', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('unreachable')) as unknown as typeof fetch
    const reporter = new BoundedAdministrativeOutcomeReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed',
      fetchFn,
      retryLimit: 5,
      random: () => 0,
    })

    reporter.enqueueHostOutcome({
      sourceEventId: 'outcome-failed',
      occurredAt: '2026-07-11T10:00:00.000Z',
      hostRef: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
      outcome: 'failed',
      reasonCode: 'reconcile_failed',
    })
    await reporter.stop()
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

function outcome(sourceEventId: string): AdministrativeHostOutcomeProjection {
  return {
    sourceEventId,
    occurredAt: '2026-09-18T10:00:00.000Z',
    hostRef: { name: 'chatllm', namespace: 'mcp-host', generation: 7 },
    outcome: 'succeeded',
    reasonCode: 'reconciled',
  }
}

function failedResponse(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return body
    },
  } as unknown as Response
}

async function counted(result: string): Promise<number> {
  const metric = await administrativeOutcomeReporterTotal.get()
  return metric.values.find(value => value.labels.result === result)?.value ?? 0
}

function submittedIds(fetchFn: typeof fetch): string[] {
  return vi.mocked(fetchFn).mock.calls.map(call => {
    const body = JSON.parse(String(call[1]?.body)) as { events: Array<{ sourceEventId: string }> }
    return body.events[0]!.sourceEventId
  })
}

// Default retry delays with random() = 0 are 25 ms then 50 ms.
const settle = () => new Promise(resolve => setTimeout(resolve, 150))

describe('BoundedAdministrativeOutcomeReporter — once per process (#327, #326)', () => {
  beforeEach(() => administrativeOutcomeReporterTotal.reset())

  function reporterWith(fetchFn: typeof fetch, dedupeCapacity?: number) {
    return new BoundedAdministrativeOutcomeReporter({
      baseUrl: 'http://control-api.test:8090',
      signToken: () => 'signed',
      fetchFn,
      random: () => 0,
      ...(dedupeCapacity !== undefined ? { dedupeCapacity } : {}),
    })
  }

  it('sends an accepted outcome once however often the reconciler re-observes it', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = reporterWith(fetchFn)

    reporter.enqueueHostOutcome(outcome('hcc-admin-outcome:op-1:7:succeeded'))
    await settle()
    reporter.enqueueHostOutcome(outcome('hcc-admin-outcome:op-1:7:succeeded'))
    reporter.enqueueHostOutcome(outcome('hcc-admin-outcome:op-1:7:succeeded'))
    await settle()

    expect(fetchFn).toHaveBeenCalledOnce()
    expect(await counted('accepted')).toBe(1)
    expect(await counted('deduplicated')).toBe(2)
  })

  it('settles a 409 idempotency conflict without retry and deduplicates the key afterwards', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { events: Array<{ sourceEventId: string }> })
        .events[0]!.sourceEventId
      return id === 'conflicting'
        ? failedResponse(409, { code: 'tracing_idempotency_conflict', error: 'conflict' })
        : failedResponse(500, { error: 'Internal server error' })
    }) as unknown as typeof fetch
    const reporter = reporterWith(fetchFn)

    reporter.enqueueHostOutcome(outcome('conflicting'))
    reporter.enqueueHostOutcome(outcome('transient'))
    await settle()
    reporter.enqueueHostOutcome(outcome('conflicting'))
    await settle()

    const ids = submittedIds(fetchFn)
    // Liveness: the transient failure on another key is retried twice.
    expect(ids.filter(id => id === 'transient')).toHaveLength(3)
    expect(ids.filter(id => id === 'conflicting')).toHaveLength(1)
    expect(await counted('conflict')).toBe(1)
    expect(await counted('deduplicated')).toBe(1)
  })

  it('sends an outcome again after its retries were exhausted', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(failedResponse(500))
      .mockResolvedValueOnce(failedResponse(500))
      .mockResolvedValueOnce(failedResponse(500))
      .mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = reporterWith(fetchFn)

    reporter.enqueueHostOutcome(outcome('hcc-admin-outcome:op-1:7:failed'))
    await settle()
    expect(await counted('retry_exhausted')).toBe(1)
    reporter.enqueueHostOutcome(outcome('hcc-admin-outcome:op-1:7:failed'))
    await settle()

    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(await counted('accepted')).toBe(1)
    expect(await counted('deduplicated')).toBe(0)
  })

  it.each([
    ['a 403 binding not yet visible', failedResponse(403, { error: 'Forbidden' })],
    [
      'a 403 whose code is not terminal',
      failedResponse(403, { code: 'tracing_binding_unavailable' }),
    ],
    ['a 409 without a body', failedResponse(409)],
    ['a 409 without a code', failedResponse(409, { error: 'Conflict' })],
    ['a 400 with another code', failedResponse(400, { code: 'invalid_tracing_input' })],
  ])('keeps retrying %s', async (_label, response) => {
    const fetchFn = vi.fn().mockResolvedValue(response) as unknown as typeof fetch
    const reporter = reporterWith(fetchFn)

    reporter.enqueueHostOutcome(outcome('retryable'))
    await settle()

    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(await counted('retry_exhausted')).toBe(1)
    expect(await counted('conflict')).toBe(0)
    expect(await counted('rejected')).toBe(0)
  })

  it('forgets the oldest settled outcome once the dedupe bound is reached', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const reporter = reporterWith(fetchFn, 2)

    for (const id of ['first', 'second', 'third']) reporter.enqueueHostOutcome(outcome(id))
    await settle()
    reporter.enqueueHostOutcome(outcome('third'))
    reporter.enqueueHostOutcome(outcome('first'))
    await settle()

    // 'third' is still remembered (witness); 'first' was evicted and is sent again.
    expect(submittedIds(fetchFn)).toEqual(['first', 'second', 'third', 'first'])
    expect(await counted('deduplicated')).toBe(1)
  })
})
