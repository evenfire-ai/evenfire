import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/**
 * R2-L2 (T3/T4): a best-effort uninstall teardown step that fails AFTER the CR is
 * deleted increments mcp_server_uninstall_teardown_failures_total{stage} — the
 * signal that makes orphaned Secret / dynamic-client / grants state reconcilable
 * and alertable. The uninstall still returns 200: teardown never blocks the delete.
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

  function buildApp() {
    const gateway = {
      deleteResource: vi.fn(async () => ({ metadata: { name: SERVER_NAME } })),
      deleteSecret: vi.fn(async () => ({})),
      getSecret: vi.fn(async () => ({})),
      listResource: vi.fn(async () => []),
      updateResource: vi.fn(async () => ({})),
    }
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1', createAdminResourcesRouter(gateway as never))
    return { app }
  }

  beforeEach(() => {
    dbMock.query.mockClear()
  })

  it('counts a failed oauth_grants purge under stage=oauth_grants and still returns 200', async () => {
    const before = await teardownFailures('oauth_grants')
    const { app } = buildApp()

    const res = await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)

    // Teardown is best-effort — a purge failure must never block the uninstall.
    expect(res.status).toBe(200)
    // The failed stage is now an observable metric, not just a log line.
    const after = await teardownFailures('oauth_grants')
    expect(after - before).toBeGreaterThanOrEqual(1)
  })
})
