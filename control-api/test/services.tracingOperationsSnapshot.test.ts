import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { pool } from '../src/db.js'
import { getTracingOperationsRecentErrorSeconds } from '../src/services/tracing/operationalLimits.js'
import type { TracingOperationsLimits } from '../src/services/tracing/operations/contracts.js'
import type {
  MetricSample,
  TracingOperationsMetricState,
} from '../src/services/tracing/operations/metricState.js'
import { TracingOperationsSnapshotService } from '../src/services/tracing/operations/tracingOperationsSnapshotService.js'

const NOW = new Date('2026-07-13T12:00:00.000Z')
const LIMITS: TracingOperationsLimits = {
  bodyBytes: 524_288,
  eventsPerRequest: 100,
  maxInFlight: 32,
  ingestPoolMax: 4,
  readPoolMax: 3,
  poolConnectionTimeoutMs: 2_000,
  ingestStatementTimeoutMs: 5_000,
  readStatementTimeoutMs: 2_000,
  recentErrorSeconds: 300,
}

function sample(value: number, labels: MetricSample['labels'] = {}): MetricSample {
  return { value, labels }
}

function state(
  overrides: Partial<TracingOperationsMetricState> = {}
): TracingOperationsMetricState {
  return {
    accepted: [],
    replayed: [],
    rejected: [],
    conflicting: [],
    admission: [],
    operationalErrors: [],
    inFlight: [],
    poolConnections: [],
    poolRejections: [],
    poolStatementTimeouts: [],
    lastErrors: [],
    ...overrides,
  }
}

function service(metrics: TracingOperationsMetricState, limits: TracingOperationsLimits = LIMITS) {
  return new TracingOperationsSnapshotService({
    now: () => NOW,
    instanceStartedAt: '2026-07-13T11:00:00.000Z',
    readMetrics: async () => metrics,
    readLimits: () => limits,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.TRACING_OPERATIONS_RECENT_ERROR_SECONDS
})

describe('TracingOperationsSnapshotService', () => {
  it('keeps the snapshot module graph free of database, Kubernetes, filesystem, and network clients', () => {
    const sourceFiles = [
      '../src/services/tracing/operationalLimits.ts',
      '../src/services/tracing/operations/contracts.ts',
      '../src/services/tracing/operations/metricState.ts',
      '../src/services/tracing/operations/operationalStatus.ts',
      '../src/services/tracing/operations/tracingOperationsSnapshotService.ts',
    ]
    const forbiddenImport =
      /(?:from\s+|import\s*\()\s*['"](?:pg|node:(?:fs|http|https|net|tls)|[^'"]*(?:db|k8s|pools)\.js)['"]/

    for (const relativePath of sourceFiles) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      expect(source, relativePath).not.toMatch(forbiddenImport)
    }
  })

  it('returns an honest healthy since-restart snapshot from current metric objects', async () => {
    const snapshot = await service(
      state({
        accepted: [sample(4), sample(6)],
        replayed: [sample(2)],
        admission: [sample(9, { result: 'accepted', reason: 'none' })],
        poolConnections: [
          sample(2, { pool: 'ingest', state: 'active' }),
          sample(1, { pool: 'ingest', state: 'idle' }),
          sample(1, { pool: 'read', state: 'idle' }),
        ],
      })
    ).read()

    expect(snapshot).toMatchObject({
      generatedAt: NOW.toISOString(),
      instanceStartedAt: '2026-07-13T11:00:00.000Z',
      scope: 'control-api-instance',
      health: 'healthy',
      limits: LIMITS,
      ingestion: {
        acceptedEvents: 10,
        replayedEvents: 2,
        rejectedEvents: 0,
        conflictingEvents: 0,
        admissionRequests: 9,
        admissionRejected: 0,
        inFlight: 0,
      },
    })
    expect(snapshot.pools).toEqual([
      expect.objectContaining({ name: 'ingest', active: 2, idle: 1, waiting: 0 }),
      expect.objectContaining({ name: 'read', active: 0, idle: 1, waiting: 0 }),
    ])
    expect(snapshot.errors).toEqual([])
  })

  it('shows oversized requests with the canonical message, hard ceiling, and warning health', async () => {
    const occurredAtSeconds = NOW.getTime() / 1_000 - 30
    const snapshot = await service(
      state({
        admission: [
          sample(3, { family: 'agent_run', result: 'rejected', reason: 'body_too_large' }),
        ],
        operationalErrors: [sample(3, { scope: 'agent_run', reason: 'body_too_large' })],
        lastErrors: [sample(occurredAtSeconds, { scope: 'agent_run', reason: 'body_too_large' })],
      })
    ).read()

    expect(snapshot.health).toBe('warning')
    expect(snapshot.errors).toEqual([
      {
        reason: 'body_too_large',
        message: 'Tracing request exceeded 512 KiB and was rejected.',
        severity: 'warning',
        countSinceRestart: 3,
        lastOccurredAt: '2026-07-13T11:59:30.000Z',
        relatedSetting: '512 KiB hard ceiling (not ENV-configurable)',
        effectiveValue: 524_288,
        operatorAction:
          'Reduce payload fields or split the request; do not raise the hard ceiling.',
      },
    ])
  })

  it('keeps informational and old errors visible without falsely escalating current health', async () => {
    const snapshot = await service(
      state({
        admission: [
          sample(1, { result: 'rejected', reason: 'invalid_json' }),
          sample(2, { result: 'rejected', reason: 'batch_too_large' }),
        ],
        operationalErrors: [
          sample(1, { scope: 'agent_run', reason: 'invalid_json' }),
          sample(2, { scope: 'agent_run', reason: 'batch_too_large' }),
        ],
        lastErrors: [
          sample(NOW.getTime() / 1_000 - 10, { scope: 'agent_run', reason: 'invalid_json' }),
          sample(NOW.getTime() / 1_000 - 600, {
            scope: 'agent_run',
            reason: 'batch_too_large',
          }),
        ],
      })
    ).read()

    expect(snapshot.health).toBe('healthy')
    expect(snapshot.errors.map(error => error.reason)).toEqual(['batch_too_large', 'invalid_json'])
  })

  it('classifies recent pool failure and a saturated request budget as critical', async () => {
    const snapshot = await service(
      state({
        inFlight: [sample(32)],
        poolConnections: [sample(1, { pool: 'read', state: 'waiting' })],
        poolRejections: [sample(2, { pool: 'read' })],
        poolStatementTimeouts: [sample(1, { pool: 'ingest' })],
        operationalErrors: [
          sample(2, { scope: 'pool', reason: 'pool_rejected' }),
          sample(1, { scope: 'pool', reason: 'statement_timeout' }),
        ],
        lastErrors: [
          sample(NOW.getTime() / 1_000 - 5, { scope: 'pool', reason: 'pool_rejected' }),
          sample(NOW.getTime() / 1_000 - 4, { scope: 'pool', reason: 'statement_timeout' }),
        ],
      })
    ).read()

    expect(snapshot.health).toBe('critical')
    expect(snapshot.pools[1]).toMatchObject({ name: 'read', waiting: 1, rejectedSinceRestart: 2 })
    expect(snapshot.errors.map(error => [error.reason, error.severity])).toEqual([
      ['pool_rejected', 'critical'],
      ['statement_timeout', 'critical'],
    ])
  })

  it('keeps operational occurrence counts independent from atomic rejected-event totals', async () => {
    const snapshot = await service(
      state({
        rejected: [sample(100)],
        conflicting: [sample(1)],
        operationalErrors: [
          sample(2, { scope: 'agent_run', reason: 'event_rejected' }),
          sample(1, { scope: 'agent_run', reason: 'idempotency_conflict' }),
        ],
        lastErrors: [
          sample(NOW.getTime() / 1_000, { scope: 'agent_run', reason: 'event_rejected' }),
          sample(NOW.getTime() / 1_000, {
            scope: 'agent_run',
            reason: 'idempotency_conflict',
          }),
        ],
      })
    ).read()

    expect(
      snapshot.errors.find(error => error.reason === 'event_rejected')?.countSinceRestart
    ).toBe(2)
    expect(
      snapshot.errors.find(error => error.reason === 'idempotency_conflict')?.countSinceRestart
    ).toBe(1)
    expect(snapshot.ingestion).toMatchObject({ rejectedEvents: 100, conflictingEvents: 1 })
  })

  it('exposes closed binding and prompt capture reasons without sensitive context', async () => {
    const reasons = [
      'attribution_binding_unavailable',
      'attribution_binding_conflict',
      'prompt_history_disabled',
      'prompt_history_key_unavailable',
      'prompt_history_rejected',
    ] as const
    const snapshot = await service(
      state({
        operationalErrors: reasons.map(reason => sample(1, { scope: 'agent_run', reason })),
        lastErrors: reasons.map(reason =>
          sample(NOW.getTime() / 1_000, {
            scope: 'agent_run',
            reason,
          })
        ),
      })
    ).read()

    expect(snapshot.health).toBe('warning')
    expect(snapshot.errors.map(error => error.reason).sort()).toEqual([...reasons].sort())
    expect(JSON.stringify(snapshot)).not.toMatch(
      /runId|sessionId|hostRef|userId|approvalRequestId|promptText/
    )
  })

  it('treats a recent unexpected submission failure as critical without exposing raw errors', async () => {
    const snapshot = await service(
      state({
        operationalErrors: [sample(1, { scope: 'agent_run', reason: 'submission_failed' })],
        lastErrors: [
          sample(NOW.getTime() / 1_000 - 2, {
            scope: 'agent_run',
            reason: 'submission_failed',
          }),
        ],
      })
    ).read()

    expect(snapshot.health).toBe('critical')
    expect(snapshot.errors).toEqual([
      expect.objectContaining({
        reason: 'submission_failed',
        message: 'A tracing submission failed after request admission.',
        countSinceRestart: 1,
      }),
    ])
    expect(JSON.stringify(snapshot)).not.toContain('stack')
  })

  it('reads only in-process metrics within a bounded response and latency budget', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const querySpy = vi.spyOn(pool, 'query')
    const startedAt = performance.now()

    const snapshot = await new TracingOperationsSnapshotService().read()

    expect(performance.now() - startedAt).toBeLessThan(100)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(16 * 1024)
    expect(snapshot.errors.length).toBeLessThanOrEqual(10)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('uses one bounded health-recency ENV and falls back for invalid values', () => {
    process.env.TRACING_OPERATIONS_RECENT_ERROR_SECONDS = '900'
    expect(getTracingOperationsRecentErrorSeconds()).toBe(900)
    process.env.TRACING_OPERATIONS_RECENT_ERROR_SECONDS = '999999'
    expect(getTracingOperationsRecentErrorSeconds()).toBe(300)
  })
})
