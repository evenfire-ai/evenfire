import { describe, expect, it, vi } from 'vitest'
import {
  BoundedAdministrativeOutcomeReporter,
  createAdministrativeOutcomeReporter,
} from './administrativeOutcomeReporter'

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
