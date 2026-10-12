import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/**
 * R2-L2 (T3/T4): a failed uninstall teardown step increments
 * mcp_server_uninstall_teardown_failures_total{stage}. The teardown now runs BEFORE
 * the CR delete, so the failure also stops the uninstall: 503 repair_required with
 * the CR still present (a 200 here used to mean "CR gone, grants orphaned for good").
 *
 * Seam: the same pool.query swap as mcpServerUninstallPurgesGrants.test.ts, but the
 * oauth_grants DELETE throws so the H-3 catch runs. The counter is read from the
 * shared registry BY NAME (never imported as a symbol), so against a parent without
 * the metric the lookup returns 0 and the delta assertion fails — the T3 red —
 * rather than a compile error.
 */

const dbMock = vi.hoisted(() => {
  const query = vi.fn(async (text: string) => {
    if (/DELETE\s+FROM\s+oauth_grants/i.test(text)) {
      throw new Error('simulated oauth_grants purge failure')
    }
    return { rows: [], rowCount: 0 }
  })
  return { query }
})

vi.mock('../../../db.js', async importActual => {
  const actual = await importActual<typeof import('../../../db.js')>()
  return { ...actual, pool: { query: dbMock.query } }
})

// Import AFTER vi.mock so the swapped `pool` wires into the router.
const { createAdminResourcesRouter } = await import('../resources.js')
const { registry } = await import('../../../observability/metrics.js')
const { config } = await import('../../../config.js')
const { MockGateway } = await import('../../../../test/mockGateway.js')

async function teardownFailures(stage: string): Promise<number> {
  const all = await registry.getMetricsAsJSON()
  const metric = all.find(m => m.name === 'mcp_server_uninstall_teardown_failures_total')
  if (!metric) return 0
  return (metric.values as Array<{ labels: Record<string, string>; value: number }>)
    .filter(v => v.labels.stage === stage)
    .reduce((sum, v) => sum + v.value, 0)
}

describe('DELETE /admin/mcp-servers/:name — teardown failure increments the counter (R2-L2)', () => {
  const SERVER_NAME = 'gdrive'

  async function buildApp() {
    const NS = config.mcpServersNamespace
    const gateway = new MockGateway(NS)
    await gateway.createResource('mcpservers', { metadata: { name: SERVER_NAME }, spec: {} }, NS)
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1', createAdminResourcesRouter(gateway as never))
    return { app, gateway, NS }
  }

  beforeEach(() => {
    dbMock.query.mockClear()
  })

  it('counts a failed oauth_grants purge under stage=oauth_grants and keeps the CR for a retry', async () => {
    const before = await teardownFailures('oauth_grants')
    const { app, gateway, NS } = await buildApp()

    const res = await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({
      error: 'mcp_server_uninstall_incomplete',
      outcome: 'repair_required',
      pending: ['oauth_grants'],
    })
    await expect(gateway.getResource('mcpservers', SERVER_NAME, NS)).resolves.toBeTruthy()
    const after = await teardownFailures('oauth_grants')
    expect(after - before).toBeGreaterThanOrEqual(1)
  })
})
