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

describe('DELETE /admin/mcp-servers/:name — purges oauth_grants on uninstall (H-3, R3-H5)', () => {
  const SERVER_NAME = 'gdrive'
  const CR_UID = 'uid-gdrive-live'

  function buildApp() {
    const gateway = {
      // The uninstall reads the CR before deleting to capture metadata.uid (R3-H5).
      getResource: vi.fn(async () => ({
        metadata: { name: SERVER_NAME, uid: CR_UID, resourceVersion: '7' },
      })),
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

  it('executes a cr_uid-fenced server-scoped DELETE FROM oauth_grants during uninstall', async () => {
    const { app } = buildApp()

    const res = await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)
    expect(res.status).toBe(200)

    const purge = dbMock.calls.find(
      c =>
        /DELETE\s+FROM\s+oauth_grants/i.test(c.text) && c.text.includes("owner_kind = 'mcpserver'")
    )
    // Before H-3 no such query is issued; before R3-H5 it carried no cr_uid fence.
    expect(purge).toBeDefined()
    expect(purge!.text).toContain('cr_uid = $3 OR cr_uid IS NULL')
    expect(purge!.values).toEqual([config.mcpServersNamespace, SERVER_NAME, CR_UID])
  })

  it('deletes the CR fenced on the uid read before delete', async () => {
    const { app, gateway } = buildApp()

    await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)

    expect(gateway.getResource).toHaveBeenCalledWith(
      'mcpservers',
      SERVER_NAME,
      config.mcpServersNamespace
    )
    // deleteResource receives the uid precondition captured from the read CR.
    const deleteArgs = gateway.deleteResource.mock.calls[0]
    expect(deleteArgs[3]).toEqual({ uid: CR_UID })
  })
})
