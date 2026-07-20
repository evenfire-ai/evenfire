import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import {
  governedRunDroppedTotal,
  governedRunEnqueuedTotal,
  governedRunFlushesTotal,
  governedRunGapsTotal,
} from './governedRunMetrics.js'
import {
  type GovernedRunEvent,
  GovernedRunReporter,
  LlmUsageEvent,
  UsageReporter,
  createGovernedRunReporter,
  newRequestId,
} from './usageReporter.js'

function makeEvent(overrides: Partial<LlmUsageEvent> = {}): LlmUsageEvent {
  return {
    request_id: newRequestId(),
    ts: new Date().toISOString(),
    run_id: null,
    host_ref: 'trader',
    context_ref: 'trader-context',
    team_id: '11111111-1111-4111-8111-111111111111',
    provider: 'openai',
    model: 'gpt-4o',
    llm_secret_name: 'openai-key',
    source_kind: 'desktop',
    user_id: 'user-1',
    sender: null,
    channel_type: null,
    recipe_name: null,
    cron_job_id: null,
    task_id: null,
    iteration: null,
    input_tokens: 100,
    output_tokens: 50,
    ...overrides,
  }
}

function makeFetchOk() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 })
}

describe('UsageReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the oldest event on overflow', () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      ringCapacity: 3,
      randomJitter: () => 0.999,
    })
    const a = makeEvent({ task_id: 'a' })
    const b = makeEvent({ task_id: 'b' })
    const c = makeEvent({ task_id: 'c' })
    const d = makeEvent({ task_id: 'd' })
    reporter.enqueue(a)
    reporter.enqueue(b)
    reporter.enqueue(c)
    reporter.enqueue(d)
    expect(reporter.bufferSize()).toBe(3)
    reporter.stop()
  })

  it('flushes the buffer once per tick with the current access token', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 'jwt-access',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://control/api/v1/internal/usage/llm/events')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer jwt-access')
    expect(headers['x-service-token']).toBeUndefined()
    expect(reporter.bufferSize()).toBe(0)
    reporter.stop()
  })

  it('reads the access token fresh on every flush so rotation propagates', async () => {
    const fetchImpl = makeFetchOk()
    let token = 'first'
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => token,
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent({ task_id: '1' }))
    await vi.advanceTimersByTimeAsync(0)
    token = 'second'
    reporter.enqueue(makeEvent({ task_id: '2' }))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstHeaders = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >
    const secondHeaders = (fetchImpl.mock.calls[1]![1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(firstHeaders.authorization).toBe('Bearer first')
    expect(secondHeaders.authorization).toBe('Bearer second')
    reporter.stop()
  })

  it('jitters the first flush within [0, flushIntervalMs)', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0.5,
    })
    reporter.enqueue(makeEvent())
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchImpl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    reporter.stop()
  })

  it('skips the network call when the buffer is empty', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    reporter.stop()
  })

  it('re-queues on 5xx so the next tick retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 })
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(reporter.bufferSize()).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(reporter.bufferSize()).toBe(0)
    reporter.stop()
  })

  it('re-queues when fetch throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('econn'))
      .mockResolvedValue({ ok: true, status: 200 })
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(reporter.bufferSize()).toBe(1)
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('drain() flushes outside the tick schedule', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0.99,
    })
    reporter.enqueue(makeEvent())
    expect(fetchImpl).not.toHaveBeenCalled()
    await reporter.drain()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    reporter.stop()
  })

  it('triggers refreshOnUnauthorized on 401 and reads the new token next tick', async () => {
    let token = 'expired'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    const refreshOnUnauthorized = vi.fn(async () => {
      token = 'fresh'
    })
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => token,
      refreshOnUnauthorized,
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // First tick: fires the 401, refreshes the token, re-queues the batch.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(reporter.bufferSize()).toBe(1)
    expect(fetchImpl.mock.calls[0]?.[1]?.headers?.authorization).toBe('Bearer expired')
    // Next tick: retries with the fresh token.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]?.headers?.authorization).toBe('Bearer fresh')
    expect(reporter.bufferSize()).toBe(0)
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('does NOT refresh on non-401 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    const refreshOnUnauthorized = vi.fn(async () => {})
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      refreshOnUnauthorized,
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(refreshOnUnauthorized).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('isolates permanently rejected 4xx events without requeueing the whole batch', async () => {
    const invalid = makeEvent({ request_id: '00000000-0000-4000-8000-000000000001' })
    const valid = makeEvent({ request_id: '00000000-0000-4000-8000-000000000002' })
    const accepted: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(String(init?.body)).events as Array<{ request_id: string }>
      if (events.length > 1) return { ok: false, status: 400 }
      if (events[0]?.request_id === invalid.request_id) return { ok: false, status: 422 }
      accepted.push(events[0]!.request_id)
      return { ok: true, status: 200 }
    })
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(invalid)
    reporter.enqueue(valid)
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await vi.advanceTimersByTimeAsync(0)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(accepted).toEqual([valid.request_id])
    expect(reporter.bufferSize()).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(invalid.request_id))
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('survives a refreshOnUnauthorized that throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const refreshOnUnauthorized = vi.fn(async () => {
      throw new Error('refresh blew up')
    })
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      refreshOnUnauthorized,
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(0)
    // The reporter must not crash; the batch stays queued for the next tick.
    expect(reporter.bufferSize()).toBe(1)
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('stop() prevents further flushes', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new UsageReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 't',
      fetchImpl,
      flushIntervalMs: 60_000,
      randomJitter: () => 0,
    })
    reporter.enqueue(makeEvent())
    reporter.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('GovernedRunReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    governedRunEnqueuedTotal.reset()
    governedRunDroppedTotal.reset()
    governedRunGapsTotal.reset()
    governedRunFlushesTotal.reset()
  })
  afterEach(() => vi.useRealTimers())

  it('does not instantiate when governed tracing is disabled', () => {
    const reporter = createGovernedRunReporter(false, {
      baseUrl: 'http://control-api',
      getAccessToken: () => 'bearer',
    })

    expect(reporter).toBeNull()
  })

  it('instantiates when governed tracing is enabled', () => {
    const reporter = createGovernedRunReporter(true, {
      baseUrl: 'http://control-api',
      getAccessToken: () => 'bearer',
    })

    expect(reporter).toBeInstanceOf(GovernedRunReporter)
    reporter?.stop()
  })

  it('keeps enqueue bounded and flushes a batch with the current access token', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new GovernedRunReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 'runtime-access',
      fetchImpl,
      flushIntervalMs: 10,
      capacity: 2,
    })
    const event = (id: string) => ({
      sourceEventId: id,
      occurredAt: '2026-07-11T10:00:00.000Z',
      eventType: 'run_start' as const,
      runId: '11111111-1111-4111-8111-111111111111',
      hostRef: 'mcp-host/demo',
      origin: 'direct_chat' as const,
    })
    reporter.enqueue(event('oldest'))
    reporter.enqueue(event('kept-1'))
    reporter.enqueue(event('kept-2'))
    expect(reporter.bufferSize()).toBe(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]?.headers).toMatchObject({
      authorization: 'Bearer runtime-access',
    })
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body))
    expect(body.events.map((value: { sourceEventId: string }) => value.sourceEventId)).toEqual([
      'kept-1',
      'kept-2',
    ])
    const gaps = await register.getSingleMetric('clerum_mcp_host_governed_trace_gaps_total')!.get()
    expect(gaps.values).toContainEqual(
      expect.objectContaining({
        labels: expect.objectContaining({ type: 'run_start', reason: 'buffer_full' }),
        value: 1,
      })
    )
    reporter.stop()
  })

  it('evicts verbose events before lifecycle and approval events under pressure', async () => {
    const fetchImpl = makeFetchOk()
    const reporter = new GovernedRunReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 'runtime-access',
      fetchImpl,
      flushIntervalMs: 10,
      capacity: 3,
    })
    const event = (sourceEventId: string, eventType: GovernedRunEvent['eventType']) => ({
      sourceEventId,
      occurredAt: '2026-07-11T10:00:00.000Z',
      eventType,
      runId: '11111111-1111-4111-8111-111111111111',
      hostRef: 'mcp-host/demo',
      origin: 'channel_event' as const,
    })
    reporter.enqueue(event('start', 'run_start'))
    reporter.enqueue(event('verbose-1', 'llm_call'))
    reporter.enqueue(event('verbose-2', 'tool_call'))
    reporter.enqueue(event('approval', 'approval'))
    reporter.enqueue(event('end', 'run_end'))

    await vi.advanceTimersByTimeAsync(10)
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body))
    expect(body.events.map((value: { sourceEventId: string }) => value.sourceEventId)).toEqual([
      'start',
      'approval',
      'end',
    ])
    const drops = await register
      .getSingleMetric('clerum_mcp_host_governed_trace_dropped_total')!
      .get()
    expect(
      drops.values
        .filter(
          value => value.labels.priority === 'verbose' && value.labels.reason === 'buffer_full'
        )
        .reduce((total, value) => total + value.value, 0)
    ).toBe(2)
    expect((await governedRunGapsTotal.get()).values).toHaveLength(0)
    reporter.stop()
  })

  it('isolates a permanently rejected event without blocking a valid event', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(String(init?.body)).events as Array<{ sourceEventId: string }>
      const rejected = events.some(event => event.sourceEventId === 'poison')
      return new Response('', { status: rejected ? 403 : 200 })
    }) as unknown as typeof fetch
    const reporter = new GovernedRunReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 'runtime-access',
      fetchImpl,
      flushIntervalMs: 10,
    })
    reporter.enqueue({
      sourceEventId: 'poison',
      occurredAt: '2026-07-11T10:00:00.000Z',
      eventType: 'llm_call',
      runId: '11111111-1111-4111-8111-111111111111',
      hostRef: 'mcp-host/demo',
      origin: 'api',
    })
    reporter.enqueue({
      sourceEventId: 'valid',
      occurredAt: '2026-07-11T10:00:01.000Z',
      eventType: 'run_start',
      runId: '22222222-2222-4222-8222-222222222222',
      hostRef: 'mcp-host/demo',
      origin: 'api',
    })

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(reporter.bufferSize()).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sourceEventId=poison'))
    consoleSpy.mockRestore()
    reporter.stop()
  })

  it('requeues a failed batch without throwing into the producer path', async () => {
    const reporter = new GovernedRunReporter({
      baseUrl: 'http://control',
      getAccessToken: () => 'runtime-access',
      fetchImpl: vi.fn().mockRejectedValue(new Error('unreachable')),
      flushIntervalMs: 10,
    })
    expect(() =>
      reporter.enqueue({
        sourceEventId: 'run-1',
        occurredAt: '2026-07-11T10:00:00.000Z',
        eventType: 'run_start',
        runId: '11111111-1111-4111-8111-111111111111',
        hostRef: 'mcp-host/demo',
        origin: 'api',
      })
    ).not.toThrow()
    await vi.advanceTimersByTimeAsync(10)
    expect(reporter.bufferSize()).toBe(1)
    reporter.stop()
  })
})
