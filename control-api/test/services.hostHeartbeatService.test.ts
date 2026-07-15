import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import {
  listHostHeartbeatsSince,
  upsertHostHeartbeat,
} from '../src/services/hostHeartbeatService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const queryMock = vi.mocked(pool.query)

const HEARTBEAT = {
  hostRef: 'chatllm',
  podUid: 'pod-uid-123',
  activeWork: true,
  conditions: { activeTask: true, awaitingApproval: false, pendingResults: false },
  lastActivityTs: 1_700_000_000_000,
  state: 'active' as const,
}

describe('hostHeartbeatService', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  describe('upsertHostHeartbeat', () => {
    it('upserts one row keyed by host_ref with the full snapshot', async () => {
      queryMock.mockResolvedValue({ rows: [], rowCount: 1 } as never)

      await upsertHostHeartbeat(HEARTBEAT)

      expect(queryMock).toHaveBeenCalledTimes(1)
      const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]]
      expect(sql).toContain('INSERT INTO host_heartbeats')
      expect(sql).toContain('ON CONFLICT (host_ref) DO UPDATE')
      expect(params).toEqual([
        'chatllm',
        'pod-uid-123',
        true,
        JSON.stringify(HEARTBEAT.conditions),
        1_700_000_000_000,
        'active',
      ])
    })

    it('fails loud when the upsert affects no row', async () => {
      queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never)

      await expect(upsertHostHeartbeat(HEARTBEAT)).rejects.toThrow(
        /upsert affected 0 rows for host chatllm/
      )
    })
  })

  describe('listHostHeartbeatsSince', () => {
    it('filters by received_at > since and maps rows (bigints arrive as strings)', async () => {
      queryMock.mockResolvedValue({
        rows: [
          {
            host_ref: 'chatllm',
            pod_uid: 'pod-uid-123',
            active_work: false,
            conditions: { activeTask: false, awaitingApproval: false, pendingResults: true },
            last_activity_ts: '1700000000000',
            state: 'draining',
            received_at_ms: '1700000030000',
          },
        ],
        rowCount: 1,
      } as never)

      const rows = await listHostHeartbeatsSince(1_699_999_999_999)

      const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]]
      expect(sql).toContain('WHERE received_at > to_timestamp($1::double precision / 1000.0)')
      expect(sql).toContain('ORDER BY received_at ASC')
      expect(params).toEqual([1_699_999_999_999])
      expect(rows).toEqual([
        {
          hostRef: 'chatllm',
          podUid: 'pod-uid-123',
          activeWork: false,
          conditions: { activeTask: false, awaitingApproval: false, pendingResults: true },
          lastActivityTs: 1_700_000_000_000,
          state: 'draining',
          receivedAtMs: 1_700_000_030_000,
        },
      ])
    })

    it('fails loud on a non-integer or negative since', async () => {
      await expect(listHostHeartbeatsSince(-1)).rejects.toThrow(/non-negative safe integer/)
      await expect(listHostHeartbeatsSince(12.5)).rejects.toThrow(/non-negative safe integer/)
      expect(queryMock).not.toHaveBeenCalled()
    })
  })
})
