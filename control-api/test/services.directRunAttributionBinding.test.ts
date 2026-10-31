import { describe, expect, it, vi } from 'vitest'
import {
  DirectRunAttributionBindingService,
  DirectRunBindingConflictError,
} from '../src/services/tracing/directRunAttributionBindingService.js'

const input = {
  runId: '11111111-1111-4111-8111-111111111111',
  hostRef: 'host-a',
  hostNamespace: 'mcp-host',
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

  it('writes the verified Host namespace as the third INSERT value', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ created_at: new Date() }], rowCount: 1 })
    const service = new DirectRunAttributionBindingService(work => work({ query } as never))

    await service.bind(input)

    const [sql, values] = query.mock.calls[1] as [string, unknown[]]
    expect(sql).toContain('host_namespace')
    // $3 is host_namespace: the column list and the value list stay aligned.
    expect(sql).toContain('(run_id, host_ref, host_namespace, session_id')
    expect(values[1]).toBe(input.hostRef)
    expect(values[2]).toBe(input.hostNamespace)
  })

  it('keeps the binding digest independent of host_namespace so a rolling-deploy retry re-binds', async () => {
    // rpc-proxy reuses a run id on a client retry. A first bind by an old pod
    // (no namespace) and the retry on a new pod (namespace set) must produce the
    // same digest, or the retry would be rejected as a conflict and fail the
    // user's message.
    const digestOf = async (hostNamespace: string | null): Promise<string> => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ created_at: new Date() }], rowCount: 1 })
      const service = new DirectRunAttributionBindingService(work => work({ query } as never))
      await service.bind({ ...input, hostNamespace })
      return String((query.mock.calls[1] as [string, unknown[]])[1][9])
    }

    const withoutNamespace = await digestOf(null)
    const withNamespace = await digestOf('mcp-host')
    expect(withNamespace).toBe(withoutNamespace)
    expect(withNamespace).toMatch(/^[0-9a-f]{64}$/)
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
