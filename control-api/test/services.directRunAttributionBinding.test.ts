import { describe, expect, it, vi } from 'vitest'
import {
  DirectRunAttributionBindingService,
  DirectRunBindingConflictError,
} from '../src/services/tracing/directRunAttributionBindingService.js'

const input = {
  runId: '11111111-1111-4111-8111-111111111111',
  hostRef: 'host-a',
  sessionId: 'session-a',
  origin: 'direct_chat' as const,
  identityIssuer: 'control-api',
  actorHumanSub: '22222222-2222-4222-8222-222222222222',
  userId: '22222222-2222-4222-8222-222222222222',
  teamId: null,
}

describe('DirectRunAttributionBindingService', () => {
  it('creates once and returns an idempotent replay for the exact binding', async () => {
    const createdAt = '2026-07-14T10:00:00.000Z'
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ created_at: createdAt }], rowCount: 1 })
    const service = new DirectRunAttributionBindingService(work => work({ query } as never))
    await expect(service.bind(input)).resolves.toEqual({
      runId: input.runId,
      status: 'created',
      createdAt,
    })
    expect(String(query.mock.calls[1]![0])).toContain('ON CONFLICT (run_id) DO NOTHING')
  })

  it('rejects a different immutable binding for the same run', async () => {
    const recordOperationalError = vi.fn()
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ binding_sha256: '0'.repeat(64), created_at: new Date() }],
        rowCount: 1,
      })
    const service = new DirectRunAttributionBindingService(
      work => work({ query } as never),
      recordOperationalError
    )
    await expect(service.bind(input)).rejects.toBeInstanceOf(DirectRunBindingConflictError)
    expect(recordOperationalError).toHaveBeenCalledWith('agent_run', 'attribution_binding_conflict')
    expect(recordOperationalError.mock.calls.flat()).not.toContain(input.runId)
  })

  it('records a closed unavailable reason when persistence fails without identity labels', async () => {
    const recordOperationalError = vi.fn()
    const service = new DirectRunAttributionBindingService(async () => {
      throw new Error('database unavailable')
    }, recordOperationalError)

    await expect(service.bind(input)).rejects.toThrow('database unavailable')
    expect(recordOperationalError).toHaveBeenCalledWith(
      'agent_run',
      'attribution_binding_unavailable'
    )
    expect(JSON.stringify(recordOperationalError.mock.calls)).not.toMatch(
      /host-a|session-a|11111111|22222222/
    )
  })
})
