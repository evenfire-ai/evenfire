import { describe, expect, it, vi } from 'vitest'
import {
  GovernedSessionReplayInvalidQueryError,
  GovernedSessionReplayService,
} from '../src/services/tracing/governedSessionReplayService.js'
import type { SessionReplayFilters } from '../src/services/tracing/postgresGovernedSessionReplayRepository.js'

const FILTERS: SessionReplayFilters = {
  occurredFrom: '2026-07-01T00:00:00.000Z',
  occurredTo: '2026-07-02T00:00:00.000Z',
  outcome: [],
  sourceService: [],
  sessionId: [],
  hostRef: [],
  humanUserId: [],
  agentSub: [],
  origin: [],
  toolName: [],
  approvalState: [],
}

function summary(sessionId: string, occurredAt: string) {
  return {
    hostRef: 'host-a',
    sessionId,
    origins: ['direct_chat'] as const,
    firstOccurredAt: occurredAt,
    lastOccurredAt: occurredAt,
    runCount: 1,
    eventCount: 1,
    latestRunOutcome: 'succeeded' as const,
    agent: { status: 'verified' as const, subject: 'mcp-host:host-a', displayName: 'host-a' },
    human: {
      status: 'verified' as const,
      subject: 'human-1',
      userId: null,
      displayName: null,
      identityIssuer: 'issuer-1',
    },
    tools: { totalCalls: 0, distinctTools: 0 },
    approvals: { requested: 0, approved: 0, denied: 0, promptHistory: 'disabled' as const },
  }
}

describe('GovernedSessionReplayService', () => {
  it('holds one high watermark across pages and rejects a cursor after filters change', async () => {
    const captureHighWatermark = vi.fn().mockResolvedValue('42')
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        summaries: [
          summary('session-2', '2026-07-01T02:00:00.000Z'),
          summary('session-1', '2026-07-01T01:00:00.000Z'),
        ],
        anchors: [
          { occurredAt: '2026-07-01T02:00:00.000Z', hostRef: 'host-a', sessionId: 'session-2' },
          { occurredAt: '2026-07-01T01:00:00.000Z', hostRef: 'host-a', sessionId: 'session-1' },
        ],
      })
      .mockResolvedValueOnce({ summaries: [], anchors: [] })
    const service = new GovernedSessionReplayService({ captureHighWatermark, list } as never)

    const first = await service.list({ filters: FILTERS, limit: 1 })
    expect(first).toMatchObject({
      capturedHighWatermark: '42',
      sessions: [{ sessionId: 'session-2' }],
    })
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await service.list({ filters: FILTERS, limit: 1, cursor: first.nextCursor! })
    expect(second.capturedHighWatermark).toBe('42')
    expect(captureHighWatermark).toHaveBeenCalledOnce()
    expect(list.mock.calls[1][0]).toMatchObject({
      highWatermark: '42',
      after: { occurredAt: '2026-07-01T02:00:00.000Z', hostRef: 'host-a', sessionId: 'session-2' },
      order: 'latest',
    })

    await expect(
      service.list({ filters: FILTERS, limit: 1, order: 'oldest', cursor: first.nextCursor! })
    ).rejects.toBeInstanceOf(GovernedSessionReplayInvalidQueryError)

    await expect(
      service.list({
        filters: { ...FILTERS, hostRef: ['different-host'] },
        limit: 1,
        cursor: first.nextCursor!,
      })
    ).rejects.toBeInstanceOf(GovernedSessionReplayInvalidQueryError)
  })
})
