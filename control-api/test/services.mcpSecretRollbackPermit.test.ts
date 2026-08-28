import { describe, expect, it, vi } from 'vitest'
import {
  MCP_SECRET_ROLLBACK_CLAIM_TTL_SECONDS,
  MCP_SECRET_ROLLBACK_PERMIT_TTL_SECONDS,
  claimMcpSecretRollbackPermit,
  finalizeMcpSecretRollbackPermitClaim,
  issueMcpSecretRollbackPermit,
  releaseMcpSecretRollbackPermitClaim,
} from '../src/services/mcpSecretRollbackPermitService.js'

const permit = {
  sessionJti: 'admin-session-jti-raw',
  name: 'linear-credentials',
  namespace: 'mcp-server',
  uid: 'uid-linear',
  resourceVersion: '7',
}

describe('mcpSecretRollbackPermitService', () => {
  it('rejects incomplete permits before querying PostgreSQL', async () => {
    const query = vi.fn()

    await expect(
      issueMcpSecretRollbackPermit({ ...permit, sessionJti: '' }, { query } as never)
    ).rejects.toThrow('invalid_mcp_secret_rollback_permit')
    expect(query).not.toHaveBeenCalled()
  })

  it('stores only a hash of the admin session and a bounded resource identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await issueMcpSecretRollbackPermit(permit, { query } as never)

    const insert = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO mcp_secret_rollback_permits')
    )
    expect(insert).toBeDefined()
    expect(insert?.[1]).toEqual([
      expect.any(Buffer),
      'mcp-server',
      'linear-credentials',
      'uid-linear',
      '7',
      MCP_SECRET_ROLLBACK_PERMIT_TTL_SECONDS,
    ])
    expect((insert?.[1] as unknown[])[0]).toHaveLength(32)
    const cleanupSql = String(query.mock.calls[0]?.[0])
    expect(cleanupSql).toContain('LIMIT 100')
    expect(String(insert?.[0])).toContain('claim_token = NULL')
    expect(String(insert?.[0])).toContain('claim_expires_at = NULL')
    expect(JSON.stringify(query.mock.calls)).not.toContain(permit.sessionJti)
  })

  it('atomically claims an unexpired permit for the same session and resource name', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          uid: 'uid-linear',
          resourceVersion: '7',
          claimToken: '11111111-1111-4111-8111-111111111111',
        },
      ],
      rowCount: 1,
    })

    const result = await claimMcpSecretRollbackPermit(
      {
        sessionJti: permit.sessionJti,
        name: permit.name,
        namespace: permit.namespace,
      },
      { query } as never
    )

    expect(result).toEqual({
      uid: 'uid-linear',
      resourceVersion: '7',
      claimToken: '11111111-1111-4111-8111-111111111111',
    })
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('UPDATE mcp_secret_rollback_permits')
    expect(sql).toContain('expires_at > statement_timestamp()')
    expect(sql).toContain('claim_expires_at <= statement_timestamp()')
    expect(sql).toContain('RETURNING uid')
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(Buffer),
      'mcp-server',
      'linear-credentials',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      MCP_SECRET_ROLLBACK_CLAIM_TTL_SECONDS,
    ])
    expect(query).toHaveBeenCalledOnce()
    expect(JSON.stringify(query.mock.calls)).not.toContain(permit.sessionJti)
  })

  it('returns null when no active permit exists', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await expect(
      claimMcpSecretRollbackPermit(
        {
          sessionJti: permit.sessionJti,
          name: permit.name,
          namespace: permit.namespace,
        },
        { query } as never
      )
    ).resolves.toBeNull()
  })

  it('releases only the matching claim so a transient failure can retry', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await releaseMcpSecretRollbackPermitClaim(
      {
        sessionJti: permit.sessionJti,
        namespace: permit.namespace,
        name: permit.name,
        claimToken: '11111111-1111-4111-8111-111111111111',
      },
      { query } as never
    )
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('SET claim_token = NULL')
    expect(sql).toContain('claim_token = $4')
  })

  it('finalizes only the matching claim after a terminal result', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await finalizeMcpSecretRollbackPermitClaim(
      {
        sessionJti: permit.sessionJti,
        namespace: permit.namespace,
        name: permit.name,
        claimToken: '11111111-1111-4111-8111-111111111111',
      },
      { query } as never
    )
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('DELETE FROM mcp_secret_rollback_permits')
    expect(sql).toContain('claim_token = $4')
  })
})
