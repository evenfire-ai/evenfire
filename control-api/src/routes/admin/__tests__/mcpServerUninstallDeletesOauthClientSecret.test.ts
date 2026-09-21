import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/**
 * H-2 route regression (T3/T4): the generic McpServer uninstall
 * (DELETE /admin/mcp-servers/:name) must best-effort delete the pre-registered
 * confidential remote install's `${name}-oauth-client` Secret as an observable
 * uninstall side-effect. That Secret is created with no ownerReferences (install
 * saga step 1, before the CR exists), so K8s GC never reclaims it; before H-2
 * the uninstall deleted `${name}-credentials` but left `${name}-oauth-client`
 * orphaned — breaking install→uninstall→reinstall (createSecret 409) and
 * leaking the client_secret.
 *
 * Harness mirrors mcpServerUninstallPurgesGrants.test.ts (H-3): mount
 * `createAdminResourcesRouter` with a fake K8sGateway + supertest, issue an
 * mcpservers uninstall DELETE, and assert the OBSERVABLE — the fake gateway
 * records `deleteSecret` calls, and we assert one is for `${name}-oauth-client`
 * in the server namespace (T4).
 *
 * The DB `pool` is swapped for a recording fake (like H-3) so the router's
 * DCR/grants teardown runs against benign empty results and the 200 path
 * completes without a real Postgres.
 *
 * T3: this test FAILS against parent 2680eade5 — there the uninstall deletes
 * only `${name}-credentials`, so `deleteSecret` is never called with
 * `${name}-oauth-client` and the assertion fails.
 */

const dbMock = vi.hoisted(() => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  return { query }
})

vi.mock('../../../db.js', async importActual => {
  const actual = await importActual<typeof import('../../../db.js')>()
  return { ...actual, pool: { query: dbMock.query } }
})

// Import AFTER vi.mock so the swapped `pool` wires into the router.
const { createAdminResourcesRouter } = await import('../resources.js')
const { config } = await import('../../../config.js')

describe('DELETE /admin/mcp-servers/:name — deletes the oauth-client Secret on uninstall (H-2)', () => {
  const SERVER_NAME = 'notion'

  function buildApp() {
    const deleteSecretCalls: Array<{ name: string; namespace: string }> = []
    const gateway = {
      deleteResource: vi.fn(async () => ({ metadata: { name: SERVER_NAME } })),
      deleteSecret: vi.fn(async (name: string, namespace: string) => {
        deleteSecretCalls.push({ name, namespace })
        return {}
      }),
      getSecret: vi.fn(async () => ({})),
      listResource: vi.fn(async () => []),
      updateResource: vi.fn(async () => ({})),
    }
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use('/api/v1', createAdminResourcesRouter(gateway as never))
    return { app, gateway, deleteSecretCalls }
  }

  beforeEach(() => {
    dbMock.query.mockClear()
  })

  it('best-effort deletes `${name}-oauth-client` in the server namespace during uninstall', async () => {
    const { app, deleteSecretCalls } = buildApp()

    const res = await request(app).delete(`/api/v1/admin/mcp-servers/${SERVER_NAME}`)
    expect(res.status).toBe(200)

    // Before H-2 the uninstall only deletes `${name}-credentials`; this is the
    // regression anchor.
    const oauthClientDelete = deleteSecretCalls.find(c => c.name === `${SERVER_NAME}-oauth-client`)
    expect(oauthClientDelete).toBeDefined()
    expect(oauthClientDelete!.namespace).toBe(config.mcpServersNamespace)
  })
})
