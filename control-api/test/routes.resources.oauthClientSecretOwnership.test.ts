import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { MockGateway } from './mockGateway.js'

// The uninstall tears OAuth state down before deleting the CR and answers 503 when
// that fails, so it needs a DB that answers (empty: nothing to tear down).
vi.mock('../src/db.js', async importActual => {
  const actual = await importActual<typeof import('../src/db.js')>()
  return { ...actual, pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }
})

const { config } = await import('../src/config.js')
const { createAdminResourcesRouter } = await import('../src/routes/admin/resources.js')

// R3-H6: the McpServer uninstall path (`DELETE /admin/mcp-servers/:name`) cleans up
// the derived-name `${name}-oauth-client` Secret. That name is not exclusive to
// control-api — OAuth reference mode lets an operator point clientIdRef at any
// same-named Secret it owns. UID/RV fencing proves same-object, not same-owner, so
// the cascade delete must confirm the `clerum.io/managed-by: control-api` label
// (stamped by the install saga) before razing the Secret.
describe('DELETE /admin/mcp-servers/:name — oauth-client Secret ownership guard (R3-H6)', () => {
  const OAUTH_SECRET = 'my-gmail-oauth-client'

  let prevMcpServersNs: string
  let prevContextsNs: string

  // The Secret cleanup only runs for a live CR: a missing one answers 404 and touches
  // nothing, so every case installs the server first.
  async function gatewayWithServer(): Promise<MockGateway> {
    const gw = new MockGateway('mcpservers-ns')
    await gw.createResource(
      'mcpservers',
      { metadata: { name: 'my-gmail' }, spec: {} },
      'mcpservers-ns'
    )
    return gw
  }

  function makeApp(gateway: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    return app
  }

  beforeEach(() => {
    prevMcpServersNs = config.mcpServersNamespace
    prevContextsNs = config.contextsNamespace
    config.mcpServersNamespace = 'mcpservers-ns'
    config.contextsNamespace = 'contexts-ns'
  })

  afterEach(() => {
    config.mcpServersNamespace = prevMcpServersNs
    config.contextsNamespace = prevContextsNs
    vi.restoreAllMocks()
  })

  it('does NOT delete a foreign, unlabeled oauth-client Secret (operator-owned collision)', async () => {
    const gw = await gatewayWithServer()
    // Fixture from the real producer (MockGateway.getSecret): an operator Secret
    // that happens to carry the derived name and NO managed-by label.
    gw.seedSecret(OAUTH_SECRET, 'mcpservers-ns', {
      stringData: { client_id: 'id', client_secret: 'sec' },
    })
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')

    await request(makeApp(gw)).delete('/admin/mcp-servers/my-gmail').expect(200)

    // Observable outcome: the foreign Secret survives and no delete was addressed to it.
    await expect(gw.getSecret(OAUTH_SECRET, 'mcpservers-ns')).resolves.toBeTruthy()
    expect(deleteSecretSpy).not.toHaveBeenCalledWith(
      OAUTH_SECRET,
      'mcpservers-ns',
      expect.anything()
    )
  })

  it('does NOT delete an oauth-client Secret managed by another controller', async () => {
    const gw = await gatewayWithServer()
    gw.seedSecret(OAUTH_SECRET, 'mcpservers-ns', {
      labels: { 'clerum.io/managed-by': 'Helm' },
      stringData: { client_id: 'id', client_secret: 'sec' },
    })
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')

    await request(makeApp(gw)).delete('/admin/mcp-servers/my-gmail').expect(200)

    await expect(gw.getSecret(OAUTH_SECRET, 'mcpservers-ns')).resolves.toBeTruthy()
    expect(deleteSecretSpy).not.toHaveBeenCalledWith(
      OAUTH_SECRET,
      'mcpservers-ns',
      expect.anything()
    )
  })

  it('DOES delete a control-api-managed oauth-client Secret', async () => {
    const gw = await gatewayWithServer()
    gw.seedSecret(OAUTH_SECRET, 'mcpservers-ns', {
      labels: { 'clerum.io/managed-by': 'control-api' },
      stringData: { client_id: 'id', client_secret: 'sec' },
    })
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')

    await request(makeApp(gw)).delete('/admin/mcp-servers/my-gmail').expect(200)

    // Observable outcome: the managed Secret is gone.
    await expect(gw.getSecret(OAUTH_SECRET, 'mcpservers-ns')).rejects.toThrow()
    expect(deleteSecretSpy).toHaveBeenCalledWith(OAUTH_SECRET, 'mcpservers-ns', expect.anything())
  })
})
