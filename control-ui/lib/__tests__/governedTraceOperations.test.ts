import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '../api'
import { getTracingOperationsSnapshot } from '../governedTrace'

vi.mock('../api', () => ({ apiGet: vi.fn() }))

const mockApiGet = vi.mocked(apiGet)

afterEach(() => vi.clearAllMocks())

describe('getTracingOperationsSnapshot', () => {
  it('accepts the current prompt-history operational reason contract', async () => {
    const snapshot = {
      scope: 'control-api-instance',
      health: 'healthy',
      generatedAt: '2026-07-13T12:00:00.000Z',
      instanceStartedAt: '2026-07-13T11:00:00.000Z',
      limits: {
        bodyBytes: 524_288,
        eventsPerRequest: 100,
        maxInFlight: 32,
        ingestPoolMax: 4,
        readPoolMax: 3,
        poolConnectionTimeoutMs: 2_000,
        ingestStatementTimeoutMs: 5_000,
        readStatementTimeoutMs: 2_000,
        recentErrorSeconds: 300,
      },
      ingestion: {
        acceptedEvents: 213,
        replayedEvents: 127,
        rejectedEvents: 0,
        conflictingEvents: 0,
        admissionRequests: 289,
        admissionRejected: 0,
        inFlight: 0,
      },
      pools: [
        {
          name: 'ingest',
          active: 0,
          idle: 1,
          waiting: 0,
          rejectedSinceRestart: 0,
          statementTimeoutsSinceRestart: 0,
        },
        {
          name: 'read',
          active: 0,
          idle: 1,
          waiting: 0,
          rejectedSinceRestart: 0,
          statementTimeoutsSinceRestart: 0,
        },
      ],
      errors: [
        {
          reason: 'prompt_history_disabled',
          message: 'Approval prompt capture was skipped because the feature is disabled.',
          severity: 'info',
          countSinceRestart: 14,
          lastOccurredAt: '2026-07-13T11:30:00.000Z',
          relatedSetting: 'TRACING_APPROVAL_PROMPT_HISTORY_ENABLED',
          effectiveValue: null,
          operatorAction: 'No action is required unless prompt history is expected.',
        },
      ],
    }
    mockApiGet.mockResolvedValue(snapshot)

    await expect(getTracingOperationsSnapshot()).resolves.toEqual(snapshot)
  })

  it('rejects a partial response instead of treating missing data as healthy zeroes', async () => {
    mockApiGet.mockResolvedValue({
      scope: 'control-api-instance',
      health: 'healthy',
      generatedAt: '2026-07-13T12:00:00.000Z',
      instanceStartedAt: '2026-07-13T11:00:00.000Z',
      limits: {},
      ingestion: {},
      pools: [],
      errors: [],
    })

    await expect(getTracingOperationsSnapshot()).rejects.toThrow(
      'invalid tracing operations snapshot'
    )
  })

  it('forwards the caller abort signal to the existing authenticated API helper', async () => {
    const controller = new AbortController()
    mockApiGet.mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    await expect(getTracingOperationsSnapshot(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mockApiGet).toHaveBeenCalledWith(
      '/api/v1/admin/tracing/operations',
      {},
      { signal: controller.signal }
    )
  })
})
