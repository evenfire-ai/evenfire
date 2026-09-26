import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/**
 * H-3 route regression (T3/T4): the generic McpServer uninstall
 * (DELETE /admin/mcp-servers/:name) must purge the server's oauth_grants rows
 * as an observable uninstall side-effect. Before H-3 the handler cleaned the
 * Secret, the DCR row, and the Context allowlists but never touched
 * oauth_grants, orphaning them.
 *
 * Seam chosen: a test-only `vi.mock('../../../db.js', ...)` that keeps every
 * real export via `importActual` and swaps ONLY the module-global `pool` for a
 * recording fake whose `query` returns benign empty results. No production
 * change — `createAdminResourcesRouter` reads the DB through `pool.query`
 * (resources.ts: `dcrDb = { query: (t,v) => pool.query(t,v) }`). We observe the
 * uninstall via the recorded queries.
 *
 * T4: the assertion is on the observable uninstall behavior (a scoped
 * grants-purge DELETE was executed), derived from the real handler — not on a
 * hand-built fixture of another layer. The store's exact SQL contract is pinned
 * separately in oauth/__tests__/deleteOAuthGrantsForServer.test.ts.
 *
 * T3: this test FAILS against parent a5b354ce9 — there the uninstall issues no
 * oauth_grants DELETE, so `purge` is undefined and the assertion fails. The file
 * does not import deleteOAuthGrantsForServer, so it compiles+runs at parent.
 */

const dbMock = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = []
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values: values ?? [] })
    return { rows: [], rowCount: 0 }
  })
  return { calls, query }
})

vi.mock('../../../db.js', async importActual => {
  const actual = await importActual<typeof import('../../../db.js')>()
  return { ...actual, pool: { query: dbMock.query } }
})

// Import AFTER vi.mock so the swapped `pool` wires into the router.
const { createAdminResourcesRouter } = await import('../resources.js')
const { config } = await import('../../../config.js')

describe('DELETE /admin/mcp-servers/:name — purges oauth_grants on uninstall (H-3)', () => {
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
    return { app, gateway }
  }

  beforeEach(() => {
    dbMock.calls.length = 0
    dbMock.query.mockClear()
  })

  it('executes a server-scoped DELETE FROM oauth_grants during uninstall', async () => {
    const { app } = buildApp()

    const res = await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)
    expect(res.status).toBe(200)

    const purge = dbMock.calls.find(
      c =>
        /DELETE\s+FROM\s+oauth_grants/i.test(c.text) && c.text.includes("owner_kind = 'mcpserver'")
    )
    // Before H-3 no such query is issued — this is the regression anchor.
    expect(purge).toBeDefined()
    expect(purge!.values).toEqual([config.mcpServersNamespace, SERVER_NAME])
  })
})
